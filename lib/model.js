'use strict';

const { createHash } = require('node:crypto');

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const SECRET = /token|password|secret|pincode|hash_sign_key|sign_key_id/i;

function safeId(value) {
    if (typeof value !== 'string' || !value || value.length > 512) throw new Error('Missing or invalid VELUX identifier');
    return `id_${Buffer.from(value).toString('base64url')}`;
}

function groupId(value) {
    return ['covers', 'windows', 'window', 'blind', 'awning_blind', 'venetian_blind', 'roller_shutter', 'shutter'].includes(value) ? value : safeId(value);
}

function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(previous, patch) {
    const result = { ...previous };
    if (!plain(patch)) return result;
    for (const [key, value] of Object.entries(patch)) {
        if (FORBIDDEN.has(key) || value === undefined) continue;
        result[key] = plain(value) ? merge(plain(result[key]) ? result[key] : {}, value) : value;
    }
    return result;
}

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (!plain(value)) return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !key.startsWith('_') && !FORBIDDEN.has(key) && !SECRET.test(key) && !['persons', 'address', 'latitude', 'longitude'].includes(key))
        .map(([key, item]) => [key, redact(item)]));
}

function number(value, label, min, max, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        const error = new Error(`${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
        error.code = 'INVALID_VALUE';
        throw error;
    }
    return value;
}

function boolean(value, label) {
    if (typeof value !== 'boolean') throw Object.assign(new Error(`${label} must be true or false`), { code: 'INVALID_VALUE' });
    return value;
}

function asList(value) {
    return Array.isArray(value) ? value.filter(plain) : [];
}

function timestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
}

function unwrap(value) {
    return plain(value?.body) ? value.body : value;
}

function mergeTopology(previous, patch, requestedAt) {
    const accepted = {};
    const observed = { ...(previous._fieldObservedAt || {}) };
    for (const [field, value] of Object.entries(patch)) {
        if (field.startsWith('_') || FORBIDDEN.has(field) || value === undefined) continue;
        if ((previous._fieldUpdatedAt?.[field] || 0) > requestedAt) continue;
        accepted[field] = value;
        // Discovery describes the products. A changed discovery value must
        // not inherit the observation time of a different old status value.
        if (value !== previous[field]) delete observed[field];
    }
    const result = merge(previous, accepted);
    if (previous._fieldObservedAt) result._fieldObservedAt = observed;
    return result;
}

function firmware(gateway) {
    const revision = gateway?.firmware_revision_netatmo;
    return Number.isInteger(revision) ? revision : /^\d+$/.test(String(revision)) ? Number(revision) : null;
}

function isOpener(module) {
    return module?.type === 'NXO' || ['window', 'blind', 'awning_blind', 'venetian_blind', 'roller_shutter', 'shutter'].includes(module?.velux_type);
}

function isWindow(module) { return module?.velux_type === 'window'; }

function supportsOrientation(module, gateway) {
    return module?.velux_type === 'venetian_blind' && firmware(gateway) !== null && firmware(gateway) >= 55;
}

function sensors(raw) {
    const values = {};
    for (const [key, value] of Object.entries(raw || {})) {
        if (!Number.isFinite(value)) continue;
        if (['temperature', 'min_comfort_temperature', 'max_comfort_temperature'].includes(key)) values[key] = value / 10;
        else if (['humidity', 'co2', 'lux', 'air_quality', 'battery_percent', 'battery_level', 'rf_strength', 'wifi_strength',
            'min_comfort_humidity', 'max_comfort_humidity', 'max_comfort_co2'].includes(key)) values[key] = value;
    }
    return values;
}

class HomeModel {
    constructor() { this.homes = new Map(); }

    loadTopology(payload, { requestedAt = Infinity } = {}) {
        const data = unwrap(payload);
        if (!Array.isArray(data?.homes)) throw new Error('homesdata did not contain a homes array');
        const next = new Map();
        for (const raw of asList(data.homes)) {
            if (typeof raw.id !== 'string' || !raw.id) continue;
            const old = this.homes.get(raw.id);
            const home = {
                data: merge(old?.data || {}, raw),
                modules: new Map(), rooms: new Map(), schedules: new Map(), lastUpdate: old?.lastUpdate || 0,
            };
            for (const item of asList(raw.modules)) if (typeof item.id === 'string') {
                home.modules.set(item.id, mergeTopology(old?.modules.get(item.id) || {}, item, requestedAt));
            }
            for (const room of asList(raw.rooms)) if (typeof room.id === 'string') {
                home.rooms.set(room.id, mergeTopology(old?.rooms.get(room.id) || {}, room, requestedAt));
            }
            for (const schedule of asList(raw.schedules)) if (typeof schedule.id === 'string') {
                home.schedules.set(schedule.id, mergeTopology(old?.schedules.get(schedule.id) || {}, schedule, requestedAt));
            }
            next.set(raw.id, home);
        }
        this.homes = next;
        return [...next.keys()];
    }

    home(homeId) {
        const home = this.homes.get(homeId);
        if (!home) throw Object.assign(new Error(`Unknown home: ${homeId}`), { code: 'UNKNOWN_HOME' });
        return home;
    }

    module(homeId, moduleId) {
        const module = this.home(homeId).modules.get(moduleId);
        if (!module) throw Object.assign(new Error(`Unknown device: ${moduleId}`), { code: 'UNKNOWN_DEVICE' });
        return module;
    }

    room(homeId, roomId) {
        const room = this.home(homeId).rooms.get(roomId);
        if (!room) throw Object.assign(new Error(`Unknown room: ${roomId}`), { code: 'UNKNOWN_ROOM' });
        return room;
    }

    gateway(homeId, module) {
        const home = this.home(homeId);
        if (module.type === 'NXG') return module;
        if (module.bridge) {
            const linked = home.modules.get(module.bridge);
            if (linked?.type === 'NXG') return linked;
            throw Object.assign(new Error('The device gateway is not present in this home'), { code: 'GATEWAY_NOT_FOUND' });
        }
        const gateways = [...home.modules.values()].filter(item => item.type === 'NXG');
        if (gateways.length !== 1) throw Object.assign(new Error('Cannot determine an unambiguous gateway for this device'), { code: 'AMBIGUOUS_GATEWAY' });
        return gateways[0];
    }

    roomModules(homeId, roomId, group = 'covers') {
        const home = this.home(homeId);
        const room = this.room(homeId, roomId);
        const ids = new Set(Array.isArray(room.module_ids) ? room.module_ids : []);
        return [...home.modules.values()].filter(item => isOpener(item) && (item.room_id === roomId || ids.has(item.id)))
            .filter(item => group === 'all' || (group === 'covers' ? !isWindow(item) : group === 'windows' ? isWindow(item) : item.velux_type === group));
    }

    applyStatus(homeId, payload, receivedAt = Date.now(), { eventTimestamp = null, requestedAt = receivedAt } = {}) {
        const data = unwrap(payload);
        const patch = plain(data?.home) ? data.home : data;
        if (!plain(patch) || (patch.id && patch.id !== homeId)) throw new Error('homestatus home identifier mismatch');
        const home = this.home(homeId);
        home.data = merge(home.data, Object.fromEntries(Object.entries(patch).filter(([key]) => !['modules', 'rooms', 'schedules'].includes(key))));
        for (const [name, map] of [['modules', home.modules], ['rooms', home.rooms], ['schedules', home.schedules]]) {
            for (const item of asList(patch[name])) if (typeof item.id === 'string') {
                const previous = map.get(item.id) || {};
                const incomingTime = timestamp(item.last_seen) ?? timestamp(eventTimestamp);
                const previousTime = timestamp(previous._sourceTimestamp) ?? timestamp(previous.last_seen);
                if (incomingTime !== null && previousTime !== null && incomingTime < previousTime) continue;
                const fields = { ...(previous._fieldUpdatedAt || {}) };
                const observed = { ...(previous._fieldObservedAt || {}) };
                const currentPatch = {};
                for (const [field, value] of Object.entries(item)) {
                    if (field.startsWith('_') || FORBIDDEN.has(field) || value === undefined) continue;
                    // A poll started before a later event must not replace that
                    // event with an older snapshot lacking server timestamps.
                    if (incomingTime === null && (fields[field] || 0) > requestedAt) continue;
                    currentPatch[field] = value;
                    fields[field] = receivedAt;
                    // A response to a poll started before a command cannot
                    // establish that the command has taken effect afterwards.
                    observed[field] = requestedAt;
                }
                map.set(item.id, { ...merge(previous, currentPatch), _updatedAt: receivedAt, _fieldUpdatedAt: fields,
                    _fieldObservedAt: observed,
                    ...(incomingTime !== null ? { _sourceTimestamp: incomingTime } : {}) });
            }
        }
        home.lastUpdate = receivedAt;
        return home;
    }

    applyEvent(payload, receivedAt = Date.now()) {
        const data = unwrap(payload);
        if (!plain(data)) return [];
        if (Array.isArray(data.homes)) return data.homes.flatMap(home => this.applyEvent({ home, timestamp: data.timestamp }, receivedAt));
        const patch = plain(data.home) ? data.home : data;
        const explicit = [patch.id, data.home_id, patch.home_id].filter(value => value !== undefined);
        if (explicit.some(value => typeof value !== 'string' || !value) || new Set(explicit).size > 1) return [];
        let homeId = explicit[0];
        if (explicit.length && !this.homes.has(homeId)) return [];
        if (!explicit.length) {
            const ids = [...asList(patch.modules), ...asList(patch.rooms)].map(item => item.id);
            const candidates = [...this.homes].filter(([, home]) => ids.length && ids.every(id => home.modules.has(id) || home.rooms.has(id)));
            if (candidates.length === 1) homeId = candidates[0][0];
        }
        if (!homeId || !this.homes.has(homeId)) return [];
        if (!Array.isArray(patch.modules) && !Array.isArray(patch.rooms) && !Array.isArray(patch.schedules)) return [];
        this.applyStatus(homeId, { home: { ...patch, id: homeId } }, receivedAt, { eventTimestamp: data.timestamp });
        return [homeId];
    }

    applyConfigs(homeId, payload) {
        const data = unwrap(payload);
        const home = plain(data?.home) ? data.home : data;
        if (home?.id && home.id !== homeId) throw new Error('getconfigs home identifier mismatch');
        for (const entry of asList(home?.modules)) {
            const module = this.home(homeId).modules.get(entry.id);
            if (module && ['windows', 'external_covers'].includes(entry.controlled_openers)) {
                this.home(homeId).modules.set(entry.id, merge(module, { controlled_openers: entry.controlled_openers }));
            }
        }
    }

    snapshot(homeId) {
        const home = this.home(homeId);
        return redact({ ...home.data, modules: [...home.modules.values()], rooms: [...home.rooms.values()], schedules: [...home.schedules.values()] });
    }
}

function accountFingerprint(config) {
    return createHash('sha256').update(JSON.stringify([config.username || '', config.clientId || '', config.refreshToken || ''])).digest('hex');
}

module.exports = { HomeModel, safeId, groupId, merge, redact, number, boolean, firmware, isOpener, isWindow, supportsOrientation, sensors, accountFingerprint };
