'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { VeluxClient, VeluxApiError } = require('../lib/client');

const USERNAME = 'user@example.invalid';
const PASSWORD = 'test-private-password';
const ACCESS = 'test-access-token-one';
const REFRESH = 'test-refresh-token-one';
const ACCESS_TWO = 'test-access-token-two';
const REFRESH_TWO = 'test-refresh-token-two';
const STOP = { home: { id: 'home-one', modules: [{ id: 'gateway-one', stop_movements: 'all' }] } };

function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status, headers: { 'Content-Type': 'application/json', ...headers },
    });
}

function tokenResponse(extra = {}) {
    return jsonResponse({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, ...extra });
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function clientWith(t, responses, options = {}) {
    const calls = [];
    const queue = [...responses];
    const fetchImpl = async (url, init) => {
        const call = { url: new URL(url), ...init };
        calls.push(call);
        assert.ok(queue.length, `Unexpected HTTP request: ${call.url.pathname}`);
        const value = queue.shift();
        if (typeof value === 'function') return value(call);
        if (value instanceof Error) throw value;
        return value;
    };
    const client = new VeluxClient({ username: USERNAME, password: PASSWORD, fetchImpl, ...options });
    t.after(() => client.close());
    return { client, calls, queue };
}

function fakeWebSockets() {
    return class FakeWebSocket extends EventTarget {
        static instances = [];

        constructor(url) {
            super();
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            this.closeCalls = 0;
            this.constructor.instances.push(this);
        }

        dispatch(type, props = {}) {
            const event = new Event(type);
            for (const [key, value] of Object.entries(props)) Object.defineProperty(event, key, { value });
            this.dispatchEvent(event);
        }

        open() {
            this.readyState = 1;
            this.dispatch('open');
        }

        send(data) {
            assert.equal(this.readyState, 1);
            this.sent.push(JSON.parse(data));
        }

        message(data) {
            this.dispatch('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
        }

        fail(message = 'Connection lost') {
            this.dispatch('error', { error: new Error(message) });
        }

        close() {
            this.closeCalls++;
            this.readyState = 3;
            this.dispatch('close');
        }
    };
}

test('password OAuth uses the VELUX application identity and reports rotated tokens with real expiry', async t => {
    const { client, calls } = clientWith(t, [tokenResponse({ expires_in: 120 }), jsonResponse({ status: 'ok', body: { homes: [] } })]);
    const tokens = [];
    const auth = [];
    client.on('tokens', value => tokens.push(value));
    client.on('authStatus', value => auth.push(value));
    const before = Date.now();
    const login = await client.login();
    const after = Date.now();
    assert.equal(login.accessToken, ACCESS);
    assert.equal(login.refreshToken, REFRESH);
    assert.ok(login.expiresAt >= before + 120000 && login.expiresAt <= after + 120000);
    assert.deepEqual(tokens, [login]);
    assert.deepEqual(auth, [true]);
    const form = new URLSearchParams(calls[0].body);
    assert.equal(calls[0].url.href, 'https://app.velux-active.com/oauth2/token');
    assert.equal(calls[0].headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(calls[0].headers.Authorization, undefined);
    assert.equal(calls[0].redirect, 'error');
    assert.deepEqual(Object.fromEntries(form), {
        client_id: '5931426da127d981e76bdd3f', client_secret: '6ae2d89d15e767ae5c56b456b452d319',
        app_version: '791304000', version: '791304000', scope: 'velux_scopes', user_prefix: 'velux',
        grant_type: 'password', username: USERNAME, password: PASSWORD,
    });
    assert.deepEqual(await client.homesData(), { homes: [] });
    assert.equal(calls[1].url.pathname, '/api/homesdata');
    assert.equal(calls[1].headers.Authorization, `Bearer ${ACCESS}`);
    assert.deepEqual(JSON.parse(calls[1].body), { app_type: 'app_velux', app_version: '791304000' });
    assert.equal(tokens.length, 1, 'a valid token is reused');
});

test('stored refresh tokens take precedence and simultaneous logins share one HTTP request', async t => {
    const ready = deferred();
    const { client, calls } = clientWith(t, [() => ready.promise], { refreshToken: REFRESH });
    const requests = [client.login(), client.login(), client.login()];
    assert.equal(calls.length, 1);
    ready.resolve(tokenResponse({ access_token: ACCESS_TWO, refresh_token: REFRESH_TWO }));
    const results = await Promise.all(requests);
    assert.ok(results.every(result => result.accessToken === ACCESS_TWO && result.refreshToken === REFRESH_TWO));
    const form = new URLSearchParams(calls[0].body);
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), REFRESH);
    assert.equal(form.has('password'), false);
    assert.equal(form.has('username'), false);
});

test('only a rejected refresh token falls back to password authentication', async t => {
    const { client, calls } = clientWith(t, [
        jsonResponse({ error: 'invalid_grant', error_description: 'Refresh has expired' }, 400), tokenResponse(),
    ], { refreshToken: 'expired-refresh-token' });
    await client.login();
    assert.deepEqual(calls.map(call => new URLSearchParams(call.body).get('grant_type')), ['refresh_token', 'password']);

    const temporary = clientWith(t, [jsonResponse({ error: { code: 500, message: 'Temporarily unavailable' } }, 500)], { refreshToken: REFRESH });
    await assert.rejects(temporary.client.login(), error => error.httpStatus === 500);
    assert.equal(temporary.calls.length, 1);
});

test('expired credentials fail without making unauthenticated API calls', async t => {
    const { client, calls } = clientWith(t, [], { username: '', password: '' });
    await assert.rejects(client.homeStatus('home-one'), { code: 'CREDENTIALS_REQUIRED' });
    assert.equal(calls.length, 0);
});

test('server token lifetime drives proactive refresh instead of a fixed interval', async t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
    const { client, calls } = clientWith(t, [
        tokenResponse({ expire_in: 10, expires_in: undefined }),
        jsonResponse({ body: { home: { id: 'home-one' } } }),
        tokenResponse({ access_token: ACCESS_TWO, refresh_token: REFRESH_TWO }),
        jsonResponse({ body: { home: { id: 'home-two' } } }),
    ]);
    const tokens = await client.login();
    assert.equal(tokens.expiresAt, 1700000010000);
    t.mock.timers.tick(8000);
    await client.homeStatus('home-one');
    assert.equal(calls.length, 2);
    t.mock.timers.tick(1100);
    await client.homeStatus('home-two');
    assert.equal(calls.length, 4);
    assert.equal(new URLSearchParams(calls[2].body).get('refresh_token'), REFRESH);
    assert.equal(calls[3].headers.Authorization, `Bearer ${ACCESS_TWO}`);
    assert.deepEqual(JSON.parse(calls[3].body), { home_id: 'home-two', app_version: '791304000' });
});

