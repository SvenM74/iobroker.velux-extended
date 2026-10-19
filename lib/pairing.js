'use strict';

// NetCom protocol adapted from Niek/ha-velux-active, MIT, Copyright (c)
// 2026 Niek van der Maas. See THIRD_PARTY_NOTICES.md and docs/protocol.md.
// Only the regular, physically authorized key retrieval is implemented here.

const net = require('node:net');
const {
    createCipheriv, createDecipheriv, createHash, createPublicKey,
    diffieHellman, generateKeyPairSync, randomBytes,
} = require('node:crypto');

const FRAME = Object.freeze({
    PING: 0x0000,
    PONG: 0x0001,
    CLOSE: 0x0008,
    SECURE: 0x0200,
    ECDH_REQUEST: 0x0201,
    ECDH_RESPONSE: 0x0202,
    NONCE_REQUEST: 0x020a,
    NONCE_RESPONSE: 0x020b,
    CHALLENGE_REQUEST: 0x020c,
    CHALLENGE_RESPONSE: 0x020d,
    KEY_REQUEST: 0x020e,
    KEY_RESPONSE: 0x020f,
});
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const MAX_BUFFERED_BYTES = 131072;
const MAX_QUEUED_FRAMES = 128;

class PairingError extends Error {
    constructor(code, message) {
        super(message);
        this.name = code === 'ABORT_ERR' ? 'AbortError' : 'PairingError';
        this.code = code;
    }
}

function protocolError(message) {
    return new PairingError('PAIRING_PROTOCOL_ERROR', message);
}

function abortError() {
    return new PairingError('ABORT_ERR', 'Gateway pairing was cancelled.');
}

function signalError(signal) {
    return signal.reason instanceof PairingError ? signal.reason : abortError();
}

function checkSignal(signal) {
    if (signal.aborted) {
        throw signalError(signal);
    }
}

function packFrame(type, payload = Buffer.alloc(0)) {
    if (!Number.isInteger(type) || type < 0 || type > 0xffff || !Buffer.isBuffer(payload) || payload.length > 0xffff) {
        throw protocolError('Invalid NetCom frame size or type.');
    }
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt16LE(type, 0);
    frame.writeUInt16LE(payload.length, 2);
    payload.copy(frame, 4);
    return frame;
}

function unpackFrame(frame) {
    if (!Buffer.isBuffer(frame) || frame.length < 4 || frame.length !== 4 + frame.readUInt16LE(2)) {
        throw protocolError('Invalid NetCom frame length.');
    }
    return { type: frame.readUInt16LE(0), payload: frame.subarray(4) };
}

class FrameDecoder {
    #buffer = Buffer.alloc(0);

