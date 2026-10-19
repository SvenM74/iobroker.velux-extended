'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { HomeModel, safeId } = require('../lib/model');
const { CommandBuilder, matchesExpected } = require('../lib/commands');

const HOME_A = 'home:a';
const HOME_B = 'home:b';
const GATEWAY_A = '70:ee:50:aa:00:01';
const GATEWAY_B = '70:ee:50:bb:00:02';
const ROOM_A = 'room.a';
const ROOM_B = 'room.b';
const BLIND_A = 'blind.a';
const BLIND_B = 'blind.b';
const WINDOW_A = 'window.a';
const WINDOW_B = 'window.b';
const TILT_A = 'venetian.a';
const PLAN_A = 'schedule.a';
const PLAN_B = 'schedule.b';
const NOW = 1700000000123;
const KEY_A = { sign_key_id: 'synthetic-a', hash_sign_key: 'synthetic-secret-a' };
const KEY_B = { sign_key_id: 'synthetic-b', hash_sign_key: 'synthetic-secret-b' };

function topology() {
    return {
        homes: [
            {
                id: HOME_A, name: 'Same home name',
                // Gateways deliberately follow products, so array order cannot be used for routing.
                modules: [
                    { id: BLIND_A, type: 'NXO', name: 'Same product name', velux_type: 'roller_shutter', bridge: GATEWAY_A, room_id: ROOM_A, silent: true },
                    { id: WINDOW_A, type: 'NXO', velux_type: 'window', bridge: GATEWAY_A, room_id: ROOM_A },
                    { id: TILT_A, type: 'NXO', velux_type: 'venetian_blind', bridge: GATEWAY_A, room_id: ROOM_A },
                    { id: 'sensor.a', type: 'NXS', bridge: GATEWAY_A, room_id: ROOM_A },
                    { id: GATEWAY_A, type: 'NXG', firmware_revision_netatmo: 60 },
                ],
                rooms: [{ id: ROOM_A, name: 'Living room', module_ids: [BLIND_A, WINDOW_A, TILT_A, 'sensor.a'] }],
                schedules: [{
                    id: PLAN_A, name: 'Weekdays', type: 'event',
                    zones: [{ id: 1, name: 'Evening', modules: [{ id: BLIND_A, target_position: 0 }] }],
                    timetable: [{ m_offset: 1200, zone_id: 1 }],
                    timetable_sunrise: [{ day: 1, offset: -15, zone_id: 1 }],
                    timetable_sunset: [{ day: 5, offset: 20, zone_id: 1 }],
                }],
            },
            {
                id: HOME_B, name: 'Same home name',
                modules: [
                    { id: BLIND_B, type: 'NXO', name: 'Same product name', velux_type: 'roller_shutter', bridge: GATEWAY_B, room_id: ROOM_B },
                    { id: WINDOW_B, type: 'NXO', velux_type: 'window', bridge: GATEWAY_B, room_id: ROOM_B },
                    { id: GATEWAY_B, type: 'NXG', firmware_revision_netatmo: 59 },
                ],
                rooms: [{ id: ROOM_B, module_ids: [BLIND_B, WINDOW_B] }],
                schedules: [{ id: PLAN_B, name: 'Other home', type: 'event', zones: [], timetable: [] }],
            },
        ],
    };
}

function fixture({ data = topology(), keys, gatewayConfig = () => ({}), ...options } = {}) {
    const model = new HomeModel();
    model.loadTopology({ body: data });
    const signCalls = [];
    const keyLookups = [];
    const signer = {
        sign(input) {
            signCalls.push(input);
            return { [`hash_${input.property}`]: `signature-for-${input.moduleId}`, sign_key_id: input.signingKey.sign_key_id };
        },
    };
    const getSigningKey = keys || ((home, gateway) => {
        if (home === HOME_A && gateway === GATEWAY_A) return KEY_A;
        if (home === HOME_B && gateway === GATEWAY_B) return KEY_B;
        return null;
    });
    const builder = new CommandBuilder({
        model, signer, getSigningKey: (home, gateway) => {
            keyLookups.push([home, gateway]);
            return getSigningKey(home, gateway);
        },
        getGatewayConfig: gatewayConfig, now: () => NOW, ...options,
    });
    return { model, builder, signCalls, keyLookups };
}