test('an unambiguous HTTP 401 refreshes and resends the same mutation once', async t => {
    const { client, calls } = clientWith(t, [
        tokenResponse(), jsonResponse({ error: { code: 2, message: 'Access token expired' } }, 401),
        tokenResponse({ access_token: ACCESS_TWO, refresh_token: REFRESH_TWO }), jsonResponse({ status: 'ok', body: { accepted: true } }),
    ]);
    assert.deepEqual(await client.setState(STOP), { accepted: true });
    assert.deepEqual(calls.map(call => call.url.pathname), ['/oauth2/token', '/syncapi/v1/setstate', '/oauth2/token', '/syncapi/v1/setstate']);
    assert.equal(calls[1].body, calls[3].body);
    assert.equal(calls[1].headers.Authorization, `Bearer ${ACCESS}`);
    assert.equal(calls[3].headers.Authorization, `Bearer ${ACCESS_TWO}`);
    assert.deepEqual(JSON.parse(calls[3].body), { app_type: 'app_velux', app_version: '791304000', ...STOP });
});

test('a second HTTP 401 ends the request instead of repeating refresh or mutation indefinitely', async t => {
    const { client, calls } = clientWith(t, [
        tokenResponse(), jsonResponse({ error: 'expired' }, 401),
        tokenResponse({ access_token: ACCESS_TWO }), jsonResponse({ error: 'denied' }, 401),
    ]);
    const statuses = [];
    client.on('authStatus', value => statuses.push(value));
    await assert.rejects(client.setState(STOP), error => error instanceof VeluxApiError && error.httpStatus === 401);
    assert.equal(calls.length, 4);
    assert.deepEqual(statuses, [true, false, true, false]);
});

