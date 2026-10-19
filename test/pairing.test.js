'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Duplex } = require('node:stream');
const {
    createPrivateKey, createPublicKey, generateKeyPairSync, diffieHellman,
    createHash, createCipheriv, createDecipheriv,
} = require('node:crypto');
const { pairGateway, _internals } = require('../lib/pairing');
const { FRAME, packFrame, unpackFrame, FrameDecoder, SecureContext, deriveSessionKey, incrementNonce } = _internals;

const SYNTHETIC_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const KEY_ID = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

test('NetCom little-endian framing matches the reference protocol layout', () => {
    assert.equal(packFrame(FRAME.KEY_REQUEST, Buffer.concat([Buffer.from([0]), KEY_ID])).toString('hex'),
        '0e02110000000102030405060708090a0b0c0d0e0f');
    assert.deepEqual(unpackFrame(Buffer.from('01000000', 'hex')), { type: FRAME.PONG, payload: Buffer.alloc(0) });
    assert.throws(() => unpackFrame(Buffer.from('0000', 'hex')), { code: 'PAIRING_PROTOCOL_ERROR' });
    assert.throws(() => unpackFrame(Buffer.from('010001000000', 'hex')), { code: 'PAIRING_PROTOCOL_ERROR' });
    assert.throws(() => packFrame(0x10000), { code: 'PAIRING_PROTOCOL_ERROR' });
    assert.throws(() => packFrame(0, Buffer.alloc(65536)), { code: 'PAIRING_PROTOCOL_ERROR' });
});

test('the frame decoder handles every header/payload split and coalesced frames', () => {
    const encoded = Buffer.concat([packFrame(FRAME.PING), packFrame(FRAME.ECDH_RESPONSE, SYNTHETIC_KEY), packFrame(FRAME.PONG)]);
    for (let split = 0; split <= encoded.length; split++) {
        const decoder = new FrameDecoder();
        const frames = [...decoder.push(encoded.subarray(0, split)), ...decoder.push(encoded.subarray(split))];
        assert.deepEqual(frames.map(frame => frame.type), [FRAME.PING, FRAME.ECDH_RESPONSE, FRAME.PONG]);
        assert.deepEqual(frames[1].payload, SYNTHETIC_KEY);
    }
    const decoder = new FrameDecoder();
    const frames = Array.from(encoded).flatMap(byte => decoder.push(Buffer.from([byte])));
    assert.equal(frames.length, 3);
    assert.throws(() => new FrameDecoder().push(Buffer.alloc(131073)), { code: 'PAIRING_PROTOCOL_ERROR' });
    assert.throws(() => new FrameDecoder().push(Buffer.alloc(4 * 129)), { code: 'PAIRING_PROTOCOL_ERROR' });
});

test('X25519 agrees with RFC 7748 and the NetCom SHA512 session-key derivation', () => {
    const privateKey = createPrivateKey({
        key: Buffer.concat([PKCS8_PREFIX, Buffer.from('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a', 'hex')]),
        format: 'der', type: 'pkcs8',
    });
    const bobPublic = Buffer.from('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f', 'hex');
    assert.equal(deriveSessionKey(privateKey, bobPublic).toString('hex'),
        '3efdfd26b71935c26e478db0de1188df085a91d0c670c3522904d311cc554004');
    assert.throws(() => deriveSessionKey(privateKey, Buffer.alloc(32)), { code: 'PAIRING_HANDSHAKE_FAILED' });
    assert.throws(() => deriveSessionKey(privateKey, Buffer.alloc(31)), { code: 'PAIRING_HANDSHAKE_FAILED' });
});

test('ChaCha20-Poly1305 matches independent Python vectors with distinct integer nonces', () => {
    const secure = new SecureContext(SYNTHETIC_KEY);
    const plaintext = packFrame(FRAME.KEY_REQUEST, Buffer.concat([Buffer.from([0]), KEY_ID]));
    const expected = [
        '16ba5331ade6a7d310655967a84b472df3bdfefbeebbf4d1db93d182df17134edf8a3860ef',
        '675e6dd9310ab9782e757b29b41c1e181bfd324ec1e8758298c15f95b2fbc4971a7cf77422',
    ];
    for (const vector of expected) {
        const encoded = unpackFrame(secure.encryptFrame(plaintext));
        assert.equal(encoded.type, FRAME.SECURE);
        assert.equal(encoded.payload.toString('hex'), vector);
        assert.deepEqual(secure.decryptPayload(Buffer.from(vector, 'hex')), plaintext);
    }
    secure.destroy();
    assert.throws(() => secure.encryptFrame(plaintext), { code: 'PAIRING_PROTOCOL_ERROR' });
});

