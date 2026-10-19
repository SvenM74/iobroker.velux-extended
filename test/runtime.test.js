'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { AdapterRuntime } = require('../lib/adapter-runtime');
const { CredentialStore } = require('../lib/credentials');
const { safeId } = require('../lib/model');

const HOME_A = 'home.a';
const HOME_B = 'home.b';
const GATEWAY_A1 = 'gateway-a-first';
const GATEWAY_A2 = 'gateway-a-second';
const GATEWAY_B = 'gateway-b';
const COVER_A = 'cover-a';
const COVER_B = 'cover-b';
const VENETIAN = 'venetian-a';
const WINDOW = 'window-a';
const SENSOR = 'sensor-a';
const ROOM_A = 'room.a';
const ROOM_B = 'room.b';
const REFRESH = 'runtime-private-refresh-token';
const ACCESS = 'runtime-private-access-token';
const PASSWORD = 'runtime-private-account-password';
const KEY = {
    sign_key_id: Buffer.alloc(16, 0x23).toString('base64'),
    hash_sign_key: Buffer.alloc(32, 0x57).toString('base64'),
};

const homePath = id => `homes.${safeId(id)}`;
const devicePath = (home, id) => `${homePath(home)}.devices.${safeId(id)}`;
const gatewayPath = (home, id) => `${homePath(home)}.gateways.${safeId(id)}`;
const roomPath = (home, id) => `${homePath(home)}.rooms.${safeId(id)}`;
const clone = value => value === undefined ? undefined : structuredClone(value);
const gatesByTest = new WeakMap();

function deferred(t) {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    if (t) {
        if (!gatesByTest.has(t)) gatesByTest.set(t, new Set());
        gatesByTest.get(t).add(resolve);
    }
    return { promise, resolve, reject };
}

function fixture() {
    const topology = { homes: [
        {
            id: HOME_A, name: 'First home',
            modules: [
                { id: GATEWAY_A1, type: 'NXG', name: 'First gateway', firmware_revision_netatmo: 60 },
                { id: GATEWAY_A2, type: 'NXG', name: 'Second gateway', firmware_revision_netatmo: 60 },
                { id: COVER_A, type: 'NXO', velux_type: 'blind', bridge: GATEWAY_A2, room_id: ROOM_A },
                { id: VENETIAN, type: 'NXO', velux_type: 'venetian_blind', bridge: GATEWAY_A2, room_id: ROOM_A },
                { id: WINDOW, type: 'NXO', velux_type: 'window', bridge: GATEWAY_A2, room_id: ROOM_A },
                { id: SENSOR, type: 'NXS', bridge: GATEWAY_A2, room_id: ROOM_A },
            ],
            rooms: [{ id: ROOM_A, name: 'Living room', module_ids: [COVER_A, VENETIAN, WINDOW, SENSOR] }],
            schedules: [{
                id: 'schedule-a', name: 'Morning', type: 'event', selected: true,
                zones: [{ id: 1, name: 'Open covers', rooms: [{ id: ROOM_A, modules: [{ id: COVER_A, target_position: 100 }] }] }],
                timetable: [{ m_offset: 420, zone_id: 1 }],
                timetable_sunrise: [{ day_id: 1, zone_id: 1, sun_offset: 0 }],
                timetable_sunset: [],
            }],
        },
        {
            id: HOME_B, name: 'Second home',
            modules: [
                { id: GATEWAY_B, type: 'NXG', firmware_revision_netatmo: 60 },
                { id: COVER_B, type: 'NXO', velux_type: 'roller_shutter', bridge: GATEWAY_B, room_id: ROOM_B },
            ],
            rooms: [{ id: ROOM_B, module_ids: [COVER_B] }],
            schedules: [{ id: 'schedule-b', name: 'Automatic', type: 'algo', selected: true, zones: [], timetable: [] }],
        },
    ] };
    const statuses = new Map([
        [HOME_A, { home: {
            id: HOME_A,
            modules: [
                { id: GATEWAY_A1, reachable: true, locked: false },
                { id: GATEWAY_A2, reachable: true, locked: false },
                { id: COVER_A, reachable: true, current_position: 0, target_position: 0, silent: false, busy: false },
                { id: VENETIAN, reachable: true, current_position: 0, target_position: 0, current_orientation: 0, target_orientation: 0 },
                { id: WINDOW, reachable: true, current_position: 0, target_position: 0 },
                { id: SENSOR, reachable: true, battery_percent: 75 },
            ],
            rooms: [{ id: ROOM_A, mode: 'manual', auto_close_ts: 0, temperature: 215, humidity: 48, co2: 640 }],
        } }],
        [HOME_B, { home: {
            id: HOME_B,
            modules: [{ id: GATEWAY_B, reachable: true }, { id: COVER_B, reachable: true, current_position: 25, target_position: 25 }],
            rooms: [{ id: ROOM_B, mode: 'manual', auto_close_ts: 0 }],
        } }],
    ]);
    const configs = new Map([
        [HOME_A, { home: { modules: [{ id: SENSOR, bridge: GATEWAY_A2, controlled_openers: 'windows' }] } }],
        [HOME_B, { home: { modules: [] } }],
    ]);
    return { topology, statuses, configs };
}

