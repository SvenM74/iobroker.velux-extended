'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto');
const { CredentialStore } = require('../lib/credentials');

// All values are synthetic. Encryption models the controller-owned API; no
// controller secrets, external service or readable ioBroker state is used.
const ACCOUNT = 'synthetic-account-fingerprint';
const KEY_ID = Buffer.alloc(16, 7).toString('base64');
const SIGNING_KEY = Buffer.alloc(32, 11).toString('base64');
const REFRESH_TOKEN = 'synthetic-refresh-token-must-stay-encrypted';

function barrier() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

class FakeAdapter {
    constructor() {
        this.objects = new Map();
        this.objectWrites = [];
        this.stateWrites = [];
        this.logs = [];
        this.activeWrites = 0;
        this.maximumActiveWrites = 0;
        this.beforeObjectWrite = null;
        this.encryptionKey = Buffer.alloc(32, 19);
        this.log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...values) => this.logs.push([level, ...values])]));
    }

    encrypt(cleartext) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
        const ciphertext = Buffer.concat([cipher.update(cleartext, 'utf8'), cipher.final()]);
        return 'test-v1:' + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    }

    decrypt(sealed) {
        if (!sealed.startsWith('test-v1:')) throw new Error('Unrecognized synthetic ciphertext');
        const bytes = Buffer.from(sealed.slice(8), 'base64');
        const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }

    async getObjectAsync(id) {
        return structuredClone(this.objects.get(id));
    }

    async setObjectAsync(id, object) {
        const snapshot = structuredClone(object);
        this.objectWrites.push({ id, object: snapshot });
        this.activeWrites++;
        this.maximumActiveWrites = Math.max(this.maximumActiveWrites, this.activeWrites);
        try {
            if (this.beforeObjectWrite) await this.beforeObjectWrite(this.objectWrites.length, snapshot);
            this.objects.set(id, snapshot);
        } finally {
            this.activeWrites--;
        }
    }

    async setStateAsync(...arguments_) {
        this.stateWrites.push(arguments_);
        throw new Error('Credentials must not be written to a readable state');
    }
}

function populatedStore(adapter = new FakeAdapter()) {
    const store = new CredentialStore(adapter, ACCOUNT);
    store.data.keys[CredentialStore.key('home-a', 'gateway-a')] = {
        sign_key_id: KEY_ID, hash_sign_key: SIGNING_KEY,
    };
    store.data.signing = {
        version: 1, keys: { [KEY_ID]: { timestamp: 1700000000, nonce: 12 } },
    };
    store.data.refreshToken = REFRESH_TOKEN;
    return store;
}

test('a fresh store starts without credentials and performs no state or object writes on load', async () => {
    const adapter = new FakeAdapter();
    const store = new CredentialStore(adapter, ACCOUNT);
    assert.deepEqual(await store.load(), { account: ACCOUNT, keys: {}, signing: undefined, refreshToken: '' });
    assert.deepEqual(adapter.objectWrites, []);
    assert.deepEqual(adapter.stateWrites, []);
    assert.deepEqual(adapter.logs, []);
});

test('keys, refresh token and replay counters survive encrypted save/load without readable states', async () => {
    const adapter = new FakeAdapter();
    const store = populatedStore(adapter);
    await store.save();
    const saved = adapter.objects.get('_credentials');
    assert.equal(saved.type, 'channel');
    assert.deepEqual(Object.keys(saved.native), ['sealed']);
    assert.equal(saved.acl.object, 0x600);
    assert.equal(saved.acl.state, 0x600);
    assert.equal(saved.acl.owner, 'system.user.admin');
    const serialized = JSON.stringify(saved);
    for (const secret of [KEY_ID, SIGNING_KEY, REFRESH_TOKEN]) {
        assert.equal(serialized.includes(secret), false, 'plain credentials escaped into an object');
    }
    const reloaded = new CredentialStore(adapter, ACCOUNT);
    assert.deepEqual(await reloaded.load(), store.data);
    assert.notEqual(reloaded.data, store.data);
    assert.notEqual(reloaded.data.keys, store.data.keys);
    assert.deepEqual(adapter.stateWrites, []);
    assert.deepEqual(adapter.logs, []);
});