test('concurrent HTTP 401 responses refresh the token once and route each home correctly', async t => {
    const rejected = deferred();
    const refreshed = deferred();
    const { client, calls } = clientWith(t, [
        tokenResponse(), () => rejected.promise, () => rejected.promise,
        () => refreshed.promise, jsonResponse({ body: { id: 'home-one' } }), jsonResponse({ body: { id: 'home-two' } }),
    ]);
    await client.login();
    const first = client.homeStatus('home-one');
    const second = client.homeStatus('home-two');
    await nextTurn();
    // A response body is one-shot; give each request its own HTTP response.
    rejected.resolve({ ok: false, status: 401, headers: new Headers(), text: async () => '{"error":"expired"}' });
    await nextTurn();
    assert.equal(calls.length, 4);
    refreshed.resolve(tokenResponse({ access_token: ACCESS_TWO }));
    await Promise.all([first, second]);
    assert.equal(calls.filter(call => call.url.pathname === '/oauth2/token').length, 2);
    assert.deepEqual(calls.slice(4).map(call => JSON.parse(call.body).home_id).sort(), ['home-one', 'home-two']);
    assert.ok(calls.slice(4).every(call => call.headers.Authorization === `Bearer ${ACCESS_TWO}`));
});

test('an old 401 arriving after token rotation reuses the new token without another refresh', async t => {
    const late = deferred();
    const { client, calls } = clientWith(t, [
        tokenResponse(), () => late.promise, jsonResponse({ error: 'expired' }, 401),
        tokenResponse({ access_token: ACCESS_TWO }), jsonResponse({ body: { id: 'home-two' } }),
        jsonResponse({ body: { id: 'home-one' } }),
    ]);
    await client.login();
    const first = client.homeStatus('home-one');
    await nextTurn();
    await client.homeStatus('home-two');
    late.resolve(jsonResponse({ error: 'expired' }, 401));
    await first;
    assert.equal(calls.filter(call => call.url.pathname === '/oauth2/token').length, 2);
    assert.equal(calls.at(-1).headers.Authorization, `Bearer ${ACCESS_TWO}`);
});

test('HTTP 200 device errors are surfaced with code and metadata and never trigger retries', async t => {
    const errors = [{ id: 'gateway-one', code: 401, message: 'Command denied', module_id: 'window-one' }];
    const { client, calls } = clientWith(t, [tokenResponse(), jsonResponse({ status: 'ok', body: { errors } })]);
    await assert.rejects(client.setState(STOP), error => {
        assert.equal(error.name, 'VeluxApiError');
        assert.equal(error.code, 401);
        assert.equal(error.httpStatus, 200);
        assert.equal(error.message, 'Command denied');
        assert.deepEqual(error.errors, errors);
        return true;
    });
    assert.equal(calls.length, 2);
});