test('tampering fails authentication and does not advance the receive nonce', () => {
    const sender = new SecureContext(SYNTHETIC_KEY);
    const receiver = new SecureContext(SYNTHETIC_KEY);
    const payload = unpackFrame(sender.encryptFrame(packFrame(FRAME.PONG))).payload;
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => receiver.decryptPayload(tampered), { code: 'PAIRING_AUTHENTICATION_FAILED' });
    assert.deepEqual(receiver.decryptPayload(payload), packFrame(FRAME.PONG));
    assert.throws(() => receiver.decryptPayload(payload), { code: 'PAIRING_AUTHENTICATION_FAILED' });
    assert.throws(() => receiver.decryptPayload(Buffer.alloc(19)), { code: 'PAIRING_PROTOCOL_ERROR' });
    sender.destroy();
    receiver.destroy();
});

test('NetCom nonce carry uses only the low eight bytes and refuses reuse after exhaustion', () => {
    const nonce = Buffer.alloc(12);
    nonce[11] = 255;
    incrementNonce(nonce);
    assert.equal(nonce.toString('hex'), '000000000000000000000100');
    nonce.fill(255, 4);
    assert.throws(() => incrementNonce(nonce), { code: 'PAIRING_NONCE_EXHAUSTED' });
});

// The mock gateway deliberately implements framing and encryption independently
// from the library. The socket pair stays in memory; no real device is used.
function mockFrame(type, payload = Buffer.alloc(0)) {
    const header = Buffer.alloc(4);
    header.writeUInt16LE(type);
    header.writeUInt16LE(payload.length, 2);
    return Buffer.concat([header, payload]);
}

async function* mockFrames(socket) {
    let buffered = Buffer.alloc(0);
    for await (const chunk of socket) {
        buffered = Buffer.concat([buffered, chunk]);
        while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt16LE(2)) {
            const size = 4 + buffered.readUInt16LE(2);
            const frame = { type: buffered.readUInt16LE(0), payload: Buffer.from(buffered.subarray(4, size)) };
            buffered = buffered.subarray(size);
            yield frame;
        }
    }
}

async function mockProtocol(socket, options = {}) {
    const iterator = mockFrames(socket)[Symbol.asyncIterator]();
    const read = async type => {
        const item = await iterator.next();
        assert.equal(item.done, false, 'client unexpectedly closed the mock gateway');
        assert.equal(item.value.type, type);
        return item.value.payload;
    };
    const waitUntilClosed = () => new Promise(resolve => socket.once('close', resolve));
    assert.equal((await read(0x0000)).length, 0);
    if (options.hang === 'pong') {
        await waitUntilClosed();
        return;
    }
    if (options.unexpectedPong) {
        socket.write(mockFrame(0x1234));
        return;
    }
    if (options.pongPayload) {
        socket.write(mockFrame(0x0001, Buffer.from([1])));
        return;
    }
    if (options.sendPing) {
        socket.write(Buffer.concat([mockFrame(0x0000), mockFrame(0x0001)]));
        assert.equal((await read(0x0001)).length, 0);
    } else {
        const pong = mockFrame(0x0001);
        socket.write(pong.subarray(0, 1));
        await new Promise(resolve => setImmediate(resolve));
        socket.write(pong.subarray(1));
    }
    const peerBytes = await read(0x0201);
    assert.equal(peerBytes.length, 33);
    assert.equal(peerBytes[0], 1);
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    const peer = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, peerBytes.subarray(1)]), format: 'der', type: 'spki' });
    const sessionKey = createHash('sha512').update(diffieHellman({ privateKey, publicKey: peer })).digest().subarray(0, 32);
    const publicBytes = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    socket.write(mockFrame(0x0202, options.publicPrefix === undefined ? publicBytes : Buffer.concat([Buffer.from([options.publicPrefix]), publicBytes])));
    let txNonce = 0n;
    let rxNonce = 0n;
    const nonce = counter => {
        const result = Buffer.alloc(12);
        result.writeBigUInt64BE(counter, 4);
        return result;
    };
    const readSecure = async type => {
        const payload = await read(0x0200);
        const decipher = createDecipheriv('chacha20-poly1305', sessionKey, nonce(rxNonce++), { authTagLength: 16 });
        decipher.setAuthTag(payload.subarray(-16));
        const plain = Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]);
        assert.equal(plain.readUInt16LE(0), type);
        assert.equal(plain.readUInt16LE(2), plain.length - 4);
        return plain.subarray(4);
    };
    const sendSecure = (type, payload, { tamper = false, trailing = false } = {}) => {
        const cipher = createCipheriv('chacha20-poly1305', sessionKey, nonce(txNonce++), { authTagLength: 16 });
        const frame = trailing ? Buffer.concat([mockFrame(type, payload), Buffer.from([0])]) : mockFrame(type, payload);
        const encrypted = Buffer.concat([cipher.update(frame), cipher.final(), cipher.getAuthTag()]);
        if (tamper) {
            encrypted[encrypted.length - 1] ^= 1;
        }
        socket.write(mockFrame(0x0200, encrypted));
    };
    const keyRequest = await readSecure(0x020e);
    assert.equal(keyRequest.length, 17);
    assert.equal(keyRequest[0], 0);
    const keyId = Buffer.from(keyRequest.subarray(1));
    assert.equal(keyId[6] >> 4, 4, 'key ID is UUID v4');
    assert.equal(keyId[8] >> 6, 2, 'key ID has the RFC UUID variant');
    if (options.rejectKey) {
        sendSecure(0x020f, Buffer.from([options.rejectKey]));
        return;
    }
    sendSecure(0x020f, Buffer.concat([Buffer.from([0]), SYNTHETIC_KEY]), { tamper: options.tamperKey, trailing: options.trailingInnerFrame });
    if (options.tamperKey || options.trailingInnerFrame) {
        return;
    }
    assert.deepEqual(await readSecure(0x020a), Buffer.from([0]));
    if (options.hang === 'nonce') {
        await waitUntilClosed();
        return;
    }
    const challengeNonce = options.emptyNonce ? Buffer.alloc(0) : Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    sendSecure(0x020b, challengeNonce);
    if (options.emptyNonce) {
        return;
    }
    const challenge = await readSecure(0x020c);
    assert.equal(challenge.length, 80);
    assert.deepEqual(challenge.subarray(0, 16), keyId);
    assert.deepEqual(challenge.subarray(16), createHash('sha512').update(keyId).update(SYNTHETIC_KEY).update(challengeNonce).digest());
    sendSecure(0x020d, Buffer.from([options.rejectChallenge ? 1 : 0]));
    if (options.rejectChallenge) {
        return;
    }
    assert.equal((await readSecure(0x0008)).length, 0);
    return { sign_key_id: keyId.toString('base64url'), hash_sign_key: SYNTHETIC_KEY.toString('base64url') };
}