class FakeAdapter {
    constructor(config = {}) {
        this.namespace = 'velux-extended.0';
        this.config = {
            username: 'runtime@example.invalid', password: PASSWORD,
            pollInterval: 3600, requestTimeout: 15, enableEvents: false, rawData: true,
            gateways: [{ id: GATEWAY_A2, host: '192.168.50.2' }], ...config,
        };
        this.objects = new Map();
        this.states = new Map();
        this.writes = [];
        this.objectWrites = [];
        this.subscriptions = [];
        this.messages = [];
        this.logs = [];
        this.ciphertexts = new Map();
        this.log = Object.fromEntries(['warn', 'error', 'info', 'debug'].map(level => [level, message => this.logs.push({ level, message })]));
    }

    async getObjectAsync(id) {
        if (this.beforeGetObject) await this.beforeGetObject(id);
        return clone(this.objects.get(id));
    }

    async extendObjectAsync(id, definition) {
        if (this.beforeExtendObject) await this.beforeExtendObject(id, definition);
        const old = this.objects.get(id) || {};
        this.objects.set(id, clone({ ...old, ...definition, common: { ...old.common, ...definition.common }, native: { ...old.native, ...definition.native } }));
    }

    async setObjectAsync(id, definition) {
        if (this.beforeSetObject) await this.beforeSetObject(id, definition);
        this.objectWrites.push({ id, definition: clone(definition) });
        this.objects.set(id, clone(definition));
    }

    async getStateAsync(id) { return clone(this.states.get(id)); }

    async setStateAsync(id, state) {
        if (this.beforeSetState) await this.beforeSetState(id, state);
        this.writes.push({ id, state: clone(state) });
        this.states.set(id, clone(state));
    }

    async subscribeStatesAsync(pattern) { this.subscriptions.push(pattern); }

    // The fixture simulates the controller encryption boundary. It does not
    // pretend that an encoding or a custom cipher implements ioBroker crypto.
    encrypt(cleartext) {
        const sealed = `test-controller-ciphertext-${this.ciphertexts.size + 1}`;
        this.ciphertexts.set(sealed, cleartext);
        return sealed;
    }

    decrypt(sealed) {
        assert.ok(this.ciphertexts.has(sealed), 'only ciphertext produced by this controller is decryptable');
        return this.ciphertexts.get(sealed);
    }

    sendTo(from, command, response, callback) { this.messages.push({ from, command, response, callback }); }

    value(id) { return this.states.get(id)?.val; }

    storedCredentials() {
        const sealed = this.objects.get('_credentials')?.native?.sealed;
        return sealed ? JSON.parse(this.decrypt(sealed)) : undefined;
    }
}

