'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandSigner, SigningError, UnsupportedFirmwareError } = require('../lib/signing');

// Synthetic keys only. Expected hashes were computed independently with
// Python hashlib/hmac, using the byte layout recovered from android.hu1.
const KEY = {
    sign_key_id: 'AAECAwQFBgcICQoLDA0ODw==',
    hash_sign_key: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
};
const MODULE_ID = '70:ee:50:aa:bb:cc';
const TIMESTAMP = 1700000000;
const VECTORS = [
    {
        property: 'target_position', value: 50,
        hmac: '8twhXe6uVkIMgxxSV_xU4PX1G0yDG6xUUnBf3HPqbqSvZpjaYQZinEaGxoLfi1QzwnrjbYgGplgRzevhBdyb_A==',
        sha512: '_Fe2ltat3nnsAN92HZKrFLNs8r5MKxmVzJGLY1KLyooFSMZ7Acj9sCdcQkwFb9MiIy32F3C8KUfMiyudvFYuFA==',
    },
    {
        property: 'scenario', value: 'home',
        hmac: '1-KDQZkUkjbnXrGZ_HPh-AT-aefwSPhIOkdy4mUPD6Kgdb5JTFue5T2CC0W13nMAuTHa6hP7b46fQS5fX8uOfg==',
        sha512: 'cOnOOSSZg69pDLNIbDma0TBboMDZ_o5b9smkBr8-MkiGFEtTwK5_8-0sHE44PF2qyEKbYfe7nxq7jWtDGJoRWA==',
    },
    {
        property: 'pincode', value: '0123',
        hmac: 'hCi8mIdDEkGOoysMpboPOBBf_k2ENqiijzO5HRfKfsbn6LKwu4L3Wd3Sr50zQBYRWCsQX1DryGWhB9XaIv3qaQ==',
        sha512: 'kIsjf3utK6uiBmUMCxeFPtUauoLLCKp728Svbd637aLnboHUbbZNQsa2ICMyl5sChHIj6UWH_GBebMVjpWectA==',
    },
];

function sign(signer, overrides = {}) {
    return signer.sign({
        property: 'target_position', value: 50, moduleId: MODULE_ID,
        signingKey: KEY, timestamp: TIMESTAMP, ...overrides,
    });
}

for (const vector of VECTORS) {
    for (const scheme of ['hmac', 'sha512']) {
        test(`${scheme} matches independent ${vector.property} vector`, () => {
            const result = sign(new CommandSigner(), { property: vector.property, value: vector.value, scheme });
            assert.equal(result[`hash_${vector.property}`], vector[scheme]);
            assert.equal(result.sign_key_id, KEY.sign_key_id);
            assert.equal(result.timestamp, TIMESTAMP);
            if (scheme === 'hmac') {
                assert.equal(result.nonce, 0);
            } else {
                assert.equal(Object.hasOwn(result, 'nonce'), false);
            }
            assert.equal(Object.hasOwn(result, vector.property), false);
        });
    }
}

test('HMAC binds the signature to the module; legacy has the APK layout without module ID', () => {
    assert.notEqual(sign(new CommandSigner()).hash_target_position,
        sign(new CommandSigner(), { moduleId: '70:ee:50:aa:bb:cd' }).hash_target_position);
    assert.equal(sign(new CommandSigner(), { scheme: 'sha512' }).hash_target_position,
        sign(new CommandSigner(), { scheme: 'sha512', moduleId: '70:ee:50:aa:bb:cd' }).hash_target_position);
});

test('integer nonces advance within one timestamp and survive restart and clock rollback', () => {
    const signer = new CommandSigner();
    assert.equal(sign(signer).nonce, 0);
    assert.equal(sign(signer).nonce, 1);
    const state = JSON.parse(JSON.stringify(signer.getState()));
    const restarted = new CommandSigner({ state });
    const rollback = sign(restarted, { timestamp: TIMESTAMP - 86400 });
    assert.equal(rollback.timestamp, TIMESTAMP);
    assert.equal(rollback.nonce, 2);
    const nextSecond = sign(restarted, { timestamp: TIMESTAMP + 1 });
    assert.equal(nextSecond.timestamp, TIMESTAMP + 1);
    assert.equal(nextSecond.nonce, 0);
});

test('nonce 32766 rolls over to the next timestamp, as in the APK', () => {
    const signer = new CommandSigner({ state: {
        version: 1, keys: { [KEY.sign_key_id]: { timestamp: TIMESTAMP, nonce: 32765 } },
    } });
    assert.equal(sign(signer).nonce, 32766);
    const rollover = sign(signer);
    assert.equal(rollover.timestamp, TIMESTAMP + 1);
    assert.equal(rollover.nonce, 0);
    assert.equal(sign(signer).nonce, 1);
});

test('legacy time is strictly increasing, including after restart and rollback', () => {
    const signer = new CommandSigner();
    assert.equal(sign(signer, { scheme: 'sha512' }).timestamp, TIMESTAMP);
    assert.equal(sign(signer, { scheme: 'sha512' }).timestamp, TIMESTAMP + 1);
    const restored = new CommandSigner({ state: signer.getState() });
    assert.equal(sign(restored, { scheme: 'sha512', timestamp: TIMESTAMP - 5 }).timestamp, TIMESTAMP + 2);
});

