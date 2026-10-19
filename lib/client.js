'use strict';

const { EventEmitter } = require('node:events');

const API_URL = 'https://app.velux-active.com';
const EVENTS_URL = 'wss://app.velux-active.com/ws/';
// Public OAuth application identifiers, also used by the VELUX Android app.
const DEFAULT_CLIENT_ID = '5931426da127d981e76bdd3f';
const DEFAULT_CLIENT_SECRET = '6ae2d89d15e767ae5c56b456b452d319';
const SENSITIVE_KEY = /password|token|authorization|client_secret|sign_key|hash_target|hash_scenario|pin_?code|access_?code/i;
const MAX_TIMER_MS = 2147483647;
const SCHEDULE_PATHS = Object.freeze({
    create: '/api/createnewhomeschedule',
    update: '/api/synchomeschedule',
    rename: '/api/renamehomeschedule',
    delete: '/api/deletehomeschedule',
    switch: '/api/switchhomeschedule',
});

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class VeluxApiError extends Error {
    constructor(message, { code = 'API_ERROR', httpStatus, errors = [], retryAfterMs } = {}) {
        super(message);
        this.name = 'VeluxApiError';
        this.code = code;
        this.httpStatus = httpStatus;
        this.errors = errors;
        if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    }
}

/**
 * VELUX ACTIVE transport. No device commands are constructed here.
 *
 * Callers own device routing and signing. Only an unambiguous HTTP 401 is
 * retried, once, after refreshing credentials. Timeouts, connection failures,
 * HTTP 5xx and device-level errors never repeat a command automatically.
 *
 * Events: tokens, authStatus, streamStatus, update and warning.
 * Token expiresAt uses Unix time in milliseconds.
 */
