'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const pkg = readJson('package.json');
const io = readJson('io-package.json');
const config = readJson('admin/jsonConfig.json');
const secretFields = ['password', 'refreshToken', 'clientSecret'];

function configFields(node, result = new Map()) {
    for (const [key, child] of Object.entries(node.items || {})) {
        if (child.type === 'panel' || child.type === 'tabs') {
            assert.ok(key.startsWith('_'), `Panel ${key} would nest native configuration`);
            configFields(child, result);
        } else if (!key.startsWith('_')) {
            assert.ok(!result.has(key), `Duplicate config field: ${key}`);
            result.set(key, child);
        }
    }
    return result;
}

function translatedStrings(value, result = new Set()) {
    if (Array.isArray(value)) {
        for (const child of value) translatedStrings(child, result);
    } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
            if (['label', 'title', 'text', 'help'].includes(key) && typeof child === 'string') result.add(child);
            else translatedStrings(child, result);
        }
    }
    return result;
}

test('npm and ioBroker metadata describe the same installable CommonJS adapter', () => {
    assert.equal(pkg.name, `iobroker.${io.common.name}`);
    assert.equal(pkg.name, 'iobroker.velux-extended');
    assert.equal(pkg.version, io.common.version);
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.type, 'commonjs');
    assert.equal(pkg.main, 'main.js');
    assert.equal(pkg.license, io.common.license);
    assert.equal(pkg.license, 'MIT');
    assert.equal(pkg.engines.node, '>=22.19.0');
    assert.deepEqual(Object.keys(pkg.dependencies), ['@iobroker/adapter-core']);
    assert.match(pkg.dependencies['@iobroker/adapter-core'], /^\^3\./);
    assert.equal(io.common.mode, 'daemon');
    assert.equal(io.common.adminUI.config, 'json');
    assert.ok(io.common.dependencies.some(item => item['js-controller'] === '>=7.2.2'));
    assert.match(pkg.repository.url, /SvenM74\/iobroker\.velux-extended\.git$/);
});

test('native fields and the admin form stay aligned without nested tab data', () => {
    assert.equal(config.type, 'tabs');
    const fields = configFields(config);
    assert.deepEqual([...fields.keys()].sort(), Object.keys(io.native).sort());
    assert.equal(fields.get('pollInterval').type, 'number');
    assert.equal(fields.get('pollInterval').min, 15);
    assert.ok(io.native.pollInterval >= fields.get('pollInterval').min);
    assert.ok(io.native.requestTimeout >= fields.get('requestTimeout').min);
    assert.equal(io.native.enableEvents, true);
    assert.equal(io.native.allowIndividualStop, false);
    assert.equal(io.native.forceCommands, false);
    assert.equal(io.native.rawData, false);
    const gateways = fields.get('gateways');
    assert.equal(gateways.type, 'table');
    assert.deepEqual(gateways.items.map(item => item.attr), ['id', 'host', 'signingScheme']);
    const scheme = gateways.items.find(item => item.attr === 'signingScheme');
    assert.equal(scheme.default, 'auto');
    assert.deepEqual(scheme.options.map(item => item.value), ['auto', 'hmac', 'sha512']);
    assert.ok(Array.isArray(io.native.gateways));
});

test('all authentication secrets are encrypted, protected and masked in the admin form', () => {
    const fields = configFields(config);
    assert.deepEqual([...io.encryptedNative].sort(), [...secretFields].sort());
    assert.deepEqual([...io.protectedNative].sort(), [...secretFields].sort());
    for (const secret of secretFields) {
        assert.equal(io.native[secret], '');
        assert.equal(fields.get(secret).type, 'password');
    }
    const allFields = [...fields.keys(), ...fields.get('gateways').items.map(item => item.attr)];
    assert.ok(!allFields.some(field => /hash_sign_key|sign_key_id|pincode/i.test(field)), 'Pairing keys and PINs do not belong in normal admin fields');
});

test('every admin label and explanation has German and English text', () => {
    assert.equal(config.i18n, true);
    const strings = translatedStrings(config);
    for (const language of ['de', 'en']) {
        const translations = readJson(`admin/i18n/${language}/translations.json`);
        for (const key of strings) {
            assert.equal(typeof translations[key], 'string', `Missing ${language} translation: ${key}`);
            assert.ok(translations[key].trim(), `Empty ${language} translation: ${key}`);
        }
        assert.deepEqual(Object.keys(translations).sort(), [...strings].sort());
    }
});

test('the adapter has a local icon and an explicit read-only connection state', () => {
    const icon = fs.readFileSync(path.join(root, 'admin', io.common.icon));
    assert.equal(icon.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(icon.length > 24);
    assert.ok(icon.readUInt32BE(16) > 0, 'Icon width must be positive');
    assert.equal(icon.readUInt32BE(16), icon.readUInt32BE(20), 'The adapter icon must be square');
    const connection = io.instanceObjects.find(object => object._id === 'info.connection');
    assert.equal(connection.type, 'state');
    assert.equal(connection.common.type, 'boolean');
    assert.equal(connection.common.role, 'indicator.connected');
    assert.equal(connection.common.read, true);
    assert.equal(connection.common.write, false);
    assert.equal(connection.common.def, false);
});

test('the distributable includes documentation and licenses without research dumps', () => {
    for (const file of ['main.js', 'io-package.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
        assert.ok(pkg.files.includes(file), `${file} must be included in the npm package`);
        assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
    }
    assert.ok(pkg.files.includes('lib/'));
    assert.ok(pkg.files.includes('admin/'));
    assert.ok(pkg.files.includes('docs/'));
    for (const file of ['docs/STATE_MODEL.md', 'docs/protocol.md']) assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
    assert.ok(!pkg.files.some(file => /(?:analysis|\.apk|\.dex|credentials|gateway-keys|node_modules)/i.test(file)));
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (const pattern of ['node_modules/', '*.apk', '*.dex', '.env', 'credentials*.json']) assert.ok(ignore.includes(pattern));
});

test('CI runs supported Node versions and does not publish the package', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
    assert.match(workflow, /node:\s*\[22,\s*24\]/);
    assert.match(workflow, /npm install --ignore-scripts/);
    assert.match(workflow, /npm test/);
    assert.match(workflow, /npm run check/);
    assert.doesNotMatch(workflow, /npm publish|NPM_TOKEN/);
    assert.match(pkg.scripts.test, /node --test/);
    assert.match(pkg.scripts.check, /--check/);
});