test('HTTP 403 invalid-token errors invalidate credentials for the next call without replaying a mutation', async t => {
    const { client, calls } = clientWith(t, [
        tokenResponse(), jsonResponse({ error: { code: 3, message: 'Invalid access token' } }, 403),
        tokenResponse({ access_token: ACCESS_TWO }), jsonResponse({ body: { homes: [] } }),
    ]);
    await assert.rejects(client.setState(STOP), error => error.httpStatus === 403);
    assert.equal(calls.length, 2, 'the mutation is not repeated on HTTP 403');
    await client.homesData();
    assert.equal(calls[2].url.pathname, '/oauth2/token');
    assert.equal(calls[3].headers.Authorization, `Bearer ${ACCESS_TWO}`);
    assert.equal(calls.filter(call => call.url.pathname === '/syncapi/v1/setstate').length, 1);

    const forbidden = clientWith(t, [tokenResponse(), jsonResponse({ error: { code: 21, message: 'Permission denied' } }, 403), jsonResponse({ body: { homes: [] } })]);
    await assert.rejects(forbidden.client.setState(STOP), error => error.httpStatus === 403);
    await forbidden.client.homesData();
    assert.equal(forbidden.calls.filter(call => call.url.pathname === '/oauth2/token').length, 1, 'other permission errors do not invalidate credentials');
});

test('error messages, codes, stacks and nested data redact account credentials and signing material', async t => {
    const signingSecret = 'sensitive-signing-material';
    const message = `${USERNAME} ${PASSWORD} ${ACCESS} ${REFRESH} ${signingSecret} Bearer unknown-credential`;
    const { client } = clientWith(t, [tokenResponse(), jsonResponse({
        status: 'error', body: { errors: [{ code: `rejected-${ACCESS}`, message, nested: { access_token: ACCESS, sign_key: signingSecret } }] },
    }, 400)]);
    await assert.rejects(client.setState({ home: { id: 'home-one', modules: [{ id: 'window-one', sign_key: signingSecret }] } }), error => {
        const visible = `${error.stack} ${JSON.stringify(error)}`;
        for (const secret of [USERNAME, PASSWORD, ACCESS, REFRESH, signingSecret, 'unknown-credential']) assert.ok(!visible.includes(secret));
        assert.ok(visible.includes('[REDACTED]'));
        assert.equal(Object.hasOwn(error, 'body'), false);
        assert.equal(Object.hasOwn(error, 'cause'), false);
        return true;
    });
});

test('rate limits and server errors never automatically repeat a mutation', async t => {
    for (const status of [429, 500, 503]) {
        const { client, calls } = clientWith(t, [tokenResponse(), jsonResponse({ error: { code: 'busy', message: 'Try later' } }, status, { 'Retry-After': '12' })]);
        await assert.rejects(client.setState(STOP), error => error.httpStatus === status && error.retryAfterMs === 12000);
        assert.equal(calls.length, 2);
    }
});

test('network failures are redacted and mutations are not repeated', async t => {
    const { client, calls } = clientWith(t, [tokenResponse(), new Error(`Connection interrupted for Bearer ${ACCESS}`)]);
    await assert.rejects(client.setState(STOP), error => error.code === 'NETWORK_ERROR' && !error.message.includes(ACCESS));
    assert.equal(calls.length, 2);
});

test('timeouts abort a pending HTTP body and do not retry an uncertain mutation', async t => {
    const never = new Promise(() => {});
    const { client, calls } = clientWith(t, [tokenResponse(), { ok: true, status: 200, text: () => never }], { requestTimeoutMs: 25 });
    await assert.rejects(client.setState(STOP), { code: 'TIMEOUT' });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].signal.aborted, true);
});

test('close aborts outstanding HTTP immediately and prevents later calls', async t => {
    const { client, calls } = clientWith(t, [tokenResponse(), () => new Promise(() => {})]);
    await client.login();
    const pending = client.setState(STOP);
    const rejection = assert.rejects(pending, { code: 'CLIENT_CLOSED' });
    await nextTurn();
    client.close();
    client.close();
    await rejection;
    assert.equal(calls.at(-1).signal.aborted, true);
    await assert.rejects(client.homesData(), { code: 'CLIENT_CLOSED' });
    assert.equal(calls.length, 2);
});

test('a non-JSON HTTP 401 can refresh but other malformed API responses fail clearly', async t => {
    const { client, calls } = clientWith(t, [
        tokenResponse(), new Response('Unauthorized', { status: 401 }), tokenResponse({ access_token: ACCESS_TWO }),
        jsonResponse({ status: 'ok' }), new Response('Private server diagnostics', { status: 502 }),
    ]);
    assert.deepEqual(await client.setState(STOP), { status: 'ok' });
    await assert.rejects(client.homesData(), error => error.code === 'INVALID_RESPONSE' && error.httpStatus === 502 && !error.message.includes('Private'));
    assert.equal(calls.length, 5);
});