function createHarness(t, options = {}) {
    const adapter = new FakeAdapter(options.config);
    const data = fixture();
    const behavior = options.behavior || {};
    const clock = { value: 1700000000000, advance(ms = 1000) { this.value += ms; } };
    let client;
    class FakeClient extends EventEmitter {
        constructor(config) {
            super();
            this.config = config;
            this.calls = { login: 0, homesData: 0, homeStatus: [], getConfigs: [], setState: [], setConfigs: [], schedule: [], connectEvents: 0, close: 0 };
            this.data = data;
            client = this;
        }

        async login() {
            this.calls.login++;
            if (behavior.login) await behavior.login(this);
            const tokens = { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: clock.value + 3600000 };
            this.emit('authStatus', true);
            this.emit('tokens', tokens);
            return tokens;
        }

        async homesData() {
            this.calls.homesData++;
            return behavior.homesData ? behavior.homesData(this) : clone(data.topology);
        }

        async homeStatus(id) {
            this.calls.homeStatus.push(id);
            return behavior.homeStatus ? behavior.homeStatus(id, this) : clone(data.statuses.get(id));
        }

        async getConfigs(id) {
            this.calls.getConfigs.push(id);
            return behavior.getConfigs ? behavior.getConfigs(id, this) : clone(data.configs.get(id));
        }

        async setState(payload) {
            this.calls.setState.push(clone(payload));
            return behavior.setState ? behavior.setState(payload, this) : { status: 'ok' };
        }

        async setConfigs(id, payload) {
            this.calls.setConfigs.push({ homeId: id, payload: clone(payload) });
            return behavior.setConfigs ? behavior.setConfigs(id, payload, this) : { status: 'ok' };
        }

        async schedule(action, params) {
            this.calls.schedule.push({ action, params: clone(params) });
            return behavior.schedule ? behavior.schedule(action, params, this) : { status: 'ok' };
        }

        async connectEvents() {
            this.calls.connectEvents++;
            if (behavior.connectEvents) await behavior.connectEvents(this);
        }

        close() { this.calls.close++; this.emit('streamStatus', false); this.emit('authStatus', false); }
    }
    const pairingCalls = [];
    const runtime = new AdapterRuntime(adapter, {
        Client: FakeClient, now: () => clock.value,
        pairGateway: async args => {
            pairingCalls.push(args);
            return options.pairGateway ? options.pairGateway(args) : clone(KEY);
        },
    });
    t.after(async () => {
        // Release simulated I/O before stop awaits a pending credential write,
        // including when an earlier assertion has failed.
        for (const resolve of gatesByTest.get(t) || []) resolve();
        await runtime.stop();
    });
    return {
        adapter, data, behavior, clock, runtime, pairingCalls,
        get client() { return client; },
        async start() { await runtime.start(); return this; },
        async write(id, value, ack = false) {
            const state = { val: value, ack, ts: clock.value, lc: clock.value };
            adapter.states.set(id, clone(state));
            return runtime.onStateChange(`${adapter.namespace}.${id}`, state);
        },
        async event(homeId, modules, rooms) {
            client.emit('update', { home: { id: homeId, ...(modules ? { modules } : {}), ...(rooms ? { rooms } : {}) } });
            await runtime.renderPromise;
        },
    };
}

test('runtime starts, discovers every home and exposes typed controls and normalized sensors', async t => {
    const h = await createHarness(t).start();
    assert.equal(h.client.calls.login, 1);
    assert.equal(h.client.calls.homesData, 1);
    assert.deepEqual(h.client.calls.homeStatus.sort(), [HOME_A, HOME_B].sort());
    assert.deepEqual(h.client.calls.getConfigs.sort(), [HOME_A, HOME_B].sort());
    assert.deepEqual(h.adapter.subscriptions, ['*']);
    assert.equal(h.adapter.value('info.connection'), true);
    assert.equal(h.adapter.value(`${homePath(HOME_A)}.connection`), true);
    assert.equal(h.adapter.value(`${homePath(HOME_B)}.connection`), true);
    assert.equal(h.adapter.value(`${roomPath(HOME_A, ROOM_A)}.sensors.temperature`), 21.5);
    assert.equal(h.adapter.value(`${roomPath(HOME_A, ROOM_A)}.sensors.co2`), 640);
    assert.equal(h.adapter.value(`${devicePath(HOME_A, SENSOR)}.sensors.battery_percent`), 75);
    assert.equal(h.adapter.objects.get(`${devicePath(HOME_A, COVER_A)}.position`).common.write, false);
    assert.equal(h.adapter.objects.get(`${devicePath(HOME_A, COVER_A)}.targetPosition`).common.write, true);
    assert.equal(h.adapter.objects.get(`${devicePath(HOME_A, VENETIAN)}.targetOrientation`).common.write, true);
    assert.equal(h.adapter.value(`${devicePath(HOME_A, SENSOR)}.controlledOpeners`), 'windows');
});

test('failed login stays offline without attempting discovery or commands', async t => {
    const h = await createHarness(t, { behavior: { login: async () => { throw Object.assign(new Error('Authentication rejected'), { code: 'INVALID_AUTH' }); } } }).start();
    assert.equal(h.adapter.value('info.connection'), false);
    assert.equal(h.client.calls.homesData, 0);
    assert.match(h.adapter.value('info.lastError'), /Authentication rejected/);
    assert.equal(h.client.calls.setState.length, 0);
});