function expectCode(callback, code) {
    assert.throws(callback, error => error?.code === code, `Expected ${code}`);
}

test('two homes with identical display names route commands to their own IDs and gateways', () => {
    const { builder } = fixture();
    assert.deepEqual(builder.device(HOME_B, BLIND_B, 'position', 35).payload, {
        home: { id: HOME_B, modules: [{ id: BLIND_B, bridge: GATEWAY_B, target_position: 35, force: false }] },
    });
    assert.deepEqual(builder.device(HOME_A, BLIND_A, 'close').payload, {
        home: { id: HOME_A, modules: [{ id: BLIND_A, bridge: GATEWAY_A, target_position: 0, force: false }] },
    });
    expectCode(() => builder.device(HOME_A, BLIND_B, 'open'), 'UNKNOWN_DEVICE');
    expectCode(() => builder.gateway(HOME_A, GATEWAY_B, 'stopAll'), 'UNKNOWN_DEVICE');
});

test('an explicit foreign bridge is rejected instead of falling back to a convenient gateway', () => {
    const data = topology();
    data.homes[0].modules[0].bridge = GATEWAY_B;
    const { builder } = fixture({ data });
    expectCode(() => builder.device(HOME_A, BLIND_A, 'open'), 'GATEWAY_NOT_FOUND');
});

test('a missing bridge is accepted only when exactly one gateway exists in that home', () => {
    const data = topology();
    delete data.homes[0].modules[0].bridge;
    assert.equal(fixture({ data }).builder.device(HOME_A, BLIND_A, 'open').payload.home.modules[0].bridge, GATEWAY_A);
    data.homes[0].modules.push({ id: 'second-gateway-in-a', type: 'NXG' });
    expectCode(() => fixture({ data }).builder.device(HOME_A, BLIND_A, 'open'), 'AMBIGUOUS_GATEWAY');
});

test('object IDs distinguish punctuation and unicode instead of collapsing device identifiers', () => {
    const ids = ['a.b', 'a_b', 'a:b', 'a/b', 'ä', 'a', '__proto__'];
    const encoded = ids.map(safeId);
    assert.equal(new Set(encoded).size, ids.length);
    for (const id of encoded) assert.match(id, /^id_[A-Za-z0-9_-]+$/);
});

test('partial status updates retain explicit zero and false without losing untouched fields', () => {
    const { model } = fixture();
    model.applyStatus(HOME_A, { home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 75, busy: true, reachable: true }], rooms: [{ id: ROOM_A, auto_close_ts: 123 }] } }, 1000);
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 0, busy: false, silent: false, reachable: false }], rooms: [{ id: ROOM_A, auto_close_ts: 0 }] } }, 2000);
    const module = model.module(HOME_A, BLIND_A);
    assert.equal(module.current_position, 0);
    assert.equal(module.busy, false);
    assert.equal(module.silent, false);
    assert.equal(module.reachable, false);
    assert.equal(module.bridge, GATEWAY_A);
    assert.equal(module.name, 'Same product name');
    assert.equal(model.room(HOME_A, ROOM_A).auto_close_ts, 0);
    assert.equal(model.module(HOME_B, BLIND_B).current_position, undefined);
});

test('an event without a home ID is inferred only from an unambiguous product match', () => {
    const { model } = fixture();
    assert.deepEqual(model.applyEvent({ modules: [{ id: BLIND_B, current_position: 0 }] }, 1000), [HOME_B]);
    assert.equal(model.module(HOME_B, BLIND_B).current_position, 0);
    assert.equal(model.module(HOME_A, BLIND_A).current_position, undefined);
    assert.deepEqual(model.applyEvent({ modules: [{ id: BLIND_A, current_position: 20 }, { id: BLIND_B, current_position: 20 }] }, 2000), []);
    assert.deepEqual(model.applyEvent({ modules: [{ id: 'unknown-product', current_position: 20 }] }, 2000), []);
});