test('credentials from a different account are not reused or overwritten by loading', async () => {
    const adapter = new FakeAdapter();
    await populatedStore(adapter).save();
    const previouslyStored = structuredClone(adapter.objects.get('_credentials'));
    const store = new CredentialStore(adapter, 'different-account');
    assert.deepEqual(await store.load(), { account: 'different-account', keys: {}, signing: undefined, refreshToken: '' });
    assert.deepEqual(adapter.objects.get('_credentials'), previouslyStored);
    assert.equal(adapter.objectWrites.length, 1);
    assert.deepEqual(adapter.stateWrites, []);
});

test('a missing encryption API refuses storage instead of falling back to plaintext', async () => {
    const adapter = new FakeAdapter();
    adapter.encrypt = undefined;
    await assert.rejects(populatedStore(adapter).save(), /credential encryption is unavailable/);
    assert.deepEqual(adapter.objectWrites, []);
    assert.deepEqual(adapter.stateWrites, []);
});

test('an encryption API returning plaintext, an empty string or a non-string is rejected', async () => {
    for (const encrypt of [cleartext => cleartext, () => '', () => null, () => ({ encrypted: false })]) {
        const adapter = new FakeAdapter();
        adapter.encrypt = encrypt;
        await assert.rejects(populatedStore(adapter).save(), /did not encrypt the credentials/);
        assert.deepEqual(adapter.objectWrites, []);
        assert.deepEqual(adapter.stateWrites, []);
    }
});

test('a missing decryption API fails before exposing stored values', async () => {
    const adapter = new FakeAdapter();
    await populatedStore(adapter).save();
    adapter.decrypt = undefined;
    const reloaded = new CredentialStore(adapter, ACCOUNT);
    await assert.rejects(reloaded.load(), /credential decryption is unavailable/);
    assert.deepEqual(reloaded.data.keys, {});
    assert.equal(reloaded.data.refreshToken, '');
    assert.deepEqual(adapter.logs, []);
});

test('wrong controller encryption key, damaged ciphertext and malformed JSON produce sanitized errors', async () => {
    for (const damage of ['wrong-key', 'ciphertext', 'json', 'throw-secret']) {
        const adapter = new FakeAdapter();
        await populatedStore(adapter).save();
        if (damage === 'wrong-key') adapter.encryptionKey = Buffer.alloc(32, 20);
        if (damage === 'ciphertext') adapter.objects.get('_credentials').native.sealed = 'damaged synthetic ciphertext';
        if (damage === 'json') adapter.decrypt = () => '{invalid-json';
        if (damage === 'throw-secret') adapter.decrypt = () => { throw new Error(REFRESH_TOKEN + SIGNING_KEY); };
        const reloaded = new CredentialStore(adapter, ACCOUNT);
        await assert.rejects(reloaded.load(), error => {
            assert.match(error.message, /Stored credentials could not be decrypted/);
            assert.equal(error.message.includes(REFRESH_TOKEN), false);
            assert.equal(error.message.includes(SIGNING_KEY), false);
            assert.equal(error.message.includes('{invalid-json'), false);
            return true;
        });
        assert.deepEqual(reloaded.data.keys, {});
        assert.equal(reloaded.data.refreshToken, '');
        assert.deepEqual(adapter.logs, []);
        assert.deepEqual(adapter.stateWrites, []);
    }
});