    push(chunk) {
        if (!Buffer.isBuffer(chunk) || this.#buffer.length + chunk.length > MAX_BUFFERED_BYTES) {
            throw protocolError('NetCom receive buffer exceeded its limit.');
        }
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        const frames = [];
        let offset = 0;
        while (this.#buffer.length - offset >= 4) {
            const size = 4 + this.#buffer.readUInt16LE(offset + 2);
            if (this.#buffer.length - offset < size) {
                break;
            }
            frames.push(unpackFrame(Buffer.from(this.#buffer.subarray(offset, offset + size))));
            offset += size;
            if (frames.length > MAX_QUEUED_FRAMES) {
                throw protocolError('Too many NetCom frames arrived at once.');
            }
        }
        this.#buffer = Buffer.from(this.#buffer.subarray(offset));
        return frames;
    }
}

function incrementNonce(nonce) {
    // NetCom uses the low 64 bits of a 96-bit nonce, in big-endian order.
    if (nonce.subarray(4).every(byte => byte === 255)) {
        throw new PairingError('PAIRING_NONCE_EXHAUSTED', 'The NetCom session nonce is exhausted.');
    }
    for (let i = 11; i >= 4; i--) {
        if (nonce[i] < 255) {
            nonce[i]++;
            return;
        }
        nonce[i] = 0;
    }
    throw new PairingError('PAIRING_NONCE_EXHAUSTED', 'The NetCom session nonce is exhausted.');
}

class SecureContext {
    #key;
    #txNonce = Buffer.alloc(12);
    #rxNonce = Buffer.alloc(12);
    #destroyed = false;

    constructor(key) {
        if (!Buffer.isBuffer(key) || key.length !== 32) {
            throw protocolError('The NetCom session key has an invalid length.');
        }
        this.#key = Buffer.from(key);
    }

    encryptFrame(frame) {
        this.#checkLive();
        // Also prevent encrypting an invalid nested frame.
        unpackFrame(frame);
        const cipher = createCipheriv('chacha20-poly1305', this.#key, this.#txNonce, { authTagLength: 16 });
        const encrypted = Buffer.concat([cipher.update(frame), cipher.final(), cipher.getAuthTag()]);
        try {
            incrementNonce(this.#txNonce);
        } catch (error) {
            this.destroy();
            throw error;
        }
        return packFrame(FRAME.SECURE, encrypted);
    }

    decryptPayload(payload) {
        this.#checkLive();
        if (!Buffer.isBuffer(payload) || payload.length < 20) {
            throw protocolError('The encrypted NetCom frame is too short.');
        }
        let plaintext;
        try {
            const decipher = createDecipheriv('chacha20-poly1305', this.#key, this.#rxNonce, { authTagLength: 16 });
            decipher.setAuthTag(payload.subarray(-16));
            plaintext = Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]);
        } catch {
            throw new PairingError('PAIRING_AUTHENTICATION_FAILED', 'NetCom frame authentication failed.');
        }
        try {
            incrementNonce(this.#rxNonce);
        } catch (error) {
            plaintext.fill(0);
            this.destroy();
            throw error;
        }
        return plaintext;
    }

    #checkLive() {
        if (this.#destroyed) {
            throw protocolError('The NetCom session is closed.');
        }
    }

    destroy() {
        this.#destroyed = true;
        this.#key.fill(0);
        this.#txNonce.fill(0);
        this.#rxNonce.fill(0);
    }
}

function deriveSessionKey(privateKey, peerBytes) {
    let secret;
    let digest;
    try {
        if (!Buffer.isBuffer(peerBytes) || peerBytes.length !== 32) {
            throw new Error('invalid length');
        }
        const peerKey = createPublicKey({
            key: Buffer.concat([X25519_SPKI_PREFIX, peerBytes]),
            format: 'der', type: 'spki',
        });
        secret = diffieHellman({ privateKey, publicKey: peerKey });
        digest = createHash('sha512').update(secret).digest();
        return Buffer.from(digest.subarray(0, 32));
    } catch {
        throw new PairingError('PAIRING_HANDSHAKE_FAILED', 'The NetCom key exchange failed.');
    } finally {
        if (secret) {
            secret.fill(0);
        }
        if (digest) {
            digest.fill(0);
        }
    }
}

class NetcomConnection {
    #socket;
    #signal;
    #decoder = new FrameDecoder();
    #queue = [];
    #pending;
    #pendingWrites = new Set();
    #error;
    #onAbort;

    constructor(socket, signal) {
        this.#socket = socket;
        this.#signal = signal;
        this.#onAbort = () => this.#fail(signalError(signal));
        signal.addEventListener('abort', this.#onAbort, { once: true });
        socket.setNoDelay(true);
        socket.on('data', chunk => {
            if (this.#error) {
                return;
            }
            try {
                for (const frame of this.#decoder.push(chunk)) {
                    if (this.#pending) {
                        const pending = this.#pending;
                        this.#pending = undefined;
                        pending.resolve(frame);
                    } else {
                        this.#queue.push(frame);
                    }
                    if (this.#queue.length > MAX_QUEUED_FRAMES) {
                        throw protocolError('Too many unexpected NetCom frames were received.');
                    }
                }
            } catch (error) {
                this.#fail(error);
            }
        });
        socket.on('error', () => this.#fail(new PairingError('PAIRING_NETWORK_ERROR', 'The gateway connection failed.')));
        socket.on('end', () => this.#fail(new PairingError('PAIRING_CONNECTION_CLOSED', 'The gateway closed the connection.')));
        socket.on('close', () => this.#fail(new PairingError('PAIRING_CONNECTION_CLOSED', 'The gateway closed the connection.')));
        if (signal.aborted) {
            this.#onAbort();
        }
    }

    #fail(error) {
        if (this.#error) {
            return;
        }
        this.#error = error;
        if (this.#pending) {
            this.#pending.reject(error);
            this.#pending = undefined;
        }
        for (const reject of this.#pendingWrites) {
            reject(error);
        }
        this.#pendingWrites.clear();
        this.#socket.destroy();
    }

    async readFrame() {
        // Complete buffered frames remain readable after a normal remote FIN.
        // Cancellation and timeouts, however, always take precedence.
        checkSignal(this.#signal);
        if (this.#error && this.#error.code !== 'PAIRING_CONNECTION_CLOSED') {
            throw this.#error;
        }
        if (this.#queue.length) {
            return this.#queue.shift();
        }
        if (this.#error) {
            throw this.#error;
        }
        if (this.#pending) {
            throw protocolError('Concurrent NetCom reads are not supported.');
        }
        return new Promise((resolve, reject) => { this.#pending = { resolve, reject }; });
    }

    async send(frame) {
        checkSignal(this.#signal);
        if (this.#error) {
            throw this.#error;
        }
        await new Promise((resolve, reject) => {
            this.#pendingWrites.add(reject);
            try {
                this.#socket.write(frame, error => {
                    this.#pendingWrites.delete(reject);
                    if (error) {
                        reject(this.#error || new PairingError('PAIRING_NETWORK_ERROR', 'Sending the NetCom frame failed.'));
                    } else {
                        resolve();
                    }
                });
            } catch {
                this.#pendingWrites.delete(reject);
                reject(this.#error || new PairingError('PAIRING_NETWORK_ERROR', 'Sending the NetCom frame failed.'));
            }
        });
        checkSignal(this.#signal);
    }

    close() {
        this.#signal.removeEventListener('abort', this.#onAbort);
        this.#fail(new PairingError('PAIRING_CONNECTION_CLOSED', 'The NetCom session is closed.'));
    }
}

function connectOnce(host, port, signal) {
    return new Promise((resolve, reject) => {
        checkSignal(signal);
        const socket = net.createConnection({ host, port });
        let settled = false;
        const finish = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            socket.removeListener('connect', onConnect);
            socket.removeListener('error', onError);
            if (error) {
                socket.destroy();
                reject(error);
            } else {
                resolve(socket);
            }
        };
        const onAbort = () => finish(signalError(signal));
        const onError = error => {
            const retryable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(error.code);
            const failure = new PairingError('PAIRING_NETWORK_ERROR', 'The gateway pairing listener could not be reached.');
            failure.retryable = retryable;
            finish(failure);
        };
        const onConnect = () => finish();
        const timer = setTimeout(() => {
            const failure = new PairingError('PAIRING_NETWORK_ERROR', 'The gateway pairing listener did not answer.');
            failure.retryable = true;
            finish(failure);
        }, 1500);
        socket.once('connect', onConnect);
        socket.once('error', onError);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
            onAbort();
        }
    });
}

function waitForRetry(signal) {
    return new Promise((resolve, reject) => {
        checkSignal(signal);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signalError(signal));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, 250);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function connectGateway(host, port, signal) {
    while (true) {
        checkSignal(signal);
        try {
            return await connectOnce(host, port, signal);
        } catch (error) {
            if (!error.retryable || signal.aborted) {
                throw signal.aborted ? signalError(signal) : error;
            }
        }
        await waitForRetry(signal);
    }
}

async function expectFrame(connection, type) {
    while (true) {
        const frame = await connection.readFrame();
        if (frame.type === FRAME.PING) {
            if (frame.payload.length !== 0) {
                throw protocolError('A NetCom ping contained unexpected data.');
            }
            await connection.send(packFrame(FRAME.PONG));
            continue;
        }
        if (frame.type !== type) {
            throw protocolError('An unexpected NetCom response was received.');
        }
        return frame.payload;
    }
}

async function receiveSecure(connection, secure, type) {
    const payload = await expectFrame(connection, FRAME.SECURE);
    const plaintext = secure.decryptPayload(payload);
    try {
        const frame = unpackFrame(plaintext);
        if (frame.type !== type) {
            throw protocolError('An unexpected encrypted NetCom response was received.');
        }
        return Buffer.from(frame.payload);
    } finally {
        plaintext.fill(0);
    }
}

function encodeBase64Url(bytes) {
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Retrieve a NEW gateway key after authenticated cloud retrieve_key and physical
 * confirmation. See docs/protocol.md for the required two-stage user workflow.
 * No HTTP requests, PIN guessing, key extraction or movement occur here.
 */
async function pairGateway({ host, port = 25050, timeoutMs = 30000, signal } = {}) {
    if (typeof host !== 'string' || host.length === 0 || host.length > 253 ||
        host !== host.trim() || /[\s/\\?#@\x00-\x1f]/.test(host) ||
        !Number.isInteger(port) || port < 1 || port > 65535 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 ||
        (signal !== undefined && (!(signal instanceof AbortSignal)))) {
        throw new PairingError('INVALID_PAIRING_OPTIONS', 'A gateway host, valid TCP port, timeout and optional AbortSignal are required.');
    }
    if (signal?.aborted) {
        throw abortError();
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(abortError());
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
        controller.abort(new PairingError('PAIRING_TIMEOUT', 'Gateway pairing exceeded its time limit.'));
    }, timeoutMs);
    let socket;
    let connection;
    let secure;
    let signingKey;
    let challenge;
    const keyId = randomBytes(16);
    keyId[6] = (keyId[6] & 0x0f) | 0x40;
    keyId[8] = (keyId[8] & 0x3f) | 0x80;
    try {
        socket = await connectGateway(host, port, controller.signal);
        connection = new NetcomConnection(socket, controller.signal);
        await connection.send(packFrame(FRAME.PING));
        if ((await expectFrame(connection, FRAME.PONG)).length !== 0) {
            throw protocolError('A NetCom pong contained unexpected data.');
        }

        const { privateKey, publicKey } = generateKeyPairSync('x25519');
        const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
        await connection.send(packFrame(FRAME.ECDH_REQUEST, Buffer.concat([Buffer.from([1]), publicBytes])));
        let peerBytes = await expectFrame(connection, FRAME.ECDH_RESPONSE);
        if (peerBytes.length === 33 && (peerBytes[0] === 0 || peerBytes[0] === 1)) {
            peerBytes = peerBytes.subarray(1);
        }
        if (peerBytes.length !== 32) {
            throw protocolError('The gateway returned an invalid public key.');
        }
        const sessionKey = deriveSessionKey(privateKey, peerBytes);
        secure = new SecureContext(sessionKey);
        sessionKey.fill(0);

        await connection.send(secure.encryptFrame(packFrame(FRAME.KEY_REQUEST, Buffer.concat([Buffer.from([0]), keyId]))));
        const keyResponse = await receiveSecure(connection, secure, FRAME.KEY_RESPONSE);
        try {
            if (keyResponse.length === 0) {
                throw protocolError('The gateway returned an empty signing key response.');
            }
            if (keyResponse[0] !== 0) {
                const errors = {
                    1: ['PAIRING_KEY_REJECTED', 'The gateway rejected the signing key request.'],
                    2: ['PAIRING_KEY_ID_REJECTED', 'The gateway rejected the signing key ID.'],
                    3: ['PAIRING_KEY_TABLE_FULL', 'The gateway signing key table is full.'],
                };
                const [code, message] = errors[keyResponse[0]] || ['PAIRING_KEY_REJECTED', 'The gateway rejected the signing key request.'];
                throw new PairingError(code, message);
            }
            if (keyResponse.length !== 33) {
                throw protocolError('The gateway returned an unexpected signing key length.');
            }
            signingKey = Buffer.from(keyResponse.subarray(1));
        } finally {
            keyResponse.fill(0);
        }

        await connection.send(secure.encryptFrame(packFrame(FRAME.NONCE_REQUEST, Buffer.from([0]))));
        const nonce = await receiveSecure(connection, secure, FRAME.NONCE_RESPONSE);
        if (nonce.length === 0) {
            throw protocolError('The gateway returned an empty pairing challenge nonce.');
        }
        challenge = createHash('sha512').update(keyId).update(signingKey).update(nonce).digest();
        nonce.fill(0);
        await connection.send(secure.encryptFrame(packFrame(FRAME.CHALLENGE_REQUEST, Buffer.concat([keyId, challenge]))));
        const confirmation = await receiveSecure(connection, secure, FRAME.CHALLENGE_RESPONSE);
        if (confirmation.length === 0) {
            throw protocolError('The gateway returned an empty challenge confirmation.');
        }
        if (confirmation[0] !== 0) {
            throw new PairingError('PAIRING_CHALLENGE_REJECTED', 'The gateway did not confirm the signing key challenge.');
        }
        try {
            await connection.send(secure.encryptFrame(packFrame(FRAME.CLOSE)));
        } catch {
            // A gateway may close immediately after accepting the challenge.
            // The key is already confirmed, so no close acknowledgement is due.
        }
        checkSignal(controller.signal);
        return { sign_key_id: encodeBase64Url(keyId), hash_sign_key: encodeBase64Url(signingKey) };
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        connection?.close();
        socket?.destroy();
        secure?.destroy();
        signingKey?.fill(0);
        challenge?.fill(0);
        keyId.fill(0);
    }
}

module.exports = {
    pairGateway,
    PairingError,
    // Pure helpers are exposed solely for protocol vectors and mock transports.
    _internals: { FRAME, packFrame, unpackFrame, FrameDecoder, SecureContext, deriveSessionKey, incrementNonce },
};