test('an explicitly foreign home event cannot fall back to a matching local product', () => {
    const { model } = fixture();
    const variants = [
        { home: { id: 'foreign-home', modules: [{ id: BLIND_A, current_position: 99 }] } },
        { id: 'foreign-home', modules: [{ id: BLIND_A, current_position: 99 }] },
        { home_id: 'foreign-home', modules: [{ id: BLIND_A, current_position: 99 }] },
    ];
    for (const event of variants) {
        assert.deepEqual(model.applyEvent(event, 2000), []);
        assert.equal(model.module(HOME_A, BLIND_A).current_position, undefined);
    }
});

test('events with contradictory explicit home identifiers are not applied to either home', () => {
    const { model } = fixture();
    assert.deepEqual(model.applyEvent({ home_id: HOME_B, home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 99 }] } }, 2000), []);
    assert.equal(model.module(HOME_A, BLIND_A).current_position, undefined);
    assert.equal(model.module(HOME_B, BLIND_B).current_position, undefined);
});

test('a delayed last_seen update cannot roll back position or flags', () => {
    const { model } = fixture();
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 20, busy: false, last_seen: 200 }] } }, 1000);
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 80, busy: true, last_seen: '199' }] } }, 2000);
    assert.equal(model.module(HOME_A, BLIND_A).current_position, 20);
    assert.equal(model.module(HOME_A, BLIND_A).busy, false);
    assert.equal(model.module(HOME_A, BLIND_A).last_seen, 200);
});

test('event envelope timestamps also suppress delayed changes when last_seen is absent', () => {
    const { model } = fixture();
    model.applyEvent({ timestamp: 400, home: { id: HOME_B, modules: [{ id: BLIND_B, current_position: 25 }] } }, 1000);
    model.applyEvent({ timestamp: 399, home: { id: HOME_B, modules: [{ id: BLIND_B, current_position: 85 }] } }, 2000);
    assert.equal(model.module(HOME_B, BLIND_B).current_position, 25);
    model.applyEvent({ timestamp: 401, home: { id: HOME_B, modules: [{ id: BLIND_B, current_position: 0 }] } }, 3000);
    assert.equal(model.module(HOME_B, BLIND_B).current_position, 0);
});

test('a poll started before an event cannot overwrite its newer fields but may update other fields', () => {
    const { model } = fixture();
    model.applyStatus(HOME_A, { modules: [{ id: BLIND_A, current_position: 70, busy: true }] }, 1000);
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 30 }] } }, 2500);
    model.applyStatus(HOME_A, { modules: [{ id: BLIND_A, current_position: 70, busy: false }] }, 3000, { requestedAt: 2000 });
    assert.equal(model.module(HOME_A, BLIND_A).current_position, 30);
    assert.equal(model.module(HOME_A, BLIND_A).busy, false);
});

test('command confirmation requires a fresh matching target field, not an unrelated module update', () => {
    const { model, builder } = fixture();
    const expected = builder.device(HOME_A, BLIND_A, 'position', 50).expected;
    model.applyStatus(HOME_A, { modules: [{ id: BLIND_A, current_position: 50 }] }, 1000);
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, busy: false }] } }, 3000);
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), false);
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 49 }] } }, 3500);
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), false);
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 50 }] } }, 4000);
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), true);
});

test('a poll started before a command cannot provide fresh confirmation merely by arriving later', () => {
    const { model, builder } = fixture();
    const expected = builder.device(HOME_A, BLIND_A, 'position', 50).expected;
    model.applyStatus(HOME_A, { modules: [{ id: BLIND_A, current_position: 50 }] }, 1000);
    model.applyStatus(HOME_A, { modules: [{ id: BLIND_A, current_position: 50 }] }, 4000, { requestedAt: 1500 });
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), false);
    model.applyStatus(HOME_A, { modules: [{ id: BLIND_A, current_position: 50 }] }, 5000, { requestedAt: 4500 });
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), true);
});