test('WebSocket startup failure is handled while successful HTTP polling remains connected', async t => {
    const h = await createHarness(t, {
        config: { enableEvents: true },
        behavior: { connectEvents: async () => { throw new Error('Stream unavailable'); } },
    }).start();
    await nextTurn();
    assert.equal(h.client.calls.connectEvents, 1);
    assert.equal(h.adapter.value('info.connection'), true);
    assert.equal(h.adapter.value('info.eventConnection'), false);
    assert.ok(h.adapter.logs.some(entry => entry.message.includes('Stream unavailable')));
    h.clock.advance();
    await h.runtime.refresh();
    assert.equal(h.client.calls.homeStatus.length, 4);
});

test('device commands retain the correct home and actual bridge instead of choosing the first gateway', async t => {
    const h = await createHarness(t).start();
    await h.runtime.commandDevice(HOME_A, COVER_A, 'position', 37);
    await h.runtime.commandDevice(HOME_B, COVER_B, 'position', 81);
    assert.deepEqual(h.client.calls.setState.map(payload => ({ home: payload.home.id, module: payload.home.modules[0] })), [
        { home: HOME_A, module: { id: COVER_A, bridge: GATEWAY_A2, target_position: 37, force: false } },
        { home: HOME_B, module: { id: COVER_B, bridge: GATEWAY_B, target_position: 81, force: false } },
    ]);
    assert.throws(() => h.runtime.commandDevice(HOME_A, COVER_B, 'open'), { code: 'UNKNOWN_DEVICE' });
    assert.equal(h.client.calls.setState.length, 2);
});

test('acknowledged state changes are ignored and buttons only act on boolean true', async t => {
    const h = await createHarness(t).start();
    const target = `${devicePath(HOME_A, COVER_A)}.targetPosition`;
    const button = `${gatewayPath(HOME_A, GATEWAY_A2)}.stopAll`;
    await h.write(target, 75, true);
    await h.write(button, false);
    await h.write(button, 'true');
    assert.equal(h.client.calls.setState.length, 0);
    await h.write(button, true);
    assert.deepEqual(h.client.calls.setState, [{ home: { id: HOME_A, modules: [{ id: GATEWAY_A2, stop_movements: 'all' }] } }]);
    assert.deepEqual(h.adapter.states.get(button), { val: false, ack: true });
});

test('invalid positions are reported without making any cloud mutation', async t => {
    const h = await createHarness(t).start();
    const path = devicePath(HOME_A, COVER_A);
    for (const value of [-1, 101, 20.5, '20', null]) await h.write(`${path}.targetPosition`, value);
    assert.equal(h.client.calls.setState.length, 0);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'failed');
    assert.match(h.adapter.value(`${path}.lastError`), /INVALID_VALUE/);
});

test('API acceptance does not invent a physical position or report arrival at the target', async t => {
    const h = await createHarness(t).start();
    const path = devicePath(HOME_A, COVER_A);
    h.clock.advance();
    const result = await h.runtime.commandDevice(HOME_A, COVER_A, 'position', 80);
    assert.equal(result.accepted, true);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'accepted');
    assert.equal(h.adapter.value(`${path}.position`), 0);
    h.clock.advance();
    await h.event(HOME_A, [{ id: COVER_A, current_position: 80 }]);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'confirmed');
    assert.equal(h.adapter.value(`${path}.position`), 80);
});

test('an unrelated fresh module field cannot confirm a stale position that already matched', async t => {
    const h = await createHarness(t).start();
    const path = devicePath(HOME_A, COVER_A);
    h.clock.advance();
    await h.runtime.commandDevice(HOME_A, COVER_A, 'position', 0);
    h.clock.advance();
    await h.event(HOME_A, [{ id: COVER_A, busy: true }]);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'accepted');
    h.clock.advance();
    await h.event(HOME_A, [{ id: COVER_A, current_position: 0 }]);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'confirmed');
});

test('room cover aliases include only covers while window groups use signed per-device routing', async t => {
    const h = await createHarness(t).start();
    const room = roomPath(HOME_A, ROOM_A);
    await h.write(`${room}.targetPosition`, 40);
    const payload = h.client.calls.setState[0];
    assert.equal(payload.home.id, HOME_A);
    assert.deepEqual(payload.home.modules.map(module => module.id).sort(), [COVER_A, VENETIAN].sort());
    assert.ok(payload.home.modules.every(module => module.bridge === GATEWAY_A2 && module.target_position === 40));
    h.runtime.credentials.data.keys[CredentialStore.key(HOME_A, GATEWAY_A2)] = clone(KEY);
    await h.runtime.credentials.save();
    h.clock.advance();
    await h.runtime.commandGroup(HOME_A, ROOM_A, 'windows', 'position', 30, 15);
    const timed = h.client.calls.setState[1];
    assert.equal(timed.home.modules.length, 1);
    assert.equal(timed.home.modules[0].id, WINDOW);
    assert.equal(timed.home.modules[0].bridge, GATEWAY_A2);
    assert.equal(typeof timed.home.modules[0].hash_target_position, 'string');
    assert.deepEqual(timed.home.rooms, [{ id: ROOM_A, auto_close_ts: Math.floor(h.clock.value / 1000) + 900 }]);
});