test('configuration requests use the verified getconfigs query and setconfigs home wrapper', async t => {
    const config = { modules: [{ id: 'sensor-one', bridge: 'gateway-one', controlled_openers: 'windows' }] };
    const { client, calls } = clientWith(t, [tokenResponse(), jsonResponse({ body: { home: config } }), jsonResponse({ body: { applied: true } }), jsonResponse({ status: 'ok' })]);
    assert.deepEqual(await client.getConfigs('home/one'), { home: config });
    assert.equal(calls[1].method, 'GET');
    assert.equal(calls[1].url.pathname, '/syncapi/v1/getconfigs');
    assert.equal(calls[1].url.searchParams.get('home_id'), 'home/one');
    assert.equal(calls[1].body, undefined);
    assert.deepEqual(await client.setConfigs('home-one', config), { applied: true });
    assert.equal(calls[2].url.pathname, '/syncapi/v1/setconfigs');
    assert.deepEqual(JSON.parse(calls[2].body), { home_id: 'home-one', home: config });
    await client.setConfigs('home-one', { home: config });
    assert.equal(calls[2].body, calls[3].body);
    await assert.rejects(client.setConfigs('home-one', { home_id: 'another-home', home: config }), { code: 'INVALID_ARGUMENT' });
    assert.equal(calls.length, 4);
});