test('a topology request started before an event cannot replace the newer position or its confirmation', () => {
    const { model, builder } = fixture();
    const oldTopology = topology();
    oldTopology.homes[0].modules.find(module => module.id === BLIND_A).current_position = 80;
    const expected = builder.device(HOME_A, BLIND_A, 'position', 20).expected;
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 20 }] } }, 3000);
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), true);
    model.loadTopology(oldTopology, { requestedAt: 1500 });
    assert.equal(model.module(HOME_A, BLIND_A).current_position, 20);
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), true);
});

test('a changed topology value cannot inherit freshness from an earlier event to confirm a command', () => {
    const { model, builder } = fixture();
    const expected = builder.device(HOME_A, BLIND_A, 'position', 80).expected;
    model.applyEvent({ home: { id: HOME_A, modules: [{ id: BLIND_A, current_position: 20 }] } }, 3000);
    const discovered = topology();
    discovered.homes[0].modules.find(module => module.id === BLIND_A).current_position = 80;
    model.loadTopology(discovered, { requestedAt: 4000 });
    assert.equal(model.module(HOME_A, BLIND_A).current_position, 80);
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), false);
    model.applyStatus(HOME_A, { modules: [{ id: BLIND_A, current_position: 80 }] }, 5000, { requestedAt: 4500 });
    assert.equal(matchesExpected(model, HOME_A, expected, 2000), true);
});

test('position commands enforce integer percentages and keep individual stop out of the position range', () => {
    const { builder } = fixture();
    for (const position of [0, 37, 100]) assert.equal(builder.device(HOME_A, BLIND_A, 'position', position).payload.home.modules[0].target_position, position);
    for (const position of [-1, 101, 50.5, NaN, Infinity, '50', null, true]) expectCode(() => builder.device(HOME_A, BLIND_A, 'position', position), 'INVALID_VALUE');
    assert.equal(builder.device(HOME_A, BLIND_A, 'open').payload.home.modules[0].target_position, 100);
    assert.equal(builder.device(HOME_A, BLIND_A, 'close').payload.home.modules[0].target_position, 0);
});

test('only an opted-in individual stop uses -1, and window stop still requires a key', () => {
    expectCode(() => fixture().builder.device(HOME_A, BLIND_A, 'stop'), 'INDIVIDUAL_STOP_DISABLED');
    const { builder, signCalls } = fixture({ allowIndividualStop: true });
    const blind = builder.device(HOME_A, BLIND_A, 'stop');
    assert.equal(blind.payload.home.modules[0].target_position, -1);
    assert.deepEqual(blind.expected, []);
    assert.equal(signCalls.length, 0);
    builder.device(HOME_A, WINDOW_A, 'stop');
    assert.equal(signCalls[0].property, 'target_position');
    assert.equal(signCalls[0].value, -1);
    expectCode(() => fixture({ allowIndividualStop: true, keys: () => null }).builder.device(HOME_A, WINDOW_A, 'stop'), 'PAIRING_REQUIRED');
});

test('window opening signs with the correct home key, while closing and blind movements stay unsigned', () => {
    const { builder, signCalls, keyLookups } = fixture();
    const command = builder.device(HOME_B, WINDOW_B, 'position', 40);
    assert.equal(command.payload.home.id, HOME_B);
    assert.equal(command.payload.home.modules[0].bridge, GATEWAY_B);
    assert.equal(command.payload.home.modules[0].hash_target_position, `signature-for-${WINDOW_B}`);
    assert.deepEqual(keyLookups, [[HOME_B, GATEWAY_B]]);
    assert.equal(signCalls[0].signingKey, KEY_B);
    builder.device(HOME_A, WINDOW_A, 'close');
    builder.device(HOME_A, BLIND_A, 'open');
    assert.equal(signCalls.length, 1);
    assert.doesNotThrow(() => fixture({ keys: () => null }).builder.device(HOME_A, WINDOW_A, 'close'));
});

