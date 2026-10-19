'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CommandQueue } = require('../lib/queue');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test('gateway stop skips queued movements for that gateway and runs immediately after the active request', { timeout: 2000 }, async t => {
    const queue = new CommandQueue();
    t.after(() => queue.close());
    const gate = deferred();
    const calls = [];
    const active = queue.run('home-a', async () => { calls.push('already sending'); await gate.promise; return 'finished'; }, { gateways: ['gateway-a'], modules: ['a1'], movement: true });
    const discarded = queue.run('home-a', () => { calls.push('must not send'); }, { gateways: ['gateway-a'], modules: ['a2'], movement: true });
    const discardedCheck = assert.rejects(discarded, { code: 'CANCELLED_BY_STOP' });
    const foreignGateway = queue.run('home-a', () => { calls.push('other gateway'); return 'other result'; }, { gateways: ['gateway-b'], modules: ['b1'], movement: true });
    const timer = queue.run('home-a', () => { calls.push('room timer'); }, { gateways: ['gateway-a'], movement: false });
    const stop = queue.run('home-a', () => { calls.push('gateway stop'); return 'stopped'; }, { gateways: ['gateway-a'], stop: true });
    assert.deepEqual(calls, ['already sending']);
    gate.resolve();
    const [result, stopped, other] = await Promise.all([active, stop, foreignGateway, timer, discardedCheck]);
    assert.equal(result, 'finished');
    assert.equal(stopped, 'stopped');
    assert.equal(other, 'other result');
    assert.deepEqual(calls, ['already sending', 'gateway stop', 'other gateway', 'room timer']);
});

test('a stop in one home cannot discard another home request even when gateway strings coincide', { timeout: 2000 }, async t => {
    const queue = new CommandQueue();
    t.after(() => queue.close());
    const a = deferred();
    const b = deferred();
    const calls = [];
    const activeA = queue.run('home-a', () => a.promise);
    const activeB = queue.run('home-b', () => b.promise);
    const queuedB = queue.run('home-b', () => { calls.push('home-b movement'); return 42; }, { gateways: ['same-gateway-text'], modules: ['same-module-text'], movement: true });
    const stopA = queue.run('home-a', () => { calls.push('home-a stop'); }, { gateways: ['same-gateway-text'], stop: true });
    a.resolve();
    await Promise.all([activeA, stopA]);
    assert.deepEqual(calls, ['home-a stop']);
    b.resolve();
    assert.equal(await queuedB, 42);
    await activeB;
    assert.deepEqual(calls, ['home-a stop', 'home-b movement']);
});

test('individual stop removes only requests containing the selected module, leaving its gateway siblings queued', { timeout: 2000 }, async t => {
    const queue = new CommandQueue();
    t.after(() => queue.close());
    const gate = deferred();
    const calls = [];
    const active = queue.run('home-a', () => gate.promise);
    const selected = queue.run('home-a', () => { calls.push('selected movement'); }, { gateways: ['gateway-a'], modules: ['a1'], movement: true });
    const selectedCheck = assert.rejects(selected, { code: 'CANCELLED_BY_STOP' });
    const sibling = queue.run('home-a', () => { calls.push('sibling movement'); }, { gateways: ['gateway-a'], modules: ['a2'], movement: true });
    const other = queue.run('home-a', () => { calls.push('other gateway movement'); }, { gateways: ['gateway-b'], modules: ['b1'], movement: true });
    const stop = queue.run('home-a', () => { calls.push('individual stop'); }, { gateways: ['gateway-a'], stopModules: ['a1'], stop: true });
    gate.resolve();
    await Promise.all([active, stop, sibling, other, selectedCheck]);
    assert.deepEqual(calls, ['individual stop', 'sibling movement', 'other gateway movement']);
});

test('a pending group that would restart the stopped module is discarded as one unsent request', { timeout: 2000 }, async t => {
    const queue = new CommandQueue();
    t.after(() => queue.close());
    const gate = deferred();
    const calls = [];
    const active = queue.run('home-a', () => gate.promise);
    const overlapping = queue.run('home-a', () => { calls.push('overlapping group'); }, { gateways: ['gateway-a'], modules: ['a1', 'a2'], movement: true });
    const overlappingCheck = assert.rejects(overlapping, { code: 'CANCELLED_BY_STOP' });
    const unaffected = queue.run('home-a', () => { calls.push('unaffected group'); }, { gateways: ['gateway-a'], modules: ['a2', 'a3'], movement: true });
    const stop = queue.run('home-a', () => { calls.push('stop a1'); }, { gateways: ['gateway-a'], stopModules: ['a1'], stop: true });
    gate.resolve();
    await Promise.all([active, stop, unaffected, overlappingCheck]);
    assert.deepEqual(calls, ['stop a1', 'unaffected group']);
});

test('a rejected command does not prevent later commands in the same home from executing', { timeout: 2000 }, async t => {
    const queue = new CommandQueue();
    t.after(() => queue.close());
    const gate = deferred();
    const calls = [];
    const failed = queue.run('home-a', () => gate.promise);
    const failureCheck = assert.rejects(failed, /Rejected by cloud/);
    const next = queue.run('home-a', () => { calls.push('next'); return 'accepted'; });
    gate.reject(new Error('Rejected by cloud'));
    assert.equal(await next, 'accepted');
    await failureCheck;
    assert.deepEqual(calls, ['next']);
});

test('close rejects pending and new commands without invoking them or fabricating an active result', { timeout: 2000 }, async () => {
    const queue = new CommandQueue();
    const gate = deferred();
    const calls = [];
    const active = queue.run('home-a', () => gate.promise);
    const pending = queue.run('home-a', () => { calls.push('pending'); });
    const pendingCheck = assert.rejects(pending, { code: 'CLOSED' });
    queue.close();
    await pendingCheck;
    await assert.rejects(queue.run('home-b', () => { calls.push('new'); }), { code: 'CLOSED' });
    gate.resolve('actual active result');
    assert.equal(await active, 'actual active result');
    assert.deepEqual(calls, []);
});