test('all five native schedule operations preserve their APK endpoint and JSON field shape', async t => {
    const schedule = {
        home_id: 'home-one', name: 'Morning', schedule_type: 'velux',
        zones: [{ id: 1, name: 'Day', rooms: [{ id: 'room-one', modules: [{ id: 'cover-one', target_position: 80 }] }] }],
        timetable: [{ m_offset: 420, zone_id: 1 }], timetable_sunrise: [{ day_id: 1, zone_id: 1, sun_offset: 0 }],
        timetable_sunset: [], timezone: 'Europe/Berlin',
    };
    const responses = Array.from({ length: 6 }, () => jsonResponse({ status: 'ok' }));
    const { client, calls } = clientWith(t, [tokenResponse(), ...responses]);
    await client.schedule('create', { ...schedule, schedule_id: 'copy-of-existing' });
    await client.schedule('update', { ...schedule, schedule_id: 'schedule-one' });
    await client.schedule('rename', { home_id: 'home-one', schedule_id: 'schedule-one', name: 'Evening' });
    await client.schedule('delete', { home_id: 'home-one', schedule_id: 'schedule-one' });
    await client.schedule('switch', { home_id: 'home-one', schedule_id: 'schedule-two', schedule_type: 'velux' });
    await client.schedule('switch', { home_id: 'home-one', schedule_type: 'velux' });
    assert.deepEqual(calls.slice(1).map(call => call.url.pathname), [
        '/api/createnewhomeschedule', '/api/synchomeschedule', '/api/renamehomeschedule',
        '/api/deletehomeschedule', '/api/switchhomeschedule', '/api/switchhomeschedule',
    ]);
    assert.deepEqual(JSON.parse(calls[1].body), schedule);
    assert.deepEqual(JSON.parse(calls[2].body), { ...schedule, schedule_id: 'schedule-one' });
    assert.deepEqual(JSON.parse(calls[3].body), { home_id: 'home-one', schedule_id: 'schedule-one', name: 'Evening' });
    assert.deepEqual(JSON.parse(calls[4].body), { home_id: 'home-one', schedule_id: 'schedule-one' });
    assert.deepEqual(JSON.parse(calls[6].body), { home_id: 'home-one', schedule_type: 'velux' });
    assert.ok(calls.slice(1).every(call => call.method === 'POST' && call.headers['Content-Type'].startsWith('application/json')));
    await assert.rejects(client.schedule('unknown', {}), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(client.schedule('update', schedule), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(client.schedule('create', { ...schedule, zones: JSON.stringify(schedule.zones) }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(client.schedule('switch', { home_id: 'home-one' }), { code: 'INVALID_ARGUMENT' });
    assert.equal(calls.length, 7);
});

test('event stream sends the Android subscription and preserves complete embedded home deltas', async t => {
    const WebSocketImpl = fakeWebSockets();
    const { client } = clientWith(t, [tokenResponse()], { WebSocketImpl });
    const statuses = [];
    const updates = [];
    client.on('streamStatus', value => statuses.push(value));
    client.on('update', value => updates.push(value));
    await client.connectEvents();
    await client.connectEvents();
    assert.equal(WebSocketImpl.instances.length, 1);
    const socket = WebSocketImpl.instances[0];
    assert.equal(socket.url, 'wss://app.velux-active.com/ws/');
    socket.open();
    assert.deepEqual(socket.sent, [{ action: 'Subscribe', filter: 'silent', access_token: ACCESS, app_type: 'app_velux', platform: 'Android', version: '791304000' }]);
    assert.deepEqual(statuses, []);
    socket.message({ status: 'ok' });
    const first = { home: { id: 'home-one', modules: [{ id: 'cover-one', current_position: 37 }] }, timestamp: 1700000000, sequence: 42 };
    const second = { home: { id: 'home-two', rooms: [{ id: 'room-one', humidity: 51 }] }, sequence: 43 };
    socket.message({ push_type: 'embedded_json', extra_params: JSON.stringify(first), sequence: 999 });
    socket.message({ push_type: 'embedded_json', extra_params: second });
    socket.message('{');
    socket.message({ push_type: 'other', extra_params: first });
    socket.message({ push_type: 'embedded_json', extra_params: 'not-json' });
    socket.message({ push_type: 'embedded_json', extra_params: [] });
    assert.deepEqual(updates, [first, second]);
    assert.deepEqual(statuses, [true]);
    client.close();
    assert.deepEqual(statuses, [true, false]);
    assert.equal(socket.closeCalls, 1);
});

test('binary and Blob WebSocket messages are accepted without altering the embedded payload', async t => {
    const WebSocketImpl = fakeWebSockets();
    const { client } = clientWith(t, [tokenResponse()], { WebSocketImpl });
    const updates = [];
    client.on('update', value => updates.push(value));
    await client.connectEvents();
    const socket = WebSocketImpl.instances[0];
    const payload = { home: { id: 'home-one' }, sequence: { gateway: 7 } };
    const text = JSON.stringify({ push_type: 'embedded_json', extra_params: payload });
    socket.dispatch('message', { data: new TextEncoder().encode(text) });
    socket.dispatch('message', { data: new Blob([text]) });
    await nextTurn();
    assert.deepEqual(updates, [payload, payload]);
});

test('event stream reconnects with bounded backoff, ignores stale socket errors and stops on close', async t => {
    const WebSocketImpl = fakeWebSockets();
    const { client } = clientWith(t, [tokenResponse()], { WebSocketImpl });
    await client.login();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const warnings = [];
    client.on('warning', error => warnings.push(error));
    await client.connectEvents();
    const first = WebSocketImpl.instances[0];
    first.open();
    first.message({ status: 'ok' });
    first.fail(`Failed for Bearer ${ACCESS}`);
    first.dispatch('close');
    assert.equal(first.closeCalls, 1);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].message.includes(ACCESS));
    t.mock.timers.tick(4999);
    await nextTurn();
    assert.equal(WebSocketImpl.instances.length, 1);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(WebSocketImpl.instances.length, 2);
    const second = WebSocketImpl.instances[1];
    second.fail();
    t.mock.timers.tick(9999);
    await nextTurn();
    assert.equal(WebSocketImpl.instances.length, 2);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(WebSocketImpl.instances.length, 3);
    client.close();
    t.mock.timers.tick(1000000);
    await nextTurn();
    assert.equal(WebSocketImpl.instances.length, 3);
});

test('a stalled event subscription times out and does not report a healthy stream', async t => {
    const WebSocketImpl = fakeWebSockets();
    const { client } = clientWith(t, [tokenResponse()], { WebSocketImpl, requestTimeoutMs: 500 });
    await client.login();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const statuses = [];
    const warnings = [];
    client.on('streamStatus', value => statuses.push(value));
    client.on('warning', error => warnings.push(error));
    await client.connectEvents();
    t.mock.timers.tick(500);
    assert.equal(WebSocketImpl.instances[0].closeCalls, 1);
    assert.equal(warnings[0].code, 'STREAM_TIMEOUT');
    assert.deepEqual(statuses, []);
    client.close();
});

test('a rejected access token in the stream triggers fresh authentication before resubscribing', async t => {
    const WebSocketImpl = fakeWebSockets();
    const { client, calls } = clientWith(t, [tokenResponse(), tokenResponse({ access_token: ACCESS_TWO })], { WebSocketImpl });
    await client.login();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const warnings = [];
    client.on('warning', error => warnings.push(error));
    await client.connectEvents();
    const first = WebSocketImpl.instances[0];
    first.open();
    first.message({ status: 'error', error: { code: 'invalid_token', message: 'Invalid access token' } });
    assert.equal(first.closeCalls, 1);
    assert.equal(warnings.length, 1);
    t.mock.timers.tick(5000);
    await nextTurn();
    assert.equal(calls.length, 2);
    assert.equal(new URLSearchParams(calls[1].body).get('grant_type'), 'refresh_token');
    const second = WebSocketImpl.instances[1];
    second.open();
    assert.equal(second.sent[0].access_token, ACCESS_TWO);
});

test('the event subscription renews when its access token reaches the refresh margin', async t => {
    const WebSocketImpl = fakeWebSockets();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1700000000000 });
    const { client, calls } = clientWith(t, [tokenResponse({ expires_in: 10 }), tokenResponse({ access_token: ACCESS_TWO })], { WebSocketImpl });
    await client.connectEvents();
    const first = WebSocketImpl.instances[0];
    first.open();
    first.message({ status: 'ok' });
    t.mock.timers.tick(8999);
    await nextTurn();
    assert.equal(first.closeCalls, 0);
    t.mock.timers.tick(1);
    await nextTurn();
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(first.closeCalls, 1);
    assert.equal(calls.length, 2);
    const second = WebSocketImpl.instances[1];
    second.open();
    assert.equal(second.sent[0].access_token, ACCESS_TWO);
});