async function mockGateway(t, options) {
    const sockets = new Set();
    let resolveCompleted;
    let rejectCompleted;
    let connections = 0;
    const completed = new Promise((resolve, reject) => { resolveCompleted = resolve; rejectCompleted = reject; });
    // Some error tests intentionally disconnect before the script completes.
    completed.catch(() => {});
    function socketPair() {
        let client;
        let server;
        const makeSocket = getPeer => {
            const socket = new Duplex({
                read() {},
                write(chunk, encoding, callback) {
                    if (options?.stallWrite && this === client) {
                        return;
                    }
                    const peer = getPeer();
                    if (peer.destroyed) {
                        callback(new Error('Mock socket is closed'));
                        return;
                    }
                    peer.push(Buffer.from(chunk));
                    callback();
                },
                final(callback) {
                    getPeer().push(null);
                    callback();
                },
                destroy(error, callback) {
                    const peer = getPeer();
                    // Let a final frame that was successfully written be read.
                    setImmediate(() => peer.destroy());
                    callback(error);
                },
            });
            socket.setNoDelay = () => socket;
            socket.on('error', () => {});
            return socket;
        };
        client = makeSocket(() => server);
        server = makeSocket(() => client);
        return { client, server };
    }
    const mocked = t.mock.method(net, 'createConnection', ({ host, port }) => {
        assert.equal(host, 'mock-gateway.invalid');
        assert.equal(port, 25050);
        connections++;
        if (options?.refuseFirst && connections === 1) {
            const refused = new net.Socket();
            queueMicrotask(() => refused.emit('error', Object.assign(new Error('Mock refusal'), { code: 'ECONNREFUSED' })));
            return refused;
        }
        const { client, server } = socketPair();
        sockets.add(client);
        sockets.add(server);
        mockProtocol(server, options).then(resolveCompleted, rejectCompleted);
        queueMicrotask(() => client.emit('connect'));
        return client;
    });
    t.after(() => {
        for (const socket of sockets) {
            socket.destroy();
        }
        mocked.mock.restore();
    });
    return { host: 'mock-gateway.invalid', port: 25050, completed, get connections() { return connections; } };
}