test('a group build failure sends none of the already built cover movements', async t => {
    const h = await createHarness(t).start();
    // Covers can be built, but the same room also contains an unpaired window.
    // The entire command must fail before any subset is transmitted.
    await assert.rejects(h.runtime.commandGroup(HOME_A, ROOM_A, 'all', 'open'), { code: 'PAIRING_REQUIRED' });
    assert.equal(h.client.calls.setState.length, 0);
    assert.equal(h.client.calls.setConfigs.length, 0);
});

test('rotated refresh tokens are stored only through controller encryption and never in readable states', async t => {
    const h = await createHarness(t).start();
    assert.equal(h.adapter.storedCredentials().refreshToken, REFRESH);
    h.client.emit('tokens', { accessToken: 'second-private-access', refreshToken: 'second-private-refresh', expiresAt: h.clock.value + 7200000 });
    await h.runtime.credentials.pending;
    assert.equal(h.adapter.storedCredentials().refreshToken, 'second-private-refresh');
    const visible = JSON.stringify({ states: [...h.adapter.states], objects: [...h.adapter.objects], logs: h.adapter.logs });
    for (const secret of [ACCESS, REFRESH, PASSWORD, 'second-private-access', 'second-private-refresh']) assert.equal(visible.includes(secret), false);
    const credentials = h.adapter.objects.get('_credentials');
    assert.deepEqual(Object.keys(credentials.native), ['sealed']);
    assert.equal(credentials.acl.object, 0x600);
});

test('signed movement waits for persistent nonce allocation before any HTTP request is sent', async t => {
    const h = await createHarness(t).start();
    h.runtime.credentials.data.keys[CredentialStore.key(HOME_A, GATEWAY_A2)] = clone(KEY);
    await h.runtime.credentials.save();
    const saving = deferred(t);
    const release = deferred(t);
    h.adapter.beforeSetObject = async (id, definition) => {
        if (id === '_credentials' && JSON.parse(h.adapter.decrypt(definition.native.sealed)).signing) {
            saving.resolve();
            await release.promise;
        }
    };
    const command = h.runtime.commandDevice(HOME_A, WINDOW, 'open');
    await saving.promise;
    assert.equal(h.client.calls.setState.length, 0);
    release.resolve();
    await command;
    const sent = h.client.calls.setState[0].home.modules[0];
    const saved = h.adapter.storedCredentials().signing.keys[sent.sign_key_id];
    assert.deepEqual(saved, { timestamp: sent.timestamp, nonce: sent.nonce });
    assert.equal(sent.target_position, 100);
    assert.ok(sent.hash_target_position);
});

test('failed signing-state persistence prevents protected commands from reaching the cloud', async t => {
    const h = await createHarness(t).start();
    h.runtime.credentials.data.keys[CredentialStore.key(HOME_A, GATEWAY_A2)] = clone(KEY);
    await h.runtime.credentials.save();
    h.adapter.beforeSetObject = async id => { if (id === '_credentials') throw new Error('Credential storage unavailable'); };
    await assert.rejects(h.runtime.commandDevice(HOME_A, WINDOW, 'open'), /Credential storage unavailable/);
    assert.equal(h.client.calls.setState.length, 0);
    assert.equal(h.adapter.value(`${devicePath(HOME_A, WINDOW)}.commandStatus`), 'failed');
});

