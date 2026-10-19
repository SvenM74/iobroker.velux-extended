'use strict';

const { VeluxClient } = require('./client');
const { CommandSigner } = require('./signing');
const { pairGateway } = require('./pairing');
const { HomeModel, safeId, groupId, redact, isOpener, isWindow, supportsOrientation, sensors, accountFingerprint, number } = require('./model');
const { CommandBuilder, SCENARIOS, jsonObject, matchesExpected } = require('./commands');
const { CommandQueue } = require('./queue');
const { CredentialStore } = require('./credentials');

const SENSOR_META = {
    temperature: ['Temperature', 'value.temperature', '°C'], humidity: ['Humidity', 'value.humidity', '%'],
    co2: ['CO₂', 'value.co2', 'ppm'], lux: ['Illuminance', 'value.brightness', 'lx'],
    battery_percent: ['Battery', 'value.battery', '%'], battery_level: ['Battery voltage', 'value', 'mV'],
    rf_strength: ['Radio signal', 'value', ''], wifi_strength: ['Wi-Fi signal', 'value', ''],
    min_comfort_temperature: ['Minimum comfort temperature', 'value.temperature', '°C'],
    max_comfort_temperature: ['Maximum comfort temperature', 'value.temperature', '°C'],
    min_comfort_humidity: ['Minimum comfort humidity', 'value.humidity', '%'],
    max_comfort_humidity: ['Maximum comfort humidity', 'value.humidity', '%'],
    max_comfort_co2: ['Maximum comfort CO₂', 'value.co2', 'ppm'], air_quality: ['Air quality (reported code)', 'value', ''],
};

function errorText(error) {
    const code = ['string', 'number'].includes(typeof error?.code) ? `${error.code}: ` : '';
    const message = typeof error?.message === 'string' ? error.message : 'Unknown error';
    return (code + message).replace(/(Bearer\s+)[\w.+\/-]+/gi, '$1[redacted]').slice(0, 1000);
}

class AdapterRuntime {
    constructor(adapter, dependencies = {}) {
        this.adapter = adapter;
        this.Client = dependencies.Client || VeluxClient;
        this.pairGateway = dependencies.pairGateway || pairGateway;
        this.now = dependencies.now || Date.now;
        this.model = new HomeModel();
        this.queue = new CommandQueue();
        this.handlers = new Map();
        this.objects = new Map();
        this.scopes = new Map();
        this.stateWrites = new Map();
        this.stateVersions = new Map();
        this.pendingCommands = new Map();
        this.commandVersions = new Map();
        this.renderTracking = new Map();
        this.timers = new Set();
        this.pairings = new Map();
        this.preparations = new Map();
        this.pairingVersions = new Map();
        this.homeHealth = new Map();
        this.closed = false;
        this.refreshPromise = null;
        this.renderPromise = Promise.resolve();
        this.ready = false;
    }