test('each signing key has its own counters; switching schemes never rolls back time', () => {
    const signer = new CommandSigner();
    sign(signer);
    assert.equal(sign(signer).nonce, 1);
    const otherKey = { ...KEY, sign_key_id: Buffer.alloc(16, 255).toString('base64') };
    assert.equal(sign(signer, { signingKey: otherKey }).nonce, 0);
    assert.equal(sign(signer, { scheme: 'sha512' }).timestamp, TIMESTAMP + 1);
    const hmacAgain = sign(signer);
    assert.equal(hmacAgain.timestamp, TIMESTAMP + 1);
    assert.equal(hmacAgain.nonce, 1);
});

test('saved state is detached, JSON serializable, and contains no signing secret or command value', () => {
    const signer = new CommandSigner();
    sign(signer, { property: 'pincode', value: '0987' });
    const snapshot = signer.getState();
    snapshot.keys[KEY.sign_key_id].nonce = 120;
    assert.equal(sign(signer).nonce, 1);
    const serialized = JSON.stringify(signer.getState());
    assert.equal(serialized.includes(KEY.hash_sign_key), false);
    assert.equal(serialized.includes('0987'), false);
    assert.deepEqual(new CommandSigner({ state: JSON.parse(serialized) }).getState(), signer.getState());
});

test('standard Base64 and unpadded Base64URL input have the same identity and padded output', () => {
    const key = { sign_key_id: Buffer.alloc(16, 255).toString('base64'), hash_sign_key: Buffer.alloc(32, 254).toString('base64') };
    const unpadded = Object.fromEntries(Object.entries(key).map(([name, value]) => [name, value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')]));
    assert.deepEqual(sign(new CommandSigner(), { signingKey: key }), sign(new CommandSigner(), { signingKey: unpadded }));
    const signer = new CommandSigner();
    sign(signer, { signingKey: key });
    assert.equal(sign(signer, { signingKey: unpadded }).nonce, 1);
    assert.equal(sign(signer, { signingKey: key }).sign_key_id.endsWith('=='), true);
});

test('invalid keys, unsupported schemes and invalid inputs fail without consuming a nonce', () => {
    const signer = new CommandSigner();
    for (const invalid of ['%%%', KEY.hash_sign_key + '=', 'a', '', 'A'.repeat(44), 'AA==\nAA==']) {
        assert.throws(() => sign(signer, { signingKey: { ...KEY, hash_sign_key: invalid } }),
            error => error instanceof SigningError && error.code === 'INVALID_SIGNING_KEY');
    }
    assert.throws(() => sign(signer, { scheme: 'auto' }), UnsupportedFirmwareError);
    assert.throws(() => sign(signer, { scheme: 'unknown' }), UnsupportedFirmwareError);
    for (const overrides of [
        { value: 20.5 }, { value: 101 }, { value: -2 }, { value: '50' },
        { property: 'force', value: true }, { property: 'pincode', value: 123 },
        { property: 'pincode', value: '' }, { property: 'scenario', value: 'h\u00f6me' },
        { timestamp: Infinity }, { timestamp: -1 }, { timestamp: 123.5 }, { moduleId: '' },
    ]) {
        assert.throws(() => sign(signer, overrides), { code: 'INVALID_SIGNING_INPUT' });
    }
    assert.equal(sign(signer).nonce, 0);
});

test('corrupt persisted counters are rejected instead of being silently reset', () => {
    for (const state of [
        {}, { version: 2, keys: {} }, { version: 1, keys: [] },
        { version: 1, keys: { bad: { timestamp: TIMESTAMP, nonce: 0 } } },
        { version: 1, keys: { [KEY.sign_key_id]: { timestamp: TIMESTAMP, nonce: 32767 } } },
        { version: 1, keys: { [KEY.sign_key_id]: { timestamp: TIMESTAMP, nonce: -1 } } },
        { version: 1, keys: { [KEY.sign_key_id]: { timestamp: '1700000000', nonce: 0 } } },
    ]) {
        assert.throws(() => new CommandSigner({ state }), { code: 'INVALID_SIGNER_STATE' });
    }
});

test('the injectable clock uses milliseconds; explicit timestamps remain whole seconds', () => {
    const signer = new CommandSigner({ clock: () => 1700000000123 });
    assert.equal(sign(signer, { timestamp: undefined }).timestamp, TIMESTAMP);
    assert.equal(sign(signer, { timestamp: TIMESTAMP - 20 }).nonce, 1);
});

test('timestamp exhaustion fails without wrapping counters', () => {
    const signer = new CommandSigner({ state: { version: 1, keys: {
        [KEY.sign_key_id]: { timestamp: Number.MAX_SAFE_INTEGER, nonce: 32766 },
    } } });
    assert.throws(() => sign(signer), { code: 'INVALID_SIGNER_STATE' });
    assert.throws(() => sign(signer, { scheme: 'sha512' }), { code: 'INVALID_SIGNER_STATE' });
});