test('pairing requires cloud preparation followed by explicit physical-button confirmation', async t => {
    const h = await createHarness(t).start();
    const path = gatewayPath(HOME_A, GATEWAY_A2);
    await assert.rejects(h.runtime.pair(HOME_A, GATEWAY_A2, 'confirm'), /Start pairing first/);
    const prepared = await h.runtime.pair(HOME_A, GATEWAY_A2, 'prepare');
    assert.equal(prepared.prepared, true);
    assert.equal(h.pairingCalls.length, 0);
    assert.deepEqual(h.client.calls.setState, [{ home: { id: HOME_A, modules: [{ id: GATEWAY_A2, retrieve_key: true }] } }]);
    assert.equal(h.adapter.value(`${path}.pairing.status`), 'awaiting_button');
    const paired = await h.runtime.pair(HOME_A, GATEWAY_A2, 'confirm');
    assert.equal(paired.paired, true);
    assert.equal(h.pairingCalls.length, 1);
    assert.equal(h.pairingCalls[0].host, '192.168.50.2');
    assert.equal(h.pairingCalls[0].signal.aborted, false);
    assert.equal(h.adapter.value(`${path}.pairing.status`), 'paired');
    assert.equal(h.adapter.value(`${path}.pairing.keyAvailable`), true);
    assert.deepEqual(h.adapter.storedCredentials().keys[CredentialStore.key(HOME_A, GATEWAY_A2)], KEY);
    assert.equal(h.adapter.storedCredentials().keys[CredentialStore.key(HOME_B, GATEWAY_B)], undefined);
});

test('cancelling while the cloud preparation is in flight cannot revive pairing afterwards', async t => {
    const entered = deferred(t);
    const release = deferred(t);
    const h = await createHarness(t, { behavior: { setState: async () => { entered.resolve(); await release.promise; return {}; } } }).start();
    const preparing = h.runtime.pair(HOME_A, GATEWAY_A2, 'prepare').then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await h.runtime.pair(HOME_A, GATEWAY_A2, 'cancel');
    release.resolve();
    await preparing;
    assert.equal(h.adapter.value(`${gatewayPath(HOME_A, GATEWAY_A2)}.pairing.status`), 'cancelled');
    await assert.rejects(h.runtime.pair(HOME_A, GATEWAY_A2, 'confirm'));
    assert.equal(h.pairingCalls.length, 0);
});

test('a second prepare cannot request another key while the first preparation is active', async t => {
    const entered = deferred(t);
    const release = deferred(t);
    const h = await createHarness(t, { behavior: { setState: async () => { entered.resolve(); await release.promise; return {}; } } }).start();
    const first = h.runtime.pair(HOME_A, GATEWAY_A2, 'prepare');
    await entered.promise;
    const second = h.runtime.pair(HOME_A, GATEWAY_A2, 'prepare').then(() => false, () => true);
    // Resolve the first even when running against a broken implementation, so
    // this regression reports an assertion rather than leaving a hanging test.
    await nextTurn();
    release.resolve();
    await first;
    assert.equal(await second, true);
    assert.equal(h.client.calls.setState.length, 1);
});

test('cancelling confirmation aborts local pairing and rejects a late returned key', async t => {
    const entered = deferred(t);
    const returnedKey = deferred(t);
    const h = await createHarness(t, { pairGateway: async () => { entered.resolve(); return returnedKey.promise; } }).start();
    await h.runtime.pair(HOME_A, GATEWAY_A2, 'prepare');
    const confirming = h.runtime.pair(HOME_A, GATEWAY_A2, 'confirm').then(value => ({ value }), error => ({ error }));
    await entered.promise;
    await assert.rejects(h.runtime.pair(HOME_A, GATEWAY_A2, 'confirm'));
    await h.runtime.pair(HOME_A, GATEWAY_A2, 'cancel');
    assert.equal(h.pairingCalls[0].signal.aborted, true);
    returnedKey.resolve(clone(KEY));
    await confirming;
    assert.equal(h.runtime.credentials.data.keys[CredentialStore.key(HOME_A, GATEWAY_A2)], undefined);
    assert.equal(h.adapter.value(`${gatewayPath(HOME_A, GATEWAY_A2)}.pairing.status`), 'cancelled');
    assert.equal(h.adapter.value(`${gatewayPath(HOME_A, GATEWAY_A2)}.pairing.keyAvailable`), false);
});

test('a delayed ioBroker state write cannot reverse two cloud movement commands', async t => {
    const h = await createHarness(t).start();
    const release = deferred(t);
    let delayed = false;
    const status = `${devicePath(HOME_A, COVER_A)}.commandStatus`;
    h.adapter.beforeSetState = async (id, state) => {
        if (!delayed && id === status && state.val === 'queued') { delayed = true; await release.promise; }
    };
    const first = h.runtime.commandDevice(HOME_A, COVER_A, 'position', 20);
    await nextTurn();
    const second = h.runtime.commandDevice(HOME_A, COVER_A, 'position', 80);
    await nextTurn();
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(h.client.calls.setState.map(payload => payload.home.modules[0].target_position), [20, 80]);
    assert.equal(h.adapter.value(status), 'accepted');
});