test('overlapping save requests serialize database writes and persist the latest counters last', async () => {
    const adapter = new FakeAdapter();
    const entered = barrier();
    const release = barrier();
    adapter.beforeObjectWrite = async attempt => {
        if (attempt === 1) {
            entered.resolve();
            await release.promise;
        }
    };
    const store = populatedStore(adapter);
    const first = store.save();
    await entered.promise;
    store.data.refreshToken = 'synthetic-new-refresh-token';
    store.data.signing.keys[KEY_ID].nonce = 13;
    const second = store.save();
    await Promise.resolve();
    assert.equal(adapter.objectWrites.length, 1);
    assert.equal(adapter.maximumActiveWrites, 1);
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(adapter.objectWrites.length, 2);
    assert.equal(adapter.maximumActiveWrites, 1);
    const firstSnapshot = JSON.parse(adapter.decrypt(adapter.objectWrites[0].object.native.sealed));
    const secondSnapshot = JSON.parse(adapter.decrypt(adapter.objectWrites[1].object.native.sealed));
    assert.equal(firstSnapshot.refreshToken, REFRESH_TOKEN);
    assert.equal(firstSnapshot.signing.keys[KEY_ID].nonce, 12);
    assert.equal(secondSnapshot.refreshToken, 'synthetic-new-refresh-token');
    assert.equal(secondSnapshot.signing.keys[KEY_ID].nonce, 13);
    assert.deepEqual(await new CredentialStore(adapter, ACCOUNT).load(), store.data);
    assert.deepEqual(adapter.stateWrites, []);
});

test('a failed save is observable and does not poison the next already queued save', async () => {
    const adapter = new FakeAdapter();
    const entered = barrier();
    const release = barrier();
    adapter.beforeObjectWrite = async attempt => {
        if (attempt === 1) {
            entered.resolve();
            await release.promise;
            throw new Error('Synthetic database write failure');
        }
    };
    const store = populatedStore(adapter);
    const first = store.save();
    const firstFailure = assert.rejects(first, /Synthetic database write failure/);
    await entered.promise;
    store.data.signing.keys[KEY_ID].nonce = 14;
    const second = store.save();
    release.resolve();
    await firstFailure;
    await second;
    assert.equal(adapter.objectWrites.length, 2);
    assert.equal(adapter.maximumActiveWrites, 1);
    assert.equal((await new CredentialStore(adapter, ACCOUNT).load()).signing.keys[KEY_ID].nonce, 14);
    assert.deepEqual(adapter.stateWrites, []);
    assert.deepEqual(adapter.logs, []);
});

test('a failed persistence attempt preserves the last successfully stored credentials', async () => {
    const adapter = new FakeAdapter();
    const store = populatedStore(adapter);
    await store.save();
    const previous = structuredClone(adapter.objects.get('_credentials'));
    adapter.beforeObjectWrite = async () => { throw new Error('Synthetic database unavailable'); };
    store.data.refreshToken = 'synthetic-not-yet-persisted-token';
    await assert.rejects(store.save(), /Synthetic database unavailable/);
    assert.deepEqual(adapter.objects.get('_credentials'), previous);
    assert.equal((await new CredentialStore(adapter, ACCOUNT).load()).refreshToken, REFRESH_TOKEN);
    adapter.beforeObjectWrite = null;
    await store.save();
    assert.equal((await new CredentialStore(adapter, ACCOUNT).load()).refreshToken, store.data.refreshToken);
    assert.deepEqual(adapter.stateWrites, []);
});

test('home and gateway IDs form an unambiguous key for credential lookup', () => {
    const pairs = [
        ['home-a', 'gateway-a'], ['home-a', 'gateway-b'], ['home-b', 'gateway-a'],
        ['home,a', 'gateway'], ['home', 'a,gateway'], ['a"b', 'c'], ['a', 'b"c'],
    ];
    const keys = pairs.map(([home, gateway]) => CredentialStore.key(home, gateway));
    assert.equal(new Set(keys).size, pairs.length);
    assert.deepEqual(keys.map(key => JSON.parse(key)), pairs);
});