test('automatic signing selects firmware boundaries and never borrows another gateway key', () => {
    for (const [revision, expected] of [[27, 'sha512'], [59, 'sha512'], [60, 'hmac'], ['61', 'hmac']]) {
        const { model, builder, signCalls } = fixture();
        model.module(HOME_A, GATEWAY_A).firmware_revision_netatmo = revision;
        builder.device(HOME_A, WINDOW_A, 'open');
        assert.equal(signCalls[0].scheme, expected);
    }
    for (const revision of [26, undefined]) {
        const { model, builder } = fixture();
        model.module(HOME_A, GATEWAY_A).firmware_revision_netatmo = revision;
        expectCode(() => builder.device(HOME_A, WINDOW_A, 'open'), 'UNKNOWN_SIGNING_SCHEME');
    }
    const explicit = fixture({ gatewayConfig: () => ({ signingScheme: 'sha512' }) });
    delete explicit.model.module(HOME_A, GATEWAY_A).firmware_revision_netatmo;
    explicit.builder.device(HOME_A, WINDOW_A, 'open');
    assert.equal(explicit.signCalls[0].scheme, 'sha512');
    const noOtherKey = fixture({ keys: (home, gateway) => home === HOME_A && gateway === GATEWAY_A ? KEY_A : null });
    expectCode(() => noOtherKey.builder.device(HOME_B, WINDOW_B, 'open'), 'PAIRING_REQUIRED');
});

test('gateway stop is unsigned and scenario signing covers only home and start_airing', () => {
    const { builder, signCalls } = fixture();
    assert.deepEqual(builder.gateway(HOME_B, GATEWAY_B, 'stopAll').payload, { home: { id: HOME_B, modules: [{ id: GATEWAY_B, stop_movements: 'all' }] } });
    for (const scenario of ['bedtime', 'wake_up', 'away', 'stop_airing']) {
        assert.deepEqual(builder.gateway(HOME_A, GATEWAY_A, 'scenario', scenario).payload, { home: { id: HOME_A, modules: [{ id: GATEWAY_A, scenario }] } });
    }
    assert.equal(signCalls.length, 0);
    for (const scenario of ['home', 'start_airing']) {
        const module = builder.gateway(HOME_A, GATEWAY_A, 'scenario', scenario).payload.home.modules[0];
        assert.equal(module.scenario, scenario);
        assert.equal(module.hash_scenario, `signature-for-${GATEWAY_A}`);
    }
    assert.deepEqual(signCalls.map(call => [call.moduleId, call.property, call.value]), [[GATEWAY_A, 'scenario', 'home'], [GATEWAY_A, 'scenario', 'start_airing']]);
    expectCode(() => builder.gateway(HOME_A, GATEWAY_A, 'scenario', 'stop'), 'INVALID_VALUE');
    expectCode(() => fixture({ keys: () => null }).builder.gateway(HOME_A, GATEWAY_A, 'scenario', 'home'), 'PAIRING_REQUIRED');
});

test('silent mode is a boolean command only for devices that report the capability', () => {
    const { builder } = fixture();
    assert.deepEqual(builder.device(HOME_A, BLIND_A, 'silent', false).payload, { home: { id: HOME_A, modules: [{ id: BLIND_A, bridge: GATEWAY_A, silent: false }] } });
    expectCode(() => builder.device(HOME_B, BLIND_B, 'silent', true), 'UNSUPPORTED');
    expectCode(() => builder.device(HOME_A, BLIND_A, 'silent', 'false'), 'INVALID_VALUE');
});

test('tilt commands require a venetian blind and supported firmware and preserve negative and positive angles', () => {
    const { model, builder } = fixture();
    for (const angle of [-90, 0, 90]) assert.equal(builder.device(HOME_A, TILT_A, 'orientation', angle).payload.home.modules[0].target_orientation, angle);
    for (const angle of [-91, 91, 0.5, '30', NaN]) expectCode(() => builder.device(HOME_A, TILT_A, 'orientation', angle), 'INVALID_VALUE');
    expectCode(() => builder.device(HOME_A, BLIND_A, 'orientation', 0), 'UNSUPPORTED');
    model.module(HOME_A, GATEWAY_A).firmware_revision_netatmo = 54;
    expectCode(() => builder.device(HOME_A, TILT_A, 'orientation', 0), 'UNSUPPORTED');
    model.module(HOME_A, GATEWAY_A).firmware_revision_netatmo = 55;
    assert.equal(builder.device(HOME_A, TILT_A, 'orientation', -30).payload.home.modules[0].target_orientation, -30);
});