test('completion of an older state-change handler cannot acknowledge over the newer target', async t => {
    const h = await createHarness(t).start();
    const release = deferred(t);
    let delayed = false;
    const target = `${devicePath(HOME_A, COVER_A)}.targetPosition`;
    h.adapter.beforeGetObject = async id => { if (!delayed && id === target) { delayed = true; await release.promise; } };
    const first = h.write(target, 20);
    await nextTurn();
    h.clock.advance();
    const second = h.write(target, 80);
    await nextTurn();
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(h.client.calls.setState.map(payload => payload.home.modules[0].target_position), [20, 80]);
    assert.equal(h.adapter.value(target), 80);
    assert.equal(h.adapter.states.get(target).ack, true);
});

test('an old confirmation cannot remove or confirm a newer pending command in the same scope', async t => {
    const h = await createHarness(t).start();
    const path = devicePath(HOME_A, COVER_A);
    h.clock.advance();
    await h.runtime.commandDevice(HOME_A, COVER_A, 'position', 20);
    const entered = deferred(t);
    const release = deferred(t);
    let delayed = false;
    h.adapter.beforeSetState = async (id, state) => {
        if (!delayed && id === `${path}.commandStatus` && state.val === 'confirmed') {
            delayed = true; entered.resolve(); await release.promise;
        }
    };
    h.clock.advance();
    const event = h.event(HOME_A, [{ id: COVER_A, current_position: 20 }]);
    await entered.promise;
    h.clock.advance();
    const newer = h.runtime.commandDevice(HOME_A, COVER_A, 'position', 80);
    await nextTurn();
    release.resolve();
    await Promise.all([event, newer]);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'accepted');
    h.clock.advance();
    await h.event(HOME_A, [{ id: COVER_A, current_position: 80 }]);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'confirmed');
});

test('an event received before a command is not made fresh by a delayed render queue', async t => {
    const h = await createHarness(t).start();
    const entered = deferred(t);
    const release = deferred(t);
    let delayed = false;
    h.adapter.beforeSetState = async id => {
        if (!delayed && id === `${homePath(HOME_A)}.lastUpdate`) { delayed = true; entered.resolve(); await release.promise; }
    };
    h.clock.advance();
    h.client.emit('update', { home: { id: HOME_A, modules: [{ id: COVER_A, busy: true }] } });
    await entered.promise;
    h.clock.advance();
    h.client.emit('update', { home: { id: HOME_A, modules: [{ id: COVER_A, current_position: 100 }] } });
    h.clock.advance();
    await h.runtime.commandDevice(HOME_A, COVER_A, 'position', 100);
    h.clock.advance();
    release.resolve();
    await h.runtime.renderPromise;
    const path = devicePath(HOME_A, COVER_A);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'accepted');
    h.clock.advance();
    await h.event(HOME_A, [{ id: COVER_A, current_position: 100 }]);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'confirmed');
});

test('a poll started before a command cannot confirm it merely by returning afterwards', async t => {
    const h = await createHarness(t).start();
    const entered = deferred(t);
    const release = deferred(t);
    let delayed = false;
    h.behavior.homeStatus = async id => {
        if (id === HOME_A && !delayed) {
            delayed = true; entered.resolve(); await release.promise;
            return { home: { id, modules: [{ id: COVER_A, current_position: 100 }] } };
        }
        return clone(h.data.statuses.get(id));
    };
    h.clock.advance();
    const polling = h.runtime.refresh();
    await entered.promise;
    h.clock.advance();
    await h.runtime.commandDevice(HOME_A, COVER_A, 'position', 100);
    h.clock.advance();
    release.resolve();
    await polling;
    const path = devicePath(HOME_A, COVER_A);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'accepted');
    h.clock.advance();
    await h.event(HOME_A, [{ id: COVER_A, current_position: 100 }]);
    assert.equal(h.adapter.value(`${path}.commandStatus`), 'confirmed');
});

test('an event naming an unknown home cannot update a known home through a matching device ID', async t => {
    const h = await createHarness(t).start();
    h.clock.advance();
    await h.event('unknown-home', [{ id: COVER_A, current_position: 100 }]);
    assert.equal(h.adapter.value(`${devicePath(HOME_A, COVER_A)}.position`), 0);
    assert.equal(h.runtime.model.module(HOME_A, COVER_A).current_position, 0);
});