class VeluxClient extends EventEmitter {
    constructor({
        username = '',
        password = '',
        refreshToken = '',
        clientId = DEFAULT_CLIENT_ID,
        clientSecret = DEFAULT_CLIENT_SECRET,
        requestTimeoutMs = 15000,
        fetchImpl = globalThis.fetch,
        WebSocketImpl = globalThis.WebSocket,
        appVersion = '791304000',
    } = {}) {
        super();
        if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
        if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > MAX_TIMER_MS) {
            throw new TypeError('requestTimeoutMs must be a positive supported timer duration');
        }
        if (!/^\d+$/.test(String(appVersion))) throw new TypeError('appVersion must contain digits');
        this._username = String(username).trim();
        this._password = String(password);
        this._clientId = String(clientId);
        this._clientSecret = String(clientSecret);
        this._refreshToken = String(refreshToken || '');
        this._accessToken = '';
        this._expiresAt = 0;
        this._refreshAt = 0;
        this._fetch = fetchImpl;
        this._WebSocket = WebSocketImpl;
        this._timeoutMs = requestTimeoutMs;
        this._appVersion = String(appVersion);
        this._authPromise = null;
        this._authStatus = null;
        this._closed = false;
        this._controllers = new Set();
        this._secrets = new Set([
            this._username, this._password, this._clientSecret, this._refreshToken,
        ].filter(Boolean));
        this._eventsWanted = false;
        this._socket = null;
        this._socketToken = '';
        this._socketListeners = [];
        this._streamPromise = null;
        this._streamStatus = false;
        this._streamTimeout = null;
        this._streamRenewal = null;
        this._reconnectTimer = null;
        this._reconnectDelay = 5000;
    }

    async login() {
        await this._ensureToken();
        return this._tokenSnapshot();
    }

    async homesData() {
        return this._request('/api/homesdata', {
            json: { app_type: 'app_velux', app_version: this._appVersion },
        });
    }

    async homeStatus(homeId) {
        this._requireText(homeId, 'home_id');
        return this._request('/syncapi/v1/homestatus', {
            json: { home_id: homeId, app_version: this._appVersion },
        });
    }

    async setState(payload) {
        this._requireRecord(payload, 'setstate payload');
        this._requireRecord(payload.home, 'setstate home');
        this._requireText(payload.home.id, 'home.id');
        return this._request('/syncapi/v1/setstate', {
            json: { app_type: 'app_velux', app_version: this._appVersion, ...payload },
        });
    }

    async getConfigs(homeId) {
        this._requireText(homeId, 'home_id');
        return this._request('/syncapi/v1/getconfigs', {
            method: 'GET', query: { home_id: homeId },
        });
    }

    async setConfigs(homeId, configPayload) {
        this._requireText(homeId, 'home_id');
        this._requireRecord(configPayload, 'configuration');
        if (configPayload.home_id !== undefined && configPayload.home_id !== homeId) {
            throw new VeluxApiError('Configuration home_id does not match the selected home', { code: 'INVALID_ARGUMENT' });
        }
        const home = configPayload.home ?? configPayload;
        this._requireRecord(home, 'configuration home');
        if (home === configPayload && Object.hasOwn(home, 'home_id')) {
            throw new VeluxApiError('Use {home: {...}} when configuration includes home_id', { code: 'INVALID_ARGUMENT' });
        }
        // Matches the app's setconfigs wrapper, which differs from setstate.
        return this._request('/syncapi/v1/setconfigs', { json: { home_id: homeId, home } });
    }

    /** Native schedule fields from APK ntc/hxc; arrays stay JSON arrays. */
    async schedule(action, params) {
        const path = Object.hasOwn(SCHEDULE_PATHS, action) ? SCHEDULE_PATHS[action] : null;
        if (!path) throw new VeluxApiError('Unsupported schedule action', { code: 'INVALID_ARGUMENT' });
        this._requireRecord(params, 'schedule parameters');
        this._requireText(params.home_id, 'home_id');
        let payload;
        if (action === 'create' || action === 'update') {
            this._requireText(params.name, 'name');
            this._requireText(params.schedule_type, 'schedule_type');
            if (!Array.isArray(params.zones) || !Array.isArray(params.timetable)) {
                throw new VeluxApiError('Schedule zones and timetable must be arrays', { code: 'INVALID_ARGUMENT' });
            }
            if (action === 'update') this._requireText(params.schedule_id, 'schedule_id');
            // Retain native metadata and sunrise/sunset data supplied by the
            // caller; rebuilding a native schedule here would discard them.
            payload = { ...params };
            if (action === 'create') delete payload.schedule_id;
        } else if (action === 'rename') {
            this._requireText(params.schedule_id, 'schedule_id');
            this._requireText(params.name, 'name');
            payload = { home_id: params.home_id, schedule_id: params.schedule_id, name: params.name };
        } else if (action === 'delete') {
            this._requireText(params.schedule_id, 'schedule_id');
            payload = { home_id: params.home_id, schedule_id: params.schedule_id };
        } else {
            payload = { home_id: params.home_id };
            for (const key of ['schedule_id', 'schedule_type']) {
                if (params[key] !== undefined && params[key] !== null) {
                    this._requireText(params[key], key);
                    payload[key] = params[key];
                }
            }
            if (!payload.schedule_id && !payload.schedule_type) {
                throw new VeluxApiError('Switching a schedule needs schedule_id or schedule_type', { code: 'INVALID_ARGUMENT' });
            }
        }
        return this._request(path, { json: payload });
    }

    async connectEvents() {
        this._assertOpen();
        if (typeof this._WebSocket !== 'function') {
            throw new VeluxApiError('WebSocket is unavailable in this Node.js runtime', { code: 'WEBSOCKET_UNAVAILABLE' });
        }
        this._eventsWanted = true;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
        try {
            await this._openStream();
        } catch (error) {
            if (!this._closed) {
                this.emit('warning', error);
                this._scheduleReconnect();
            }
            throw error;
        }
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._eventsWanted = false;
        clearTimeout(this._reconnectTimer);
        clearTimeout(this._streamTimeout);
        clearTimeout(this._streamRenewal);
        this._reconnectTimer = this._streamTimeout = this._streamRenewal = null;
        this._dropSocket(this._socket, false);
        for (const controller of this._controllers) {
            controller.abort(new VeluxApiError('VELUX client is closed', { code: 'CLIENT_CLOSED' }));
        }
        this._setAuthStatus(false);
    }

    _assertOpen() {
        if (this._closed) throw new VeluxApiError('VELUX client is closed', { code: 'CLIENT_CLOSED' });
    }

    _requireRecord(value, name) {
        this._assertOpen();
        if (!isRecord(value)) throw new VeluxApiError(`${name} must be an object`, { code: 'INVALID_ARGUMENT' });
    }

    _requireText(value, name) {
        this._assertOpen();
        if (typeof value !== 'string' || !value.trim()) {
            throw new VeluxApiError(`${name} must be a nonempty string`, { code: 'INVALID_ARGUMENT' });
        }
    }

    _tokenSnapshot() {
        return { accessToken: this._accessToken, refreshToken: this._refreshToken, expiresAt: this._expiresAt };
    }

    _setAuthStatus(value) {
        if (this._authStatus === value) return;
        this._authStatus = value;
        this.emit('authStatus', value);
    }

    async _ensureToken({ force = false, rejectedToken } = {}) {
        this._assertOpen();
        if (this._authPromise) return this._authPromise;
        const usable = this._accessToken && Date.now() < this._refreshAt;
        // Another concurrent request may already have replaced the rejected token.
        if (usable && (!force || (rejectedToken && rejectedToken !== this._accessToken))) {
            return this._accessToken;
        }
        const promise = this._authenticate();
        this._authPromise = promise;
        try {
            return await promise;
        } finally {
            if (this._authPromise === promise) this._authPromise = null;
        }
    }

    async _authenticate() {
        try {
            let response;
            if (this._refreshToken) {
                try {
                    response = await this._oauth({ grant_type: 'refresh_token', refresh_token: this._refreshToken });
                } catch (error) {
                    // A temporary server/network error must not trigger a
                    // password login or an endless refresh/login loop.
                    const rejected = error.httpStatus === 400 || error.httpStatus === 401 || error.code === 'invalid_grant';
                    if (!rejected || !this._username || !this._password) throw error;
                    this._refreshToken = '';
                }
            }
            if (!response) {
                if (!this._username || !this._password) {
                    throw new VeluxApiError('VELUX account credentials are required', { code: 'CREDENTIALS_REQUIRED' });
                }
                response = await this._oauth({
                    grant_type: 'password', username: this._username, password: this._password,
                });
            }
            this._assertOpen();
            const tokens = response.body ?? response;
            const seconds = Number(tokens.expires_in ?? tokens.expire_in ?? 3600);
            const lifetimeMs = seconds * 1000;
            const expiresAt = Date.now() + lifetimeMs;
            if (typeof tokens.access_token !== 'string' || !tokens.access_token || !Number.isFinite(expiresAt) || seconds <= 0) {
                throw new VeluxApiError('VELUX returned invalid authentication data', { code: 'INVALID_AUTH_RESPONSE' });
            }
            this._accessToken = tokens.access_token;
            if (typeof tokens.refresh_token === 'string' && tokens.refresh_token) this._refreshToken = tokens.refresh_token;
            this._secrets.add(this._accessToken);
            if (this._refreshToken) this._secrets.add(this._refreshToken);
            this._expiresAt = expiresAt;
            this._refreshAt = this._expiresAt - Math.min(60000, Math.max(100, lifetimeMs * 0.1), lifetimeMs / 2);
            this._setAuthStatus(true);
            this.emit('tokens', this._tokenSnapshot());
            if (this._socket && this._socketToken !== this._accessToken) this._dropSocket(this._socket, true, 0);
            return this._accessToken;
        } catch (error) {
            if (!this._accessToken || Date.now() >= this._expiresAt || error.httpStatus === 401 || error.code === 'invalid_grant') {
                this._setAuthStatus(false);
            }
            throw error;
        }
    }

    _oauth(fields) {
        return this._transport('/oauth2/token', {
            form: {
                client_id: this._clientId, client_secret: this._clientSecret,
                app_version: this._appVersion, version: this._appVersion,
                scope: 'velux_scopes', user_prefix: 'velux', ...fields,
            },
        });
    }

    async _request(path, options) {
        const token = await this._ensureToken();
        let response;
        try {
            response = await this._transport(path, { ...options, token });
        } catch (error) {
            // VELUX also uses HTTP 403 for an invalid access token. Invalidate
            // it for the next caller, but do not replay this request on 403.
            if (error.httpStatus === 403 && this._isRejectedAccessToken(error)) this._invalidateToken(token);
            if (error.httpStatus !== 401 || this._closed) throw error;
            this._invalidateToken(token);
            const refreshedToken = await this._ensureToken({ force: true, rejectedToken: token });
            try {
                response = await this._transport(path, { ...options, token: refreshedToken });
            } catch (retryError) {
                if (retryError.httpStatus === 401 || (retryError.httpStatus === 403 && this._isRejectedAccessToken(retryError))) {
                    this._invalidateToken(refreshedToken);
                }
                throw retryError;
            }
        }
        return response.body ?? response;
    }

    _isRejectedAccessToken(error) {
        const code = String(error.code).toLowerCase();
        return ['invalid_token', 'expired_token', 'token_expired', 'unauthorized'].includes(code)
            || /\b(?:invalid|expired) access[ _]token\b|\baccess[ _]token (?:is )?(?:invalid|expired)\b/i.test(error.message);
    }

    _invalidateToken(token) {
        if (token !== this._accessToken) return;
        this._expiresAt = this._refreshAt = 0;
        this._setAuthStatus(false);
    }

    async _transport(path, { method = 'POST', json, form, query, token } = {}) {
        this._assertOpen();
        const url = new URL(path, API_URL);
        if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        const headers = {
            Accept: 'application/json',
            'User-Agent': `NetatmoApp(VELUX ACTIVE/v${this._appVersion}/${this._appVersion}) Android`,
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        let body;
        try {
            if (form) {
                this._rememberSecrets(form);
                body = new URLSearchParams(form).toString();
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
            } else if (json !== undefined) {
                this._rememberSecrets(json);
                body = JSON.stringify(json);
                headers['Content-Type'] = 'application/json; charset=utf-8';
            }
        } catch {
            throw new VeluxApiError('Request data is not serializable', { code: 'INVALID_ARGUMENT' });
        }
        const controller = new AbortController();
        this._controllers.add(controller);
        const timeout = setTimeout(() => {
            controller.abort(new VeluxApiError(`VELUX request to ${path} timed out`, { code: 'TIMEOUT' }));
        }, this._timeoutMs);
        let onAbort;
        const aborted = new Promise((_, reject) => {
            onAbort = () => reject(controller.signal.reason);
            controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            // The race also covers response-body reads and permits immediate
            // shutdown with an injected transport that ignores AbortSignal.
            return await Promise.race([aborted, (async () => {
                const response = await this._fetch(url.toString(), {
                    method, headers, body, signal: controller.signal, redirect: 'error',
                });
                const text = await response.text();
                this._assertOpen();
                let data;
                try {
                    data = JSON.parse(text);
                } catch {
                    throw new VeluxApiError(`VELUX returned non-JSON data for ${path} (HTTP ${response.status})`, {
                        code: 'INVALID_RESPONSE', httpStatus: response.status,
                    });
                }
                if (!isRecord(data)) {
                    throw new VeluxApiError(`VELUX returned an invalid response for ${path}`, {
                        code: 'INVALID_RESPONSE', httpStatus: response.status,
                    });
                }
                this._rememberSecrets(data);
                const error = this._responseError(path, response, data);
                if (error) throw error;
                return data;
            })()]);
        } catch (error) {
            if (controller.signal.aborted) throw controller.signal.reason;
            if (error instanceof VeluxApiError) throw error;
            throw new VeluxApiError(`VELUX request to ${path} failed: ${this._redact(error?.message || 'Network error')}`, {
                code: 'NETWORK_ERROR',
            });
        } finally {
            clearTimeout(timeout);
            controller.signal.removeEventListener('abort', onAbort);
            this._controllers.delete(controller);
        }
    }

    _responseError(path, response, data) {
        const nested = isRecord(data.body) ? data.body : {};
        const errors = [];
        for (const value of [data.error, nested.error]) {
            if (value) errors.push(isRecord(value) ? value : { message: String(value) });
        }
        for (const value of [data.errors, nested.errors]) {
            if (Array.isArray(value)) errors.push(...value);
            else if (isRecord(value) && Object.keys(value).length) errors.push(value);
        }
        const failedStatus = data.status !== undefined && data.status !== 'ok';
        if (response.ok && !errors.length && !failedStatus) return null;
        const first = errors.find(isRecord) || {};
        const message = data.error_description || first.message || first.msg || `VELUX rejected ${path} (HTTP ${response.status})`;
        const code = first.code ?? (typeof data.error === 'string' ? data.error : undefined) ?? (response.status === 401 ? 'UNAUTHORIZED' : 'API_ERROR');
        const retryAfter = response.headers?.get?.('retry-after');
        let retryAfterMs;
        if (retryAfter) {
            retryAfterMs = /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
            if (!Number.isFinite(retryAfterMs)) retryAfterMs = undefined;
            else retryAfterMs = Math.max(0, retryAfterMs);
        }
        return new VeluxApiError(this._redact(String(message)), {
            code: this._redact(code),
            httpStatus: response.status, errors: this._redact(errors), retryAfterMs,
        });
    }

    _rememberSecrets(value, seen = new WeakSet()) {
        if (!value || typeof value !== 'object' || seen.has(value)) return;
        seen.add(value);
        for (const [key, item] of Object.entries(value)) {
            if (SENSITIVE_KEY.test(key) && typeof item === 'string' && item) this._secrets.add(item);
            else if (item && typeof item === 'object') this._rememberSecrets(item, seen);
        }
    }

    _redact(value) {
        if (typeof value === 'string') {
            let text = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
            for (const secret of this._secrets) if (secret) text = text.split(secret).join('[REDACTED]');
            return text;
        }
        if (Array.isArray(value)) return value.map(item => this._redact(item));
        if (isRecord(value)) {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : this._redact(item)]));
        }
        return value;
    }

    async _openStream() {
        this._assertOpen();
        if (!this._eventsWanted || this._socket) return;
        if (this._streamPromise) return this._streamPromise;
        const opening = (async () => {
            const token = await this._ensureToken();
            this._assertOpen();
            if (!this._eventsWanted || this._socket) return;
            let socket;
            try {
                socket = new this._WebSocket(EVENTS_URL);
            } catch (error) {
                throw new VeluxApiError(`Cannot open VELUX event stream: ${this._redact(error?.message || 'Connection failed')}`, { code: 'STREAM_ERROR' });
            }
            this._socket = socket;
            this._socketToken = token;
            const listen = (type, listener) => {
                socket.addEventListener(type, listener);
                this._socketListeners.push([type, listener]);
            };
            listen('open', () => {
                if (this._socket !== socket || this._closed) return;
                try {
                    socket.send(JSON.stringify({
                        action: 'Subscribe', filter: 'silent', access_token: token,
                        app_type: 'app_velux', platform: 'Android', version: this._appVersion,
                    }));
                } catch (error) {
                    this._streamFailure(socket, new VeluxApiError(`VELUX subscription failed: ${this._redact(error?.message || 'Send failed')}`, { code: 'STREAM_ERROR' }));
                }
            });
            listen('message', event => {
                this._streamMessage(socket, event.data).catch(error => {
                    this._streamFailure(socket, new VeluxApiError(this._redact(error?.message || 'Invalid event data'), { code: 'STREAM_ERROR' }));
                });
            });
            listen('error', event => {
                this._streamFailure(socket, new VeluxApiError(`VELUX event stream failed: ${this._redact(event.error?.message || 'Connection error')}`, { code: 'STREAM_ERROR' }));
            });
            listen('close', () => this._dropSocket(socket, true));
            this._streamTimeout = setTimeout(() => {
                this._streamFailure(socket, new VeluxApiError('VELUX event subscription timed out', { code: 'STREAM_TIMEOUT' }));
            }, this._timeoutMs);
            this._streamTimeout.unref?.();
        })();
        this._streamPromise = opening;
        try {
            await opening;
        } finally {
            if (this._streamPromise === opening) this._streamPromise = null;
        }
    }

    async _streamMessage(socket, input) {
        if (this._closed || this._socket !== socket) return;
        let text;
        if (typeof input === 'string') text = input;
        else if (input && typeof input.text === 'function') text = await input.text();
        else if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) text = new TextDecoder().decode(input);
        else return;
        if (this._closed || this._socket !== socket) return;
        if (text.length > 1048576) {
            this.emit('warning', new VeluxApiError('Oversized VELUX event ignored', { code: 'INVALID_EVENT' }));
            return;
        }
        let message;
        try { message = JSON.parse(text); } catch { return; }
        if (!isRecord(message)) return;
        this._rememberSecrets(message);
        const error = this._responseError('/ws/', { ok: true, status: 200 }, message);
        if (error) {
            if (this._isRejectedAccessToken(error)) this._invalidateToken(this._socketToken);
            this._streamFailure(socket, error);
            return;
        }
        if (message.status === 'ok') this._streamReady();
        if (message.push_type !== 'embedded_json') return;
        let update = message.extra_params;
        if (typeof update === 'string') {
            try { update = JSON.parse(update); } catch { return; }
        }
        if (!isRecord(update)) return;
        // Preserve the complete delta, including its timestamp/sequence. The
        // model layer decides whether an incoming update is newer than a poll.
        this._streamReady();
        this.emit('update', update);
    }

    _streamReady() {
        clearTimeout(this._streamTimeout);
        this._streamTimeout = null;
        this._reconnectDelay = 5000;
        this._setStreamStatus(true);
        if (!this._streamRenewal) {
            this._streamRenewal = setTimeout(() => {
                this._streamRenewal = null;
                this._dropSocket(this._socket, true, 0);
            }, Math.max(1, Math.min(MAX_TIMER_MS, this._refreshAt - Date.now())));
            this._streamRenewal.unref?.();
        }
    }

    _streamFailure(socket, error) {
        if (this._closed || this._socket !== socket) return;
        this.emit('warning', error);
        this._dropSocket(socket, true);
    }

    _setStreamStatus(value) {
        if (this._streamStatus === value) return;
        this._streamStatus = value;
        this.emit('streamStatus', value);
    }

    _dropSocket(socket, reconnect, delay) {
        if (!socket || this._socket !== socket) return;
        this._socket = null;
        this._socketToken = '';
        for (const [type, listener] of this._socketListeners) socket.removeEventListener(type, listener);
        this._socketListeners = [];
        clearTimeout(this._streamTimeout);
        clearTimeout(this._streamRenewal);
        this._streamTimeout = this._streamRenewal = null;
        this._setStreamStatus(false);
        try { if (socket.readyState < 2) socket.close(); } catch { /* already closed */ }
        if (reconnect) this._scheduleReconnect(delay);
    }

    _scheduleReconnect(delay) {
        if (this._closed || !this._eventsWanted || this._reconnectTimer) return;
        const waitMs = delay ?? this._reconnectDelay;
        if (delay === undefined) this._reconnectDelay = Math.min(300000, this._reconnectDelay * 2);
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._openStream().catch(error => {
                if (!this._closed) {
                    this.emit('warning', error);
                    this._scheduleReconnect();
                }
            });
        }, waitMs);
        this._reconnectTimer.unref?.();
    }
}

module.exports = { VeluxClient, VeluxApiError };