test('cover groups exclude windows and sensors; tilt groups select only capable products', () => {
    const { builder } = fixture();
    const covers = builder.group(HOME_A, ROOM_A, 'covers', 'position', 35).payload.home;
    assert.equal(covers.id, HOME_A);
    assert.deepEqual(covers.modules, [
        { id: BLIND_A, bridge: GATEWAY_A, target_position: 35, force: false },
        { id: TILT_A, bridge: GATEWAY_A, target_position: 35, force: false },
    ]);
    const tilt = builder.group(HOME_A, ROOM_A, 'covers', 'orientation', -25).payload.home.modules;
    assert.deepEqual(tilt, [{ id: TILT_A, bridge: GATEWAY_A, target_orientation: -25 }]);
    expectCode(() => builder.group(HOME_A, ROOM_A, 'does-not-exist', 'open'), 'EMPTY_GROUP');
});

test('a group with a later invalid member fails as a whole instead of returning a partial payload', () => {
    const data = topology();
    data.homes[0].modules.push(
        { id: 'unpaired-gateway', type: 'NXG', firmware_revision_netatmo: 60 },
        { id: 'unpaired-window', type: 'NXO', velux_type: 'window', bridge: 'unpaired-gateway', room_id: ROOM_A },
    );
    const { model, builder } = fixture({ data });
    const before = model.snapshot(HOME_A);
    expectCode(() => builder.group(HOME_A, ROOM_A, 'windows', 'open'), 'PAIRING_REQUIRED');
    assert.deepEqual(model.snapshot(HOME_A), before);
});

test('room automation writes the documented modes and confirms a freshly active algorithm', () => {
    const { model, builder } = fixture();
    const automatic = builder.room(HOME_A, ROOM_A, 'automation', true);
    assert.deepEqual(automatic.payload, { home: { id: HOME_A, rooms: [{ id: ROOM_A, mode: 'algo_available' }] } });
    assert.deepEqual(builder.room(HOME_A, ROOM_A, 'automation', false).payload, { home: { id: HOME_A, rooms: [{ id: ROOM_A, mode: 'manual' }] } });
    model.applyStatus(HOME_A, { rooms: [{ id: ROOM_A, mode: 'algo_active' }] }, 3000);
    assert.equal(matchesExpected(model, HOME_A, automatic.expected, 2000), true);
    expectCode(() => builder.room(HOME_A, ROOM_A, 'automation', 'algo_disabled'), 'INVALID_VALUE');
});

test('room close timers use Unix seconds and every cancel form preserves zero', () => {
    const { builder } = fixture();
    assert.deepEqual(builder.room(HOME_A, ROOM_A, 'autoCloseMinutes', 15).payload, { home: { id: HOME_A, rooms: [{ id: ROOM_A, auto_close_ts: 1700000900 }] } });
    for (const action of ['autoCloseMinutes', 'autoCloseAt', 'cancelAutoClose']) {
        assert.deepEqual(builder.room(HOME_A, ROOM_A, action, 0).payload, { home: { id: HOME_A, rooms: [{ id: ROOM_A, auto_close_ts: 0 }] } });
    }
    for (const value of [-1, 1441, 1.5, '15']) expectCode(() => builder.room(HOME_A, ROOM_A, 'autoCloseMinutes', value), 'INVALID_VALUE');
    for (const value of [1700000000, NOW, 1700086401]) expectCode(() => builder.room(HOME_A, ROOM_A, 'autoCloseAt', value), 'INVALID_VALUE');
    assert.equal(builder.room(HOME_A, ROOM_A, 'autoCloseAt', 1700086400).payload.home.rooms[0].auto_close_ts, 1700086400);
});

