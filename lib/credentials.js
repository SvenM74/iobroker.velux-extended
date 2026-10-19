'use strict';

/** Secrets live in an encrypted object, never in readable adapter states or logs. */
class CredentialStore {
    constructor(adapter, account) {
        this.adapter = adapter;
        this.account = account;
        this.data = { account, keys: {}, signing: undefined, refreshToken: '' };
        this.pending = Promise.resolve();
    }

    async load() {
        const stored = await this.adapter.getObjectAsync('_credentials');
        if (!stored?.native?.sealed) return this.data;
        if (typeof this.adapter.decrypt !== 'function') throw new Error('ioBroker credential decryption is unavailable');
        let decoded;
        try { decoded = JSON.parse(this.adapter.decrypt(stored.native.sealed)); }
        catch { throw new Error('Stored credentials could not be decrypted; restore the controller secret or remove this adapter credential object'); }
        if (decoded.account === this.account) this.data = { ...this.data, ...decoded, keys: decoded.keys || {} };
        return this.data;
    }

    save() {
        const operation = this.pending.catch(() => {}).then(async () => {
            if (typeof this.adapter.encrypt !== 'function') throw new Error('ioBroker credential encryption is unavailable');
            const cleartext = JSON.stringify(this.data);
            const sealed = this.adapter.encrypt(cleartext);
            if (typeof sealed !== 'string' || sealed === cleartext || !sealed) throw new Error('ioBroker did not encrypt the credentials');
            await this.adapter.setObjectAsync('_credentials', {
                type: 'channel', common: { name: 'Encrypted adapter credentials' }, native: { sealed },
                acl: { object: 0x600, state: 0x600, owner: 'system.user.admin', ownerGroup: 'system.group.administrator' },
            });
        });
        this.pending = operation;
        return operation;
    }

    static key(homeId, gatewayId) { return JSON.stringify([homeId, gatewayId]); }
}

module.exports = { CredentialStore };
