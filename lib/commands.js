'use strict';

const { number, boolean, firmware, isOpener, isWindow, supportsOrientation } = require('./model');

const SCENARIOS = Object.freeze(['bedtime', 'wake_up', 'away', 'home', 'start_airing', 'stop_airing']);
const SIGNED_SCENARIOS = new Set(['home', 'start_airing']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function text(value, label, max = 128) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail('INVALID_VALUE', `${label} must be a nonempty string of at most ${max} characters`);
    return value.trim();
}

function jsonObject(value, label = 'Definition') {
    if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > 262144) fail('INVALID_VALUE', `${label} is too large`);
        try { value = JSON.parse(value); } catch { fail('INVALID_VALUE', `${label} must be valid JSON`); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_VALUE', `${label} must be an object`);
    return value;
}

class CommandBuilder {
    constructor({ model, signer, getSigningKey = () => null, getGatewayConfig = () => ({}), allowIndividualStop = false, forceCommands = false, now = Date.now }) {
        Object.assign(this, { model, signer, getSigningKey, getGatewayConfig, allowIndividualStop, forceCommands, now });
    }

    _sign(homeId, gateway, moduleId, property, value) {
        const signingKey = this.getSigningKey(homeId, gateway.id);
        if (!signingKey) fail('PAIRING_REQUIRED', 'Pair this gateway before issuing protected commands');
        let scheme = this.getGatewayConfig(gateway.id)?.signingScheme || 'auto';
        if (scheme === 'auto') {
            const revision = firmware(gateway);
            if (revision !== null && revision >= 60) scheme = 'hmac';
            else if (revision !== null && revision >= 27) scheme = 'sha512';
            else fail('UNKNOWN_SIGNING_SCHEME', 'Gateway firmware does not identify a supported signing scheme; configure a verified scheme');
        }
        if (!['hmac', 'sha512'].includes(scheme)) fail('INVALID_VALUE', 'Unknown signing scheme');
        return this.signer.sign({ property, value, moduleId, signingKey, scheme });
    }

    device(homeId, moduleId, action, value) {
        const module = this.model.module(homeId, moduleId);
        if (!isOpener(module)) fail('NOT_AN_OPENER', 'This device is not a window, blind or shutter');
        const gateway = this.model.gateway(homeId, module);
        const target = { id: module.id, bridge: gateway.id };
        const expected = [];
        if (['position', 'open', 'close', 'stop'].includes(action)) {
            const position = action === 'open' ? 100 : action === 'close' ? 0 : action === 'stop' ? -1 : number(value, 'Position', 0, 100, true);
            if (action === 'stop' && !this.allowIndividualStop) fail('INDIVIDUAL_STOP_DISABLED', 'Individual stop is experimental and is disabled in the adapter settings');
            target.target_position = position;
            target.force = this.forceCommands;
            if (isWindow(module) && position !== 0) Object.assign(target, this._sign(homeId, gateway, module.id, 'target_position', position));
            if (position >= 0) expected.push({ kind: 'module', id: module.id, field: 'current_position', value: position });
        } else if (action === 'silent') {
            if (typeof module.silent !== 'boolean') fail('UNSUPPORTED', 'This device does not report silent-operation support');
            target.silent = boolean(value, 'Silent operation');
            expected.push({ kind: 'module', id: module.id, field: 'silent', value });
        } else if (action === 'orientation') {
            if (!supportsOrientation(module, gateway)) fail('UNSUPPORTED', 'This device and gateway do not report supported lamella control');
            target.target_orientation = number(value, 'Lamella angle', -90, 90, true);
            expected.push({ kind: 'module', id: module.id, field: 'current_orientation', value });
        } else fail('UNKNOWN_COMMAND', `Unknown device command: ${action}`);
        return { payload: { home: { id: homeId, modules: [target] } }, expected };
    }

    gateway(homeId, gatewayId, action, value) {
        const gateway = this.model.module(homeId, gatewayId);
        if (gateway.type !== 'NXG') fail('NOT_A_GATEWAY', 'This command must target a gateway');
        const target = { id: gateway.id };
        if (action === 'stopAll') target.stop_movements = 'all';
        else if (action === 'scenario') {
            if (!SCENARIOS.includes(value)) fail('INVALID_VALUE', 'Unknown VELUX scenario');
            target.scenario = value;
            if (SIGNED_SCENARIOS.has(value)) Object.assign(target, this._sign(homeId, gateway, gateway.id, 'scenario', value));
        } else if (action === 'retrieveKey') target.retrieve_key = true;
        else if (action === 'pin') {
            if (typeof value !== 'string' || !value || value.length > 128) fail('INVALID_VALUE', 'PIN must be a nonempty string');
            target.pincode = value;
            Object.assign(target, this._sign(homeId, gateway, gateway.id, 'pincode', value));
        } else fail('UNKNOWN_COMMAND', `Unknown gateway command: ${action}`);
        return { payload: { home: { id: homeId, modules: [target] } }, expected: [], sensitive: action === 'pin' };
    }

