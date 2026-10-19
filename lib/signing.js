'use strict';

// Protocol reference: Niek/ha-velux-active, MIT, Copyright (c) 2026
// Niek van der Maas. See THIRD_PARTY_NOTICES.md and docs/protocol.md.
// Both signature schemes were also verified against VELUX ACTIVE 3.4.0.0.

const { createHash, createHmac } = require('node:crypto');

const STATE_VERSION = 1;
const MAX_NONCE = 32766;
const PROPERTIES = new Set(['target_position', 'scenario', 'pincode']);

class SigningError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SigningError';
        this.code = code;
    }
}

class UnsupportedFirmwareError extends SigningError {
    constructor() {
        super('UNSUPPORTED_FIRMWARE', 'The gateway signing scheme is not supported.');
        this.name = 'UnsupportedFirmwareError';
    }
}

function encodeBase64Url(bytes) {
    // Android Base64 flags URL_SAFE | NO_WRAP retain the '=' padding.
    return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeBase64(value, expectedLength, code = 'INVALID_SIGNING_KEY') {
    if (typeof value !== 'string') {
        throw new SigningError(code, 'Signing key data must use Base64 encoding.');
    }
    const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
    const unpadded = normalized.replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || unpadded.length % 4 === 1 ||
        (normalized.includes('=') && normalized.length % 4 !== 0)) {
        throw new SigningError(code, 'Signing key data contains invalid Base64.');
    }
    const decoded = Buffer.from(unpadded, 'base64');
    // Buffer.from() alone silently accepts malformed or non-canonical input.
    if (decoded.length !== expectedLength || decoded.toString('base64').replace(/=+$/, '') !== unpadded) {
        decoded.fill(0);
        throw new SigningError(code, 'Signing key data has an invalid length or encoding.');
    }
    return decoded;
}

function validTimestamp(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function serializeValue(property, value) {
    if (!PROPERTIES.has(property)) {
        throw new SigningError('INVALID_SIGNING_INPUT', 'This command property cannot be signed.');
    }
    if (property === 'target_position') {
        if (!Number.isInteger(value) || value < -1 || value > 100) {
            throw new SigningError('INVALID_SIGNING_INPUT', 'Target position must be an integer from -1 to 100.');
        }
        return String(value);
    }
    // Keep PINs as strings so leading zeroes are not lost. The caller owns
    // command semantics; this layer never changes a scenario or PIN value.
    if (typeof value !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(value)) {
        throw new SigningError('INVALID_SIGNING_INPUT', 'The signed command value must be a nonempty ASCII string.');
    }
    return value;
}

/**
 * Synchronous signature allocation. Persist getState() before transmitting the
 * resulting command, and restore that state when this adapter instance starts.
 * The clock function, if supplied, returns milliseconds since the Unix epoch.
 */
class CommandSigner {
    #keys = new Map();
    #clock;

    constructor({ state, clock = Date.now } = {}) {
        if (typeof clock !== 'function') {
            throw new SigningError('INVALID_SIGNER_STATE', 'The signing clock must be a function.');
        }
        this.#clock = clock;
        if (state === undefined || state === null) {
            return;
        }
        if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== STATE_VERSION ||
            !state.keys || typeof state.keys !== 'object' || Array.isArray(state.keys)) {
            throw new SigningError('INVALID_SIGNER_STATE', 'Saved signing counters are invalid; refusing to reset them.');
        }
        for (const [keyId, counters] of Object.entries(state.keys)) {
            const decoded = decodeBase64(keyId, 16, 'INVALID_SIGNER_STATE');
            const canonicalId = encodeBase64Url(decoded);
            decoded.fill(0);
            if (!counters || !validTimestamp(counters.timestamp) || !Number.isInteger(counters.nonce) ||
                counters.nonce < 0 || counters.nonce > MAX_NONCE || this.#keys.has(canonicalId)) {
                throw new SigningError('INVALID_SIGNER_STATE', 'Saved signing counters are invalid; refusing to reset them.');
            }
            this.#keys.set(canonicalId, { timestamp: counters.timestamp, nonce: counters.nonce });
        }
    }

    getState() {
        return {
            version: STATE_VERSION,
            keys: Object.fromEntries(Array.from(this.#keys, ([keyId, counters]) => [keyId, { ...counters }])),
        };
    }

    sign({ property, value, moduleId, signingKey, scheme = 'hmac', timestamp } = {}) {
        if (scheme !== 'hmac' && scheme !== 'sha512') {
            throw new UnsupportedFirmwareError();
        }
        const serializedValue = serializeValue(property, value);
        if (scheme === 'hmac' && (typeof moduleId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(moduleId))) {
            throw new SigningError('INVALID_SIGNING_INPUT', 'A module or gateway ID is required for HMAC signing.');
        }
        if (!signingKey || typeof signingKey !== 'object') {
            throw new SigningError('INVALID_SIGNING_KEY', 'A paired gateway signing key is required.');
        }
        const keyIdBytes = decodeBase64(signingKey.sign_key_id, 16);
        const keyId = encodeBase64Url(keyIdBytes);
        keyIdBytes.fill(0);
        const key = decodeBase64(signingKey.hash_sign_key, 32);
        try {
            const requestedTimestamp = timestamp === undefined ? Math.floor(this.#clock() / 1000) : timestamp;
            if (!validTimestamp(requestedTimestamp)) {
                throw new SigningError('INVALID_SIGNING_INPUT', 'The signing timestamp must contain whole Unix seconds.');
            }
            const previous = this.#keys.get(keyId);
            let allocatedTimestamp = requestedTimestamp;
            let nonce = 0;
            if (previous) {
                if (scheme === 'sha512') {
                    allocatedTimestamp = Math.max(requestedTimestamp, previous.timestamp + 1);
                } else if (requestedTimestamp <= previous.timestamp) {
                    allocatedTimestamp = previous.timestamp;
                    nonce = previous.nonce + 1;
                    if (nonce > MAX_NONCE) {
                        allocatedTimestamp += 1;
                        nonce = 0;
                    }
                }
            }
            if (!validTimestamp(allocatedTimestamp)) {
                throw new SigningError('INVALID_SIGNER_STATE', 'The signing counter has exhausted its timestamp range.');
            }

            let digest;
            if (scheme === 'hmac') {
                const message = `${property}${serializedValue}${allocatedTimestamp}${nonce}${moduleId}`;
                digest = createHmac('sha512', key).update(message, 'utf8').digest();
            } else {
                // APK android.hu1.e: property/value bytes, RAW key, time bytes.
                // This older firmware format has neither nonce nor module ID.
                digest = createHash('sha512')
                    .update(property + serializedValue, 'utf8')
                    .update(key)
                    .update(String(allocatedTimestamp), 'utf8')
                    .digest();
            }
            this.#keys.set(keyId, { timestamp: allocatedTimestamp, nonce });
            const result = {
                [`hash_${property}`]: encodeBase64Url(digest),
                sign_key_id: keyId,
                timestamp: allocatedTimestamp,
            };
            if (scheme === 'hmac') {
                result.nonce = nonce;
            }
            return result;
        } finally {
            key.fill(0);
        }
    }
}

module.exports = { CommandSigner, SigningError, UnsupportedFirmwareError };