    _timer(callback, delay) {
        if (this.closed) return null;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (!this.closed) Promise.resolve().then(callback).catch(error => this._report(error));
        }, delay);
        timer.unref?.();
        this.timers.add(timer);
        return timer;
    }

    async _report(error, scope = 'info', current = () => true) {
        if (this.closed || !current()) return;
        const message = errorText(error);
        this.adapter.log.warn(message);
        try { await this._write(`${scope}.lastError`, message, {}, current); } catch { /* Controller shutdown must not trigger another error. */ }
    }

    _write(id, value, options = {}, current = () => true) {
        if (this.closed || !current()) return Promise.resolve();
        const previous = this.stateWrites.get(id) || Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            if (!this.closed && current()) await this.adapter.setStateAsync(id, { val: value, ack: true, ...options });
        });
        this.stateWrites.set(id, operation);
        const done = () => { if (this.stateWrites.get(id) === operation) this.stateWrites.delete(id); };
        operation.then(done, done);
        return operation;
    }

    async _object(id, type, name, native = {}) {
        const definition = { type, common: { name }, native };
        const fingerprint = JSON.stringify(definition);
        if (this.objects.get(id) !== fingerprint) {
            await this.adapter.extendObjectAsync(id, definition);
            this.objects.set(id, fingerprint);
        }
    }

    async _state(id, common, value, handler) {
        const definition = { type: 'state', common: { read: true, write: false, ...common }, native: {} };
        const fingerprint = JSON.stringify(definition);
        if (this.objects.get(id) !== fingerprint) {
            await this.adapter.extendObjectAsync(id, definition);
            this.objects.set(id, fingerprint);
            if (common.def !== undefined && value === undefined && !(await this.adapter.getStateAsync(id))) await this._write(id, common.def);
        }
        if (handler) {
            this.handlers.set(id, handler);
            this.renderTracking.get(id.split('.').slice(0, 2).join('.'))?.add(id);
        } else this.handlers.delete(id);
        if (value !== undefined) await this._write(id, value);
    }

    async _disable(id) {
        this.handlers.delete(id);
        if (this.objects.has(id) || await this.adapter.getObjectAsync(id)) {
            await this.adapter.extendObjectAsync(id, { common: { write: false, desc: 'This control is not supported by the current device or adapter configuration.' } });
            this.objects.delete(id);
        }
    }

    async _button(id, name, handler, role = 'button') {
        await this._state(id, { name, type: 'boolean', role, read: false, write: true, def: false }, undefined, async value => {
            if (value !== true) { await this._write(id, false); return; }
            try { return await handler(); } finally { await this._write(id, false); }
        });
    }

    _scope(path) {
        if (this.scopes.has(path)) return this.scopes.get(path);
        const initialization = this._createScope(path);
        this.scopes.set(path, initialization);
        void initialization.catch(() => { if (this.scopes.get(path) === initialization) this.scopes.delete(path); });
        return initialization;
    }

    async _createScope(path) {
        await this._state(`${path}.lastError`, { name: 'Last command error', type: 'string', role: 'text', def: '' });
        await this._state(`${path}.lastCommand`, { name: 'Last command', type: 'string', role: 'text', def: '' });
        await this._state(`${path}.commandStatus`, { name: 'Command status', type: 'string', role: 'text', def: 'idle', states: {
            idle: 'Idle', queued: 'Queued', pending: 'Sending', accepted: 'Accepted by API', confirmed: 'Reported state matches',
            failed: 'Failed', cancelled: 'Cancelled by stop', unknown: 'Execution not confirmed',
        } }, 'idle');
        await this._state(`${path}.lastSuccess`, { name: 'Last API-accepted command', type: 'number', role: 'value.time', def: 0 });
    }

    _homePath(homeId) { return `homes.${safeId(homeId)}`; }
    _modulePath(homeId, module) { return `${this._homePath(homeId)}.${module.type === 'NXG' ? 'gateways' : 'devices'}.${safeId(module.id)}`; }
    _roomPath(homeId, roomId) { return `${this._homePath(homeId)}.rooms.${safeId(roomId)}`; }
    _gatewayConfig(id) { return (Array.isArray(this.adapter.config.gateways) ? this.adapter.config.gateways : []).find(row => row.id === id) || {}; }

    async start() {
        const config = this.adapter.config;
        this.pollMs = Math.max(15, Number(config.pollInterval) || 60) * 1000;
        await this._object('info', 'channel', 'Connection');
        await this._state('info.connection', { name: 'VELUX API connected', type: 'boolean', role: 'indicator.connected' }, false);
        await this._state('info.eventConnection', { name: 'Event connection', type: 'boolean', role: 'indicator.connected' }, false);
        await this._state('info.lastError', { name: 'Last connection error', type: 'string', role: 'text' }, '');
        await this._state('info.lastUpdate', { name: 'Last status update', type: 'number', role: 'value.time' }, 0);
        await this._object('homes', 'channel', 'Homes');
        await this._button('refresh', 'Reload homes, devices and schedules', () => this.refresh(true));
        await this.adapter.subscribeStatesAsync('*');
        this.credentials = new CredentialStore(this.adapter, accountFingerprint(config));
        await this.credentials.load();
        this.signer = new CommandSigner({ state: this.credentials.data.signing, clock: this.now });
        this.builder = new CommandBuilder({
            model: this.model, signer: this.signer, now: this.now,
            getSigningKey: (home, gateway) => this.credentials.data.keys[CredentialStore.key(home, gateway)],
            getGatewayConfig: id => this._gatewayConfig(id),
            allowIndividualStop: config.allowIndividualStop === true, forceCommands: config.forceCommands === true,
        });
        this.client = new this.Client({
            username: config.username, password: config.password,
            refreshToken: this.credentials.data.refreshToken || config.refreshToken,
            clientId: config.clientId || undefined, clientSecret: config.clientSecret || undefined,
            requestTimeoutMs: Math.min(120, Math.max(5, Number(config.requestTimeout) || 15)) * 1000,
        });
        this.client.on('tokens', tokens => {
            this.credentials.data.refreshToken = tokens.refreshToken || this.credentials.data.refreshToken;
            void this.credentials.save().catch(error => this._report(error));
        });
        this.client.on('authStatus', connected => { if (!connected) void this._write('info.connection', false).catch(() => {}); });
        this.client.on('streamStatus', connected => {
            void this._write('info.eventConnection', connected).catch(() => {});
            if (connected && this.ready) void this.refresh().catch(error => this._report(error));
        });
        this.client.on('warning', error => { void this._report(error); });
        this.client.on('update', update => {
            const receivedAt = this.now();
            this.renderPromise = this.renderPromise.catch(() => {}).then(async () => {
                if (this.closed) return;
                const homes = this.model.applyEvent(update, receivedAt);
                for (const home of homes) await this._renderHome(home);
                if (homes.length) await this._write('info.lastUpdate', this.now());
            }).catch(error => this._report(error));
        });
        await this._connect();
        this._remainingLoop();
    }

    async _connect() {
        if (this.closed) return;
        try {
            await this.client.login();
            await this.credentials.pending;
            await this.refresh(true);
            if (this.closed) return;
            this.ready = true;
            this.retryCount = 0;
            if (this.adapter.config.enableEvents !== false) void this.client.connectEvents().catch(error => this._report(error));
            this._pollLoop();
        } catch (error) {
            await this._write('info.connection', false);
            await this._report(error);
            this.retryCount = (this.retryCount || 0) + 1;
            this._timer(() => this._connect(), Math.min(300000, 10000 * 2 ** Math.min(this.retryCount - 1, 5)));
        }
    }

    _pollLoop() {
        this._timer(async () => {
            try { await this.refresh(this.now() - (this.lastDiscovery || 0) > 15 * 60 * 1000); }
            catch (error) { await this._report(error); }
            this._pollLoop();
        }, this.pollMs);
    }

    _remainingLoop() {
        this._timer(async () => {
            for (const [homeId, home] of this.model.homes) for (const room of home.rooms.values()) {
                if (!Number.isFinite(room.auto_close_ts) || room.auto_close_ts < 0) continue;
                const remaining = Math.max(0, room.auto_close_ts - Math.floor(this.now() / 1000));
                if (this.objects.has(`${this._roomPath(homeId, room.id)}.remainingSeconds`)) await this._write(`${this._roomPath(homeId, room.id)}.remainingSeconds`, remaining);
            }
            await this._confirmPending();
            this._remainingLoop();
        }, 5000);
    }

    async refresh(discover = false) {
        if (this.closed) return;
        if (this.refreshPromise) {
            this.refreshAgain = true;
            this.discoverAgain ||= discover;
            return this.refreshPromise;
        }
        this.refreshPromise = this._refresh(discover);
        try { return await this.refreshPromise; }
        finally {
            this.refreshPromise = null;
            if (this.refreshAgain && !this.closed) {
                const again = this.discoverAgain;
                this.refreshAgain = false; this.discoverAgain = false;
                this._timer(() => this.refresh(again), 250);
            }
        }
    }

    async _refresh(discover) {
        if (discover) {
            const requestedAt = this.now();
            const topology = await this.client.homesData();
            const receivedAt = this.now();
            this.renderPromise = this.renderPromise.catch(() => {}).then(async () => {
                if (this.closed) return;
                const previousHomes = [...this.model.homes.keys()];
                this.model.loadTopology(topology, { requestedAt });
                this.lastDiscovery = receivedAt;
                for (const oldHome of previousHomes) if (!this.model.homes.has(oldHome)) {
                    this.homeHealth.delete(oldHome);
                    await this._write(`${this._homePath(oldHome)}.connection`, false);
                    for (const id of [...this.handlers.keys()]) if (id.startsWith(`${this._homePath(oldHome)}.`)) await this._disable(id);
                }
            });
            await this.renderPromise;
        }
        if (this.closed) return;
        const results = await Promise.allSettled([...this.model.homes.keys()].map(async homeId => {
            try {
                const requestedAt = this.now();
                const status = await this.client.homeStatus(homeId);
                const receivedAt = this.now();
                this.renderPromise = this.renderPromise.catch(() => {}).then(async () => {
                    if (this.closed) return;
                    this.model.applyStatus(homeId, status, receivedAt, { requestedAt });
                    this.homeHealth.set(homeId, true);
                    await this._renderHome(homeId);
                });
                await this.renderPromise;
                if (discover) {
                    try {
                        const configs = await this.client.getConfigs(homeId);
                        this.renderPromise = this.renderPromise.catch(() => {}).then(async () => {
                            if (this.closed) return;
                            this.model.applyConfigs(homeId, configs);
                            await this._renderHome(homeId);
                        });
                        await this.renderPromise;
                    } catch (error) { this.adapter.log.debug(`Optional VELUX product configuration: ${errorText(error)}`); }
                }
            } catch (error) {
                this.homeHealth.set(homeId, false);
                await this._object(this._homePath(homeId), 'device', this.model.home(homeId).data.name || homeId, { homeId });
                await this._state(`${this._homePath(homeId)}.connection`, { name: 'Home status available', type: 'boolean', role: 'indicator.connected' }, false);
                throw error;
            }
        }));
        const errors = results.filter(result => result.status === 'rejected');
        const connected = this.model.homes.size === 0 || [...this.model.homes.keys()].some(id => this.homeHealth.get(id));
        await this._write('info.connection', connected);
        if (connected) await this._write('info.lastUpdate', this.now());
        if (errors.length) {
            await this._report(errors[0].reason);
            if (errors.length === results.length) throw errors[0].reason;
        } else await this._write('info.lastError', '');
        await this._confirmPending();
    }

    async _renderHome(homeId) {
        const home = this.model.home(homeId);
        const path = this._homePath(homeId);
        const previousHandlers = [...this.handlers.keys()].filter(id => id.startsWith(`${path}.`));
        const touchedHandlers = new Set();
        this.renderTracking.set(path, touchedHandlers);
        await this._object(path, 'device', home.data.name || homeId, { homeId });
        await this._state(`${path}.id`, { name: 'VELUX home identifier', type: 'string', role: 'info.address' }, homeId);
        await this._state(`${path}.connection`, { name: 'Home status available', type: 'boolean', role: 'indicator.connected' }, this.homeHealth.get(homeId) === true);
        await this._state(`${path}.lastUpdate`, { name: 'Last home update', type: 'number', role: 'value.time' }, home.lastUpdate);
        await this._scope(path);
        for (const category of ['gateways', 'devices', 'rooms', 'schedules']) await this._object(`${path}.${category}`, 'channel', category);
        const activePrefixes = new Set();
        for (const module of home.modules.values()) {
            const modulePath = this._modulePath(homeId, module);
            activePrefixes.add(modulePath);
            await this._renderModule(homeId, module, modulePath);
        }
        for (const room of home.rooms.values()) {
            const roomPath = this._roomPath(homeId, room.id);
            activePrefixes.add(roomPath);
            await this._renderRoom(homeId, room, roomPath);
        }
        for (const id of [...this.handlers.keys()]) {
            if (!id.startsWith(`${path}.`) || !/\.(devices|gateways|rooms)\./.test(id)) continue;
            if (![...activePrefixes].some(prefix => id.startsWith(`${prefix}.`))) await this._disable(id);
        }
        await this._renderSchedules(homeId);
        for (const id of previousHandlers) if (!touchedHandlers.has(id)) await this._disable(id);
        this.renderTracking.delete(path);
        if (this.adapter.config.rawData) await this._state(`${path}.raw`, { name: 'Redacted VELUX data', type: 'string', role: 'json' }, JSON.stringify(this.model.snapshot(homeId)));
        else if (await this.adapter.getObjectAsync(`${path}.raw`)) await this._write(`${path}.raw`, '{}');
        await this._confirmPending(homeId);
    }

    async _renderModule(homeId, module, path) {
        await this._object(path, 'channel', module.name || module.id, { homeId, moduleId: module.id, type: module.type });
        await this._scope(path);
        await this._state(`${path}.id`, { name: 'VELUX product identifier', type: 'string', role: 'info.address' }, module.id);
        await this._state(`${path}.type`, { name: 'Product type', type: 'string', role: 'text' }, module.velux_type || module.type || 'unknown');
        const boolFields = { reachable: 'Reachable', busy: 'Busy', locked: 'Locked', locking: 'Locking', calibrating: 'Calibrating', is_raining: 'Reported rain', pincode_enabled: 'PIN enabled' };
        for (const [field, label] of Object.entries(boolFields)) if (typeof module[field] === 'boolean') {
            await this._state(`${path}.${field === 'is_raining' ? 'isRaining' : field === 'pincode_enabled' ? 'pinEnabled' : field}`, {
                name: label, type: 'boolean', role: field === 'reachable' ? 'indicator.reachable' : field === 'busy' ? 'indicator.working' : 'indicator',
            }, module[field]);
        }
        if (typeof module.mode === 'string') await this._state(`${path}.mode`, { name: 'Reported mode', type: 'string', role: 'text' }, module.mode);
        await this._state(`${path}.lastUpdate`, { name: 'Last product update', type: 'number', role: 'value.time' }, module._updatedAt || 0);
        if (Number.isFinite(module.last_seen)) await this._state(`${path}.lastSeen`, { name: 'Last seen by VELUX', type: 'number', role: 'value.time' }, module.last_seen * 1000);
        for (const field of ['rf_state', 'battery_state', 'firmware_revision', 'firmware_revision_netatmo', 'firmware_revision_thirdparty']) {
            if (['string', 'number'].includes(typeof module[field])) await this._state(`${path}.${field}`, { name: field, type: typeof module[field], role: typeof module[field] === 'number' ? 'value' : 'text' }, module[field]);
        }
        await this._renderSensors(path, module);
        if (module.type === 'NXG') {
            await this._button(`${path}.stopAll`, 'Stop ALL movements on this gateway', () => this.commandGateway(homeId, module.id, 'stopAll'), 'button.stop');
            await this._state(`${path}.scenario`, { name: 'Run VELUX scenario', type: 'string', role: 'state', read: false, write: true, states: Object.fromEntries(SCENARIOS.map(value => [value, value])) }, undefined,
                value => this.commandGateway(homeId, module.id, 'scenario', value));
            for (const scenario of SCENARIOS) await this._button(`${path}.${scenario}`, `Run ${scenario}`, () => this.commandGateway(homeId, module.id, 'scenario', scenario));
            await this._object(`${path}.pairing`, 'channel', 'Gateway pairing');
            await this._state(`${path}.pairing.status`, { name: 'Pairing status', type: 'string', role: 'text', def: 'idle' });
            await this._state(`${path}.pairing.keyAvailable`, { name: 'Gateway key available', type: 'boolean', role: 'indicator' }, Boolean(this.credentials.data.keys[CredentialStore.key(homeId, module.id)]));
            await this._button(`${path}.pairing.start`, 'Start pairing, then press the gateway button', () => this.pair(homeId, module.id));
            await this._button(`${path}.pairing.confirm`, 'Continue after pressing the physical gateway button', () => this.pair(homeId, module.id, 'confirm'));
            await this._button(`${path}.pairing.cancel`, 'Cancel pairing', () => this.pair(homeId, module.id, 'cancel'));
            return;
        }
        if (isOpener(module)) {
            if (Number.isFinite(module.current_position) && module.current_position >= 0 && module.current_position <= 100) {
                await this._state(`${path}.position`, { name: 'Reported opening (0 closed, 100 open)', type: 'number', role: 'value.blind', unit: '%', min: 0, max: 100 }, module.current_position);
            }
            const reportedTarget = Number.isFinite(module.target_position) && module.target_position >= 0 && module.target_position <= 100 ? module.target_position : undefined;
            await this._state(`${path}.targetPosition`, { name: 'Target opening (0 closed, 100 open)', type: 'number', role: 'level.blind', unit: '%', min: 0, max: 100, write: true }, reportedTarget,
                value => this.commandDevice(homeId, module.id, 'position', value));
            await this._button(`${path}.open`, 'Open', () => this.commandDevice(homeId, module.id, 'open'), 'button.open.blind');
            await this._button(`${path}.close`, 'Close', () => this.commandDevice(homeId, module.id, 'close'), 'button.close.blind');
            if (this.adapter.config.allowIndividualStop) await this._button(`${path}.stop`, 'Experimental individual stop', () => this.commandDevice(homeId, module.id, 'stop'), 'button.stop.blind');
            else await this._disable(`${path}.stop`);
            if (typeof module.silent === 'boolean') await this._state(`${path}.silent`, { name: 'Silent operation', type: 'boolean', role: 'switch', write: true }, module.silent,
                value => this.commandDevice(homeId, module.id, 'silent', value));
            else await this._disable(`${path}.silent`);
            if (Number.isFinite(module.current_orientation)) await this._state(`${path}.orientation`, { name: 'Reported lamella angle', type: 'number', role: 'value.tilt', unit: '°', min: -90, max: 90 }, module.current_orientation);
            let orientation = false;
            try { orientation = supportsOrientation(module, this.model.gateway(homeId, module)); } catch { /* Routing failure is reported when a command is attempted. */ }
            if (orientation) await this._state(`${path}.targetOrientation`, { name: 'Target lamella angle', type: 'number', role: 'level.tilt', unit: '°', min: -90, max: 90, write: true }, module.target_orientation,
                value => this.commandDevice(homeId, module.id, 'orientation', value));
            else await this._disable(`${path}.targetOrientation`);
        }
        if (module.type === 'NXS' && ['windows', 'external_covers'].includes(module.controlled_openers)) {
            await this._state(`${path}.controlledOpeners`, { name: 'Products operated by room sensor', type: 'string', role: 'state', write: true, states: { windows: 'Windows', external_covers: 'External covers' } }, module.controlled_openers,
                value => this.setControlledOpeners(homeId, module.id, value));
        }
    }

    async _renderSensors(path, raw) {
        const values = sensors(raw);
        if (!Object.keys(values).length) return;
        await this._object(`${path}.sensors`, 'channel', 'Measurements');
        for (const [field, value] of Object.entries(values)) {
            const [name, role, unit] = SENSOR_META[field];
            await this._state(`${path}.sensors.${field}`, { name, type: 'number', role, unit }, value);
        }
    }

    async _renderRoom(homeId, room, path) {
        await this._object(path, 'channel', room.name || room.id, { homeId, roomId: room.id });
        await this._scope(path);
        await this._state(`${path}.id`, { name: 'VELUX room identifier', type: 'string', role: 'info.address' }, room.id);
        if (typeof room.mode === 'string') await this._state(`${path}.mode`, { name: 'Reported room mode', type: 'string', role: 'text' }, room.mode);
        const automatic = ['algo_available', 'algo_active'].includes(room.mode) ? true : ['manual', 'algo_disabled'].includes(room.mode) ? false : undefined;
        await this._state(`${path}.automation`, { name: 'Allow VELUX room automation', type: 'boolean', role: 'switch', write: true }, automatic,
            value => this.commandRoom(homeId, room.id, 'automation', value));
        const closeAt = Number.isFinite(room.auto_close_ts) && room.auto_close_ts >= 0 ? room.auto_close_ts : undefined;
        await this._state(`${path}.autoCloseAt`, { name: 'Auto-close Unix time in seconds; 0 cancels', type: 'number', role: 'value', unit: 's', min: 0, write: true }, closeAt,
            value => this.commandRoom(homeId, room.id, 'autoCloseAt', value));
        await this._state(`${path}.autoCloseMinutes`, { name: 'Set room auto-close duration; 0 cancels', type: 'number', role: 'level', unit: 'min', min: 0, max: 1440, read: false, write: true }, undefined,
            value => this.commandRoom(homeId, room.id, 'autoCloseMinutes', value));
        await this._state(`${path}.remainingSeconds`, { name: 'Time until scheduled closing', type: 'number', role: 'value.interval', unit: 's', min: 0 }, closeAt === undefined ? undefined : Math.max(0, closeAt - Math.floor(this.now() / 1000)));
        await this._button(`${path}.cancelAutoClose`, 'Cancel room auto-close timer', () => this.commandRoom(homeId, room.id, 'cancelAutoClose'));
        await this._renderSensors(path, room);
        for (const field of ['algo_status', 'algo_schedule_start']) if (['number', 'string'].includes(typeof room[field])) {
            await this._state(`${path}.${field}`, { name: field, type: typeof room[field], role: typeof room[field] === 'number' ? 'value' : 'text' }, room[field]);
        }
        await this._object(`${path}.groups`, 'channel', 'Product groups');
        const modules = this.model.roomModules(homeId, room.id, 'all');
        const groups = new Set(['covers', 'windows', ...modules.map(module => module.velux_type).filter(Boolean)]);
        for (const group of groups) {
            const selected = this.model.roomModules(homeId, room.id, group);
            if (!selected.length) continue;
            const groupPath = `${path}.groups.${groupId(group)}`;
            await this._object(groupPath, 'channel', group, { group });
            await this._renderGroup(homeId, room.id, group, groupPath);
            if (group === 'covers') await this._renderGroup(homeId, room.id, group, path);
        }
        if (modules.some(isWindow)) await this._state(`${path}.airForMinutes`, { name: 'Open room windows fully for this duration', type: 'number', role: 'level', min: 1, max: 1440, unit: 'min', read: false, write: true }, undefined,
            value => this.commandGroup(homeId, room.id, 'windows', 'open', undefined, number(value, 'Airing duration', 1, 1440, true), path));
    }

    async _renderGroup(homeId, roomId, group, path) {
        await this._scope(path);
        const modules = this.model.roomModules(homeId, roomId, group);
        const targets = new Set(modules.map(module => module.target_position));
        const target = targets.size === 1 && Number.isFinite(modules[0]?.target_position) && modules[0].target_position >= 0 ? modules[0].target_position : undefined;
        await this._state(`${path}.targetPosition`, { name: 'Group target opening (0 closed, 100 open)', type: 'number', role: 'level.blind', min: 0, max: 100, unit: '%', write: true }, target,
            value => this.commandGroup(homeId, roomId, group, 'position', value, undefined, path));
        await this._button(`${path}.open`, 'Open group', () => this.commandGroup(homeId, roomId, group, 'open', undefined, undefined, path), 'button.open.blind');
        await this._button(`${path}.close`, 'Close group', () => this.commandGroup(homeId, roomId, group, 'close', undefined, undefined, path), 'button.close.blind');
        const orientable = modules.some(module => {
            try { return supportsOrientation(module, this.model.gateway(homeId, module)); } catch { return false; }
        });
        if (orientable) await this._state(`${path}.targetOrientation`, { name: 'Group lamella angle', type: 'number', role: 'level.tilt', min: -90, max: 90, unit: '°', write: true }, undefined,
            value => this.commandGroup(homeId, roomId, group, 'orientation', value, undefined, path));
    }

    async _renderSchedules(homeId) {
        const home = this.model.home(homeId);
        const root = `${this._homePath(homeId)}.schedules`;
        const allowed = [...home.schedules.values()].filter(item => ['event', 'algo'].includes(item.type || item.schedule_type));
        const active = allowed.filter(item => item.selected || item.active || home.data.schedule_id === item.id);
        await this._state(`${root}.activeId`, { name: 'Reported active schedule IDs (JSON)', type: 'string', role: 'json' }, JSON.stringify(active.map(item => item.id)));
        await this._state(`${root}.nextEvent`, { name: 'Reported upcoming schedule event', type: 'string', role: 'json' }, JSON.stringify(redact(home.data.next_event || home.data.event_to_come || null)));
        await this._state(`${root}.create`, { name: 'Create VELUX schedule from JSON definition', type: 'string', role: 'json', read: false, write: true }, undefined,
            value => this.schedule(homeId, 'create', jsonObject(value)));
        const valid = new Set([`${root}.create`]);
        for (const schedule of allowed) {
            const path = `${root}.${safeId(schedule.id)}`;
            await this._object(path, 'channel', schedule.name || schedule.id, { scheduleId: schedule.id });
            await this._state(`${path}.name`, { name: 'Schedule name', type: 'string', role: 'text' }, schedule.name || schedule.id);
            await this._state(`${path}.active`, { name: 'Schedule selected', type: 'boolean', role: 'indicator' }, active.some(item => item.id === schedule.id));
            await this._state(`${path}.definition`, { name: 'VELUX schedule definition', type: 'string', role: 'json' }, JSON.stringify(redact(schedule)));
            await this._button(`${path}.activate`, 'Activate schedule', () => this.schedule(homeId, 'switch', { schedule_id: schedule.id }));
            await this._button(`${path}.delete`, 'Delete this VELUX schedule', () => this.schedule(homeId, 'delete', { schedule_id: schedule.id }));
            await this._state(`${path}.rename`, { name: 'New schedule name', type: 'string', role: 'text', read: false, write: true }, undefined,
                value => this.schedule(homeId, 'rename', { schedule_id: schedule.id, name: value }));
            await this._state(`${path}.update`, { name: 'Update VELUX schedule definition (JSON)', type: 'string', role: 'json', read: false, write: true }, undefined,
                value => this.schedule(homeId, 'update', { ...jsonObject(value), schedule_id: schedule.id }));
            for (const action of ['activate', 'delete', 'rename', 'update']) valid.add(`${path}.${action}`);
        }
        for (const id of [...this.handlers.keys()]) if (id.startsWith(`${root}.`) && !valid.has(id)) await this._disable(id);
    }

    async _command(scope, name, route, makeRequest, send) {
        if (this.closed || !this.client) throw new Error('Adapter is not running');
        const version = (this.commandVersions.get(scope) || 0) + 1;
        this.commandVersions.set(scope, version);
        const current = () => !this.closed && this.commandVersions.get(scope) === version;
        this.pendingCommands.delete(scope);
        const uiReady = this._scope(scope).then(async () => {
            await this._write(`${scope}.commandStatus`, 'queued', {}, current);
            await this._write(`${scope}.lastCommand`, name, {}, current);
        });
        // Enter the home queue synchronously. Slow object/state writes must
        // never let a later movement overtake an earlier command or stop.
        void uiReady.catch(() => {});
        const execution = this.queue.run(route.homeId, async () => {
            await uiReady;
            if (this.closed) throw Object.assign(new Error('Adapter is stopping'), { code: 'CLOSED' });
            if (route.active && !route.active()) throw Object.assign(new Error('Command was cancelled'), { code: 'CANCELLED' });
            await this._write(`${scope}.commandStatus`, 'pending', {}, current);
            const built = makeRequest();
            if (built.payload?.home?.modules?.some(module => Object.keys(module).some(key => key.startsWith('hash_')))) {
                this.credentials.data.signing = this.signer.getState();
                await this.credentials.save();
            }
            if (route.active && !route.active()) throw Object.assign(new Error('Command was cancelled'), { code: 'CANCELLED' });
            if (this.closed) throw Object.assign(new Error('Adapter is stopping'), { code: 'CLOSED' });
            const sentAt = this.now();
            const result = await (send ? send(built) : this.client.setState(built.payload));
            await this._write(`${scope}.commandStatus`, 'accepted', {}, current);
            await this._write(`${scope}.lastError`, '', {}, current);
            await this._write(`${scope}.lastSuccess`, this.now(), {}, current);
            if (current() && built.expected?.length) {
                this.pendingCommands.set(scope, { homeId: route.homeId, expected: built.expected, sentAt, deadline: this.now() + 180000, version });
            }
            this._timer(() => this.refresh(), 350);
            this._timer(() => this.refresh(), 2500);
            return { accepted: true, result: redact(result) };
        }, route);
        try {
            return await execution;
        } catch (error) {
            await uiReady.catch(() => {});
            if (route.sensitive) error = Object.assign(new Error('Protected gateway setting was rejected or could not be confirmed'), { code: error.code || 'PROTECTED_COMMAND_FAILED' });
            const state = ['CANCELLED_BY_STOP', 'CANCELLED', 'CLOSED'].includes(error.code) ? 'cancelled' : error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR' ? 'unknown' : 'failed';
            if (current()) {
                await this._write(`${scope}.commandStatus`, state, {}, current);
                await this._report(error, scope, current);
            }
            throw error;
        }
    }

    commandDevice(homeId, moduleId, action, value) {
        const module = this.model.module(homeId, moduleId);
        const gateway = this.model.gateway(homeId, module);
        return this._command(this._modulePath(homeId, module), action, { homeId, gateways: [gateway.id], modules: [moduleId], stopModules: action === 'stop' ? [moduleId] : [], movement: ['position', 'open', 'close', 'orientation'].includes(action), stop: action === 'stop' },
            () => this.builder.device(homeId, moduleId, action, value));
    }

    commandGateway(homeId, gatewayId, action, value, active) {
        const gateway = this.model.module(homeId, gatewayId);
        return this._command(this._modulePath(homeId, gateway), action === 'scenario' ? value : action, { homeId, gateways: [gatewayId], stop: action === 'stopAll', movement: action === 'scenario', sensitive: action === 'pin', active },
            () => this.builder.gateway(homeId, gatewayId, action, value));
    }

    commandRoom(homeId, roomId, action, value) {
        return this._command(this._roomPath(homeId, roomId), action, { homeId }, () => this.builder.room(homeId, roomId, action, value));
    }

    commandGroup(homeId, roomId, group, action, value, durationMinutes, sourceScope) {
        const modules = this.model.roomModules(homeId, roomId, group);
        const gateways = [...new Set(modules.map(module => this.model.gateway(homeId, module).id))];
        const scope = sourceScope || `${this._roomPath(homeId, roomId)}.groups.${groupId(group)}`;
        return this._command(scope, durationMinutes === undefined ? action : 'timedOpening', { homeId, gateways, modules: modules.map(module => module.id), movement: true },
            () => this.builder.group(homeId, roomId, group, action, value, durationMinutes));
    }

    async setControlledOpeners(homeId, moduleId, value) {
        const module = this.model.module(homeId, moduleId);
        const result = await this._command(this._modulePath(homeId, module), 'controlledOpeners', { homeId },
            () => ({ config: this.builder.controlledOpeners(homeId, moduleId, value) }), built => this.client.setConfigs(homeId, built.config));
        this.renderPromise = this.renderPromise.catch(() => {}).then(async () => {
            this.model.applyConfigs(homeId, { modules: [{ id: moduleId, controlled_openers: value }] });
            await this._renderHome(homeId);
        });
        await this.renderPromise;
        return result;
    }

    async schedule(homeId, action, input) {
        const result = await this._command(this._homePath(homeId), `schedule.${action}`, { homeId },
            () => ({ params: this.builder.schedule(homeId, action, input) }), built => this.client.schedule(action, built.params));
        // A failed readback must not turn a successful create into a reported
        // failure and invite the caller to create the same schedule twice.
        try { await this.refresh(true); }
        catch (error) { await this._report(error); return { ...result, readbackPending: true }; }
        return result;
    }

    async _confirmPending(homeId) {
        for (const [scope, pending] of this.pendingCommands) {
            if (homeId && pending.homeId !== homeId) continue;
            const current = () => this.pendingCommands.get(scope) === pending && this.commandVersions.get(scope) === pending.version;
            if (!current()) continue;
            if (!this.model.homes.has(pending.homeId)) { if (current()) this.pendingCommands.delete(scope); continue; }
            if (matchesExpected(this.model, pending.homeId, pending.expected, pending.sentAt)) {
                await this._write(`${scope}.commandStatus`, 'confirmed', {}, current);
                if (current()) this.pendingCommands.delete(scope);
            } else if (this.now() > pending.deadline) {
                await this._write(`${scope}.commandStatus`, 'unknown', {}, current);
                if (current()) this.pendingCommands.delete(scope);
            }
        }
    }

    async pair(homeId, gatewayId, phase = 'prepare') {
        if (this.closed) throw Object.assign(new Error('Adapter is stopping'), { code: 'CLOSED' });
        const gateway = this.model.module(homeId, gatewayId);
        if (gateway.type !== 'NXG') throw new Error('Pairing requires a gateway');
        const key = CredentialStore.key(homeId, gatewayId);
        const path = this._modulePath(homeId, gateway);
        if (phase === 'cancel') {
            const version = (this.pairingVersions.get(key) || 0) + 1;
            this.pairingVersions.set(key, version);
            this.preparations.delete(key);
            this.pairings.get(key)?.abort();
            await this._write(`${path}.pairing.status`, 'cancelled', {}, () => this.pairingVersions.get(key) === version);
            return { cancelled: true };
        }
        if (!['prepare', 'confirm'].includes(phase)) throw new Error('Pairing phase must be prepare, confirm or cancel');
        if (this.pairings.has(key)) throw new Error('Pairing is already running for this gateway');
        const host = this._gatewayConfig(gatewayId).host;
        if (typeof host !== 'string' || !host.trim()) throw new Error('Enter this gateway identifier and local IP address in the adapter settings first');
        if (phase === 'prepare') {
            if (this.preparations.has(key)) throw new Error('Pairing is already prepared or being prepared for this gateway');
            const version = (this.pairingVersions.get(key) || 0) + 1;
            this.pairingVersions.set(key, version);
            const attempt = { version, phase: 'preparing', expiresAt: 0 };
            this.preparations.set(key, attempt);
            const current = () => !this.closed && this.pairingVersions.get(key) === version;
            const check = () => { if (!current()) throw Object.assign(new Error('Pairing was cancelled'), { code: 'CANCELLED' }); };
            try {
                await this._write(`${path}.pairing.status`, 'requesting', {}, current);
                check();
                await this.commandGateway(homeId, gatewayId, 'retrieveKey', undefined, current);
                check();
                attempt.expiresAt = this.now() + 120000;
                attempt.phase = 'ready';
                await this._write(`${path}.pairing.status`, 'awaiting_button', {}, current);
                check();
                this._timer(async () => {
                    if (this.preparations.get(key) === attempt && current()) {
                        this.preparations.delete(key);
                        await this._write(`${path}.pairing.status`, 'expired', {}, current);
                    }
                }, 120000);
                return { prepared: true, next: 'Press the physical gateway button, then run pairing.confirm', expiresAt: attempt.expiresAt };
            } catch (error) {
                if (this.preparations.get(key) === attempt) this.preparations.delete(key);
                await this._write(`${path}.pairing.status`, 'failed', {}, current);
                await this._report(error, path, current);
                throw error;
            }
        }
        const attempt = this.preparations.get(key);
        if (!attempt || attempt.phase !== 'ready' || attempt.expiresAt <= this.now()) throw new Error('Start pairing first, then press the gateway button and confirm');
        this.preparations.delete(key);
        const controller = new AbortController();
        this.pairings.set(key, controller);
        const current = () => !this.closed && !controller.signal.aborted && this.pairingVersions.get(key) === attempt.version;
        const check = () => { if (!current()) throw Object.assign(new Error('Pairing was cancelled'), { code: 'CANCELLED' }); };
        const previousKey = this.credentials.data.keys[key];
        let candidateKey;
        let saved = false;
        try {
            await this._write(`${path}.pairing.status`, 'retrieving', {}, current);
            check();
            const signingKey = await this.pairGateway({ host: host.trim(), timeoutMs: 30000, signal: controller.signal });
            check();
            candidateKey = signingKey;
            this.credentials.data.keys[key] = signingKey;
            await this.credentials.save();
            saved = true;
            check();
            await this._write(`${path}.pairing.keyAvailable`, true, {}, current);
            await this._write(`${path}.pairing.status`, 'paired', {}, current);
            check();
            return { paired: true, homeId, gatewayId };
        } catch (error) {
            if (candidateKey && this.credentials.data.keys[key] === candidateKey) {
                if (previousKey) this.credentials.data.keys[key] = previousKey;
                else delete this.credentials.data.keys[key];
                if (saved) await this.credentials.save();
                await this._write(`${path}.pairing.keyAvailable`, Boolean(previousKey));
            }
            await this._write(`${path}.pairing.status`, 'failed', {}, current);
            await this._report(error, path, current);
            throw error;
        } finally { if (this.pairings.get(key) === controller) this.pairings.delete(key); }
    }

    async onStateChange(id, state) {
        if (this.closed || !state || state.ack) return;
        const local = id.startsWith(`${this.adapter.namespace}.`) ? id.slice(this.adapter.namespace.length + 1) : id;
        const handler = this.handlers.get(local);
        if (!handler) return;
        const version = (this.stateVersions.get(local) || 0) + 1;
        this.stateVersions.set(local, version);
        const current = () => this.stateVersions.get(local) === version;
        try {
            await handler(state.val);
            if (!current() || this.closed) return;
            const object = await this.adapter.getObjectAsync(local);
            if (!object?.common?.role?.startsWith('button')) await this._write(local, state.val, {}, current);
        } catch (error) {
            // The command path records its own error. Validation/routing errors need a global diagnostic too.
            await this._report(error);
        }
    }

    async onMessage(message) {
        if (!message?.command) return;
        let response;
        try {
            const input = message.message || {};
            if (message.command === 'discover' || message.command === 'refresh') {
                await this.refresh(message.command === 'discover'); response = { ok: true };
            } else if (message.command === 'pairGateway') response = await this.pair(input.homeId, input.gatewayId, input.phase || 'prepare');
            else if (message.command === 'setPin') response = await this.commandGateway(input.homeId, input.gatewayId, 'pin', input.pin);
            else if (message.command === 'schedule') response = await this.schedule(input.homeId, input.action, input.definition || input);
            else if (message.command === 'deviceCommand') response = await this.commandDevice(input.homeId, input.moduleId, input.action, input.value);
            else if (message.command === 'gatewayCommand') response = await this.commandGateway(input.homeId, input.gatewayId, input.action, input.value);
            else if (message.command === 'roomCommand') response = await this.commandRoom(input.homeId, input.roomId, input.action, input.value);
            else if (message.command === 'groupCommand') response = await this.commandGroup(input.homeId, input.roomId, input.group || 'covers', input.action, input.value, input.durationMinutes);
            else if (message.command === 'setControlledOpeners') response = await this.setControlledOpeners(input.homeId, input.moduleId, input.value);
            else if (message.command === 'getTopology') response = { homes: [...this.model.homes.keys()].map(id => this.model.snapshot(id)) };
            else throw new Error(`Unknown adapter message: ${message.command}`);
        } catch (error) { response = { error: errorText(error), code: error.code || 'COMMAND_FAILED' }; }
        if (message.callback && message.from) this.adapter.sendTo(message.from, message.command, response, message.callback);
    }

    async stop() {
        if (this.closed) return;
        this.closed = true;
        this.queue.close();
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        for (const controller of this.pairings.values()) controller.abort();
        this.preparations.clear();
        this.client?.close();
        if (this.credentials) await this.credentials.pending.catch(() => {});
        await this.adapter.setStateAsync('info.connection', { val: false, ack: true }).catch(() => {});
        await this.adapter.setStateAsync('info.eventConnection', { val: false, ack: true }).catch(() => {});
    }
}

module.exports = { AdapterRuntime, errorText };