test('native schedule update retains sunrise data and every schedule command stays inside its home', async t => {
    const h = await createHarness(t).start();
    await h.runtime.schedule(HOME_A, 'update', { schedule_id: 'schedule-a', name: 'Sunrise routine' });
    const update = h.client.calls.schedule[0];
    assert.equal(update.action, 'update');
    assert.equal(update.params.home_id, HOME_A);
    assert.equal(update.params.schedule_id, 'schedule-a');
    assert.deepEqual(update.params.timetable_sunrise, h.data.topology.homes[0].schedules[0].timetable_sunrise);
    assert.deepEqual(update.params.timetable_sunset, []);
    await h.runtime.schedule(HOME_B, 'rename', { schedule_id: 'schedule-b', name: 'New name' });
    await h.runtime.schedule(HOME_B, 'switch', { schedule_id: 'schedule-b' });
    await h.runtime.schedule(HOME_B, 'delete', { schedule_id: 'schedule-b' });
    assert.deepEqual(h.client.calls.schedule.slice(1).map(call => [call.action, call.params.home_id, call.params.schedule_id]), [
        ['rename', HOME_B, 'schedule-b'], ['switch', HOME_B, 'schedule-b'], ['delete', HOME_B, 'schedule-b'],
    ]);
    await assert.rejects(h.runtime.schedule(HOME_A, 'delete', { schedule_id: 'schedule-b' }), { code: 'UNKNOWN_SCHEDULE' });
    assert.equal(h.client.calls.schedule.length, 4);
});

test('an accepted schedule mutation stays accepted when its subsequent discovery read fails', async t => {
    const h = await createHarness(t).start();
    h.behavior.homesData = async () => { throw new Error('Follow-up discovery unavailable'); };
    const result = await h.runtime.schedule(HOME_A, 'rename', { schedule_id: 'schedule-a', name: 'Renamed routine' });
    assert.equal(result.accepted, true);
    assert.equal(result.readbackPending, true);
    assert.equal(h.client.calls.schedule.length, 1);
    assert.equal(h.adapter.value(`${homePath(HOME_A)}.commandStatus`), 'accepted');
    assert.ok(h.adapter.logs.some(entry => entry.message.includes('Follow-up discovery unavailable')));
});

test('sensor configuration writes use the sensor home and bridge and keep errors observable', async t => {
    const h = await createHarness(t).start();
    await h.runtime.setControlledOpeners(HOME_A, SENSOR, 'external_covers');
    assert.deepEqual(h.client.calls.setConfigs, [{ homeId: HOME_A, payload: { modules: [{ id: SENSOR, bridge: GATEWAY_A2, controlled_openers: 'external_covers' }] } }]);
    assert.equal(h.adapter.value(`${devicePath(HOME_A, SENSOR)}.controlledOpeners`), 'external_covers');
    h.behavior.setState = async () => { throw Object.assign(new Error('Device rejected command'), { code: 16, httpStatus: 200 }); };
    await assert.rejects(h.runtime.commandDevice(HOME_A, COVER_A, 'open'));
    assert.match(h.adapter.value(`${devicePath(HOME_A, COVER_A)}.lastError`), /16/);
    assert.equal(h.adapter.value(`${devicePath(HOME_A, COVER_A)}.commandStatus`), 'failed');
});

test('discovery disables controls belonging to a removed product', async t => {
    const h = await createHarness(t).start();
    const target = `${devicePath(HOME_A, COVER_A)}.targetPosition`;
    h.data.topology.homes[0].modules = h.data.topology.homes[0].modules.filter(module => module.id !== COVER_A);
    h.data.statuses.get(HOME_A).home.modules = h.data.statuses.get(HOME_A).home.modules.filter(module => module.id !== COVER_A);
    await h.runtime.refresh(true);
    assert.equal(h.adapter.objects.get(target).common.write, false);
    assert.equal(h.runtime.handlers.has(target), false);
    await h.write(target, 100);
    assert.equal(h.client.calls.setState.length, 0);
});

test('stopping during initial authentication cannot start events, discovery or polling afterwards', async t => {
    const entered = deferred(t);
    const release = deferred(t);
    const h = createHarness(t, { config: { enableEvents: true }, behavior: { login: async () => { entered.resolve(); await release.promise; } } });
    const starting = h.start();
    await entered.promise;
    await h.runtime.stop();
    release.resolve();
    await starting;
    assert.equal(h.client.calls.connectEvents, 0);
    assert.equal(h.client.calls.homesData, 0);
    assert.equal(h.client.calls.homeStatus.length, 0);
    assert.equal(h.runtime.timers.size, 0);
    assert.equal(h.adapter.value('info.connection'), false);
});