test('timed window opening combines signed module positions with one room timer in the same home', () => {
    const { builder } = fixture();
    const command = builder.group(HOME_A, ROOM_A, 'windows', 'position', 30, 15);
    assert.equal(command.payload.home.id, HOME_A);
    assert.deepEqual(command.payload.home.rooms, [{ id: ROOM_A, auto_close_ts: 1700000900 }]);
    assert.deepEqual(command.payload.home.modules, [{ id: WINDOW_A, bridge: GATEWAY_A, target_position: 30, force: false, hash_target_position: `signature-for-${WINDOW_A}`, sign_key_id: KEY_A.sign_key_id }]);
    expectCode(() => builder.group(HOME_A, ROOM_A, 'covers', 'open', undefined, 15), 'INVALID_VALUE');
});

test('schedule updates retain sunrise and sunset tables and nested product definitions', () => {
    const { model, builder } = fixture();
    const original = structuredClone(model.home(HOME_A).schedules.get(PLAN_A));
    const update = builder.schedule(HOME_A, 'update', { schedule_id: PLAN_A, name: 'New name', home_id: HOME_B });
    assert.equal(update.home_id, HOME_A);
    assert.equal(update.schedule_id, PLAN_A);
    assert.equal(update.name, 'New name');
    assert.equal(update.schedule_type, 'event');
    for (const field of ['zones', 'timetable', 'timetable_sunrise', 'timetable_sunset']) assert.deepEqual(update[field], original[field]);
    assert.deepEqual(model.home(HOME_A).schedules.get(PLAN_A), original);
});

test('schedule creation preserves provided solar tables but cannot change the routed home or assign an existing ID', () => {
    const { builder } = fixture();
    const input = {
        home_id: HOME_B, schedule_id: PLAN_B, name: 'Evening', schedule_type: 'event',
        zones: [{ id: 2, modules: [{ id: BLIND_A, target_position: 0 }] }],
        timetable: [], timetable_sunrise: [], timetable_sunset: [{ day: 3, offset: -10, zone_id: 2 }],
    };
    const created = builder.schedule(HOME_A, 'create', JSON.stringify(input));
    assert.equal(created.home_id, HOME_A);
    assert.equal(created.schedule_id, undefined);
    assert.deepEqual(created.zones, input.zones);
    assert.deepEqual(created.timetable_sunrise, []);
    assert.deepEqual(created.timetable_sunset, input.timetable_sunset);
});

test('rename, switch and delete target only a schedule belonging to the chosen home', () => {
    const { builder } = fixture();
    assert.deepEqual(builder.schedule(HOME_A, 'rename', { schedule_id: PLAN_A, name: '  Renamed  ', home_id: HOME_B }), { home_id: HOME_A, schedule_id: PLAN_A, name: 'Renamed' });
    assert.deepEqual(builder.schedule(HOME_A, 'switch', { schedule_id: PLAN_A }), { home_id: HOME_A, schedule_id: PLAN_A, schedule_type: 'event' });
    assert.deepEqual(builder.schedule(HOME_A, 'delete', { schedule_id: PLAN_A }), { home_id: HOME_A, schedule_id: PLAN_A });
    for (const action of ['update', 'rename', 'delete', 'switch']) expectCode(() => builder.schedule(HOME_A, action, { schedule_id: PLAN_B, name: 'Wrong home' }), 'UNKNOWN_SCHEDULE');
});

test('schedule validation rejects unsupported schemas instead of coercing them into a plan', () => {
    const { builder } = fixture();
    for (const input of [
        { name: 'Plan', schedule_type: 'cron', zones: [], timetable: [] },
        { name: 'Plan', schedule_type: 'event', zones: {}, timetable: [] },
        { name: 'Plan', schedule_type: 'event', zones: [], timetable: '08:00' },
        { name: '', schedule_type: 'event', zones: [], timetable: [] },
    ]) expectCode(() => builder.schedule(HOME_A, 'create', input), 'INVALID_VALUE');
    expectCode(() => builder.schedule(HOME_A, 'create', '{broken'), 'INVALID_VALUE');
});