for (const publicPrefix of [undefined, 0, 1]) {
    test(`full local pairing verifies the challenge, public-key prefix ${publicPrefix ?? 'absent'}`, async t => {
        const gateway = await mockGateway(t, { publicPrefix, sendPing: publicPrefix === 1 });
        const result = await pairGateway({ host: gateway.host, port: gateway.port, timeoutMs: 1000 });
        const expected = await gateway.completed;
        assert.equal(result.sign_key_id.replace(/=+$/, ''), expected.sign_key_id);
        assert.equal(result.hash_sign_key.replace(/=+$/, ''), expected.hash_sign_key);
        assert.equal(result.sign_key_id.endsWith('=='), true);
        assert.equal(result.hash_sign_key.endsWith('='), true);
        assert.equal(gateway.connections, 1);
    });
}

for (const [name, options, code] of [
    ['unexpected response', { unexpectedPong: true }, 'PAIRING_PROTOCOL_ERROR'],
    ['unexpected pong payload', { pongPayload: true }, 'PAIRING_PROTOCOL_ERROR'],
    ['gateway public-key prefix', { publicPrefix: 2 }, 'PAIRING_PROTOCOL_ERROR'],
    ['rejected key ID', { rejectKey: 2 }, 'PAIRING_KEY_ID_REJECTED'],
    ['full gateway key table', { rejectKey: 3 }, 'PAIRING_KEY_TABLE_FULL'],
    ['tampered encrypted key', { tamperKey: true }, 'PAIRING_AUTHENTICATION_FAILED'],
    ['trailing nested frame bytes', { trailingInnerFrame: true }, 'PAIRING_PROTOCOL_ERROR'],
    ['empty challenge nonce', { emptyNonce: true }, 'PAIRING_PROTOCOL_ERROR'],
    ['rejected challenge', { rejectChallenge: true }, 'PAIRING_CHALLENGE_REJECTED'],
]) {
    test(`pairing rejects ${name} without retrying key allocation`, async t => {
        const gateway = await mockGateway(t, options);
        await assert.rejects(pairGateway({ host: gateway.host, port: gateway.port, timeoutMs: 1000 }), { code });
        assert.equal(gateway.connections, 1);
    });
}

for (const hang of ['pong', 'nonce']) {
    test(`an absolute deadline ends a stalled ${hang} exchange and closes the socket`, async t => {
        const gateway = await mockGateway(t, { hang });
        const started = performance.now();
        await assert.rejects(pairGateway({ host: gateway.host, port: gateway.port, timeoutMs: 100 }), { code: 'PAIRING_TIMEOUT' });
        assert.ok(performance.now() - started < 1000);
        await gateway.completed;
        assert.equal(gateway.connections, 1);
    });
}

test('AbortSignal cancels an active exchange and closes the socket without exposing the abort reason', async t => {
    const gateway = await mockGateway(t, { hang: 'nonce' });
    const controller = new AbortController();
    const operation = pairGateway({ host: gateway.host, port: gateway.port, timeoutMs: 1000, signal: controller.signal });
    const timer = setTimeout(() => controller.abort('private reason must not be logged'), 100);
    try {
        await assert.rejects(operation, error => error.code === 'ABORT_ERR' && error.name === 'AbortError' && !error.message.includes('private reason'));
        await gateway.completed;
    } finally {
        clearTimeout(timer);
    }
});

test('connection refusal can be retried before a key request has been sent', async t => {
    const gateway = await mockGateway(t, { refuseFirst: true });
    const result = await pairGateway({ host: gateway.host, timeoutMs: 1000 });
    const expected = await gateway.completed;
    assert.equal(result.hash_sign_key.replace(/=+$/, ''), expected.hash_sign_key);
    assert.equal(gateway.connections, 2);
});

test('the absolute timeout also cancels a stalled socket write', async t => {
    const gateway = await mockGateway(t, { stallWrite: true });
    await assert.rejects(pairGateway({ host: gateway.host, timeoutMs: 50 }), { code: 'PAIRING_TIMEOUT' });
});

test('the absolute timeout also cancels a connection that never completes', async t => {
    const socket = new net.Socket();
    t.mock.method(net, 'createConnection', () => socket);
    await assert.rejects(pairGateway({ host: 'mock-gateway.invalid', timeoutMs: 50 }), { code: 'PAIRING_TIMEOUT' });
    assert.equal(socket.destroyed, true);
});

test('invalid options and an already cancelled signal fail before any connection is made', async () => {
    for (const options of [
        {}, { host: '' }, { host: 'https://127.0.0.1' }, { host: '127.0.0.1', port: 0 },
        { host: '127.0.0.1', timeoutMs: 0 }, { host: '127.0.0.1', signal: {} },
    ]) {
        await assert.rejects(pairGateway(options), { code: 'INVALID_PAIRING_OPTIONS' });
    }
    await assert.rejects(pairGateway({ host: '127.0.0.1', signal: AbortSignal.abort() }), { code: 'ABORT_ERR' });
});