    room(homeId, roomId, action, value) {
        this.model.room(homeId, roomId);
        const target = { id: roomId };
        const expected = [];
        if (action === 'automation') {
            target.mode = boolean(value, 'Room automation') ? 'algo_available' : 'manual';
            expected.push({ kind: 'room', id: roomId, field: 'mode', value: target.mode, alternatives: value ? ['algo_active'] : [] });
        } else if (['autoCloseMinutes', 'autoCloseAt', 'cancelAutoClose'].includes(action)) {
            const nowSeconds = Math.floor(this.now() / 1000);
            if (action === 'cancelAutoClose') target.auto_close_ts = 0;
            else if (action === 'autoCloseMinutes') {
                const minutes = number(value, 'Auto-close duration in minutes', 0, 1440, true);
                target.auto_close_ts = minutes === 0 ? 0 : nowSeconds + minutes * 60;
            } else {
                number(value, 'Auto-close Unix time', 0, Number.MAX_SAFE_INTEGER, true);
                if (value !== 0 && (value <= nowSeconds || value > nowSeconds + 86400)) fail('INVALID_VALUE', 'Auto-close time must be within the next 24 hours, or 0 to cancel');
                target.auto_close_ts = value;
            }
            expected.push({ kind: 'room', id: roomId, field: 'auto_close_ts', value: target.auto_close_ts });
        } else fail('UNKNOWN_COMMAND', `Unknown room command: ${action}`);
        return { payload: { home: { id: homeId, rooms: [target] } }, expected };
    }

    group(homeId, roomId, group, action, value, durationMinutes) {
        const modules = this.model.roomModules(homeId, roomId, group);
        if (!modules.length) fail('EMPTY_GROUP', 'No compatible products belong to this room group');
        const selected = action === 'orientation' ? modules.filter(module => supportsOrientation(module, this.model.gateway(homeId, module))) : modules;
        if (!selected.length) fail('EMPTY_GROUP', 'No products in this group support lamella control');
        const built = selected.map(module => this.device(homeId, module.id, action, value));
        const result = {
            payload: { home: { id: homeId, modules: built.flatMap(item => item.payload.home.modules) } },
            expected: built.flatMap(item => item.expected),
        };
        if (durationMinutes !== undefined) {
            if (!selected.every(isWindow)) fail('INVALID_VALUE', 'Timed opening is only available for a window group');
            const timer = this.room(homeId, roomId, 'autoCloseMinutes', durationMinutes);
            result.payload.home.rooms = timer.payload.home.rooms;
            result.expected.push(...timer.expected);
        }
        return result;
    }

    controlledOpeners(homeId, moduleId, value) {
        const module = this.model.module(homeId, moduleId);
        if (module.type !== 'NXS' || !['windows', 'external_covers'].includes(module.controlled_openers)) fail('UNSUPPORTED', 'This device does not report configurable controlled products');
        if (!['windows', 'external_covers'].includes(value)) fail('INVALID_VALUE', 'Controlled products must be windows or external_covers');
        const gateway = this.model.gateway(homeId, module);
        return { modules: [{ id: moduleId, bridge: gateway.id, controlled_openers: value }] };
    }

    schedule(homeId, action, input) {
        const home = this.model.home(homeId);
        const data = jsonObject(input, 'Schedule');
        const params = { home_id: homeId };
        if (!['create', 'update', 'rename', 'delete', 'switch'].includes(action)) fail('UNKNOWN_COMMAND', 'Unknown schedule operation');
        let existing;
        if (action !== 'create') {
            params.schedule_id = text(data.schedule_id, 'Schedule identifier', 512);
            existing = home.schedules.get(params.schedule_id);
            if (!existing) fail('UNKNOWN_SCHEDULE', 'Schedule does not belong to this home');
        }
        if (['create', 'update'].includes(action)) {
            const definition = { ...(existing || {}), ...data };
            // Keep native schedule details, including sunrise/sunset tables.
            // Routing, auth and read-only metadata never come from this JSON.
            const metadata = new Set(['id', 'type', 'home', 'home_id', 'homeId', 'schedule_id', 'selected', 'active',
                'access_token', 'refresh_token', 'app_type', 'platform', 'version', '__proto__', 'prototype', 'constructor']);
            for (const [field, value] of Object.entries(definition)) {
                if (!field.startsWith('_') && !metadata.has(field)) params[field] = value;
            }
            params.name = text(definition.name, 'Schedule name');
            params.schedule_type = definition.schedule_type || definition.type;
            if (!['event', 'algo'].includes(params.schedule_type)) fail('INVALID_VALUE', 'Only VELUX event and algo schedules are supported');
            if (!Array.isArray(definition.zones) || !Array.isArray(definition.timetable)) fail('INVALID_VALUE', 'Schedule zones and timetable must be arrays using the VELUX schedule schema');
            if (Buffer.byteLength(JSON.stringify(definition), 'utf8') > 262144) fail('INVALID_VALUE', 'Schedule definition is too large');
            params.zones = definition.zones;
            params.timetable = definition.timetable;
        } else if (action === 'rename') params.name = text(data.name, 'Schedule name');
        else if (action === 'switch') {
            const type = data.schedule_type || existing.schedule_type || existing.type;
            if (type && !['event', 'algo'].includes(type)) fail('INVALID_VALUE', 'Only VELUX event and algo schedules are supported');
            if (type) params.schedule_type = type;
        }
        return params;
    }
}

function matchesExpected(model, homeId, conditions, after = 0) {
    if (!conditions.length) return false;
    const home = model.home(homeId);
    return conditions.every(expected => {
        const item = (expected.kind === 'room' ? home.rooms : home.modules).get(expected.id);
        return item && (item._fieldObservedAt?.[expected.field] || 0) >= after && [expected.value, ...(expected.alternatives || [])].includes(item[expected.field]);
    });
}

module.exports = { CommandBuilder, SCENARIOS, jsonObject, matchesExpected };