test('an HTTP token refresh replaces an active event subscription with the new token', async t => {
    const WebSocketImpl = fakeWebSockets();
    const { client } = clientWith(t, [
        tokenResponse(), jsonResponse({ error: 'expired' }, 401), tokenResponse({ access_token: ACCESS_TWO }), jsonResponse({ status: 'ok' }),
    ], { WebSocketImpl });
    await client.connectEvents();
    const first = WebSocketImpl.instances[0];
    first.open();
    first.message({ status: 'ok' });
    await client.homesData();
    assert.equal(first.closeCalls, 1);
    // The explicit call also checks that a scheduled immediate reconnect cannot create duplicates.
    await client.connectEvents();
    const second = WebSocketImpl.instances[1];
    second.open();
    assert.equal(second.sent[0].access_token, ACCESS_TWO);
    assert.equal(WebSocketImpl.instances.length, 2);
});

test('closing during event authentication prevents socket creation after the fetch finishes', async t => {
    const WebSocketImpl = fakeWebSockets();
    const pendingResponse = deferred();
    const { client } = clientWith(t, [() => pendingResponse.promise], { WebSocketImpl });
    const opening = client.connectEvents();
    const rejection = assert.rejects(opening, { code: 'CLIENT_CLOSED' });
    client.close();
    pendingResponse.resolve(tokenResponse());
    await rejection;
    await nextTurn();
    assert.equal(WebSocketImpl.instances.length, 0);
});
