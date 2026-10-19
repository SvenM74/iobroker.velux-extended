'use strict';

/** Order cloud writes per home. A stop removes movements which have not yet been sent. */
class CommandQueue {
    constructor() { this.lanes = new Map(); this.closed = false; }

    run(homeId, task, { gateways = [], modules = [], stopModules = [], movement = false, stop = false } = {}) {
        if (this.closed) return Promise.reject(Object.assign(new Error('Adapter is stopping'), { code: 'CLOSED' }));
        let lane = this.lanes.get(homeId);
        if (!lane) { lane = { running: false, pending: [] }; this.lanes.set(homeId, lane); }
        return new Promise((resolve, reject) => {
            const item = { task, resolve, reject, gateways, modules, movement };
            if (stop) {
                lane.pending = lane.pending.filter(queued => {
                    const affected = stopModules.length ? queued.modules.some(id => stopModules.includes(id)) : queued.gateways.some(id => gateways.includes(id));
                    if (queued.movement && affected) {
                        queued.reject(Object.assign(new Error('Queued movement cancelled by gateway stop'), { code: 'CANCELLED_BY_STOP' }));
                        return false;
                    }
                    return true;
                });
                lane.pending.unshift(item);
            } else lane.pending.push(item);
            this._drain(homeId, lane);
        });
    }

    async _drain(homeId, lane) {
        if (lane.running) return;
        lane.running = true;
        while (lane.pending.length && !this.closed) {
            const item = lane.pending.shift();
            try { item.resolve(await item.task()); } catch (error) { item.reject(error); }
        }
        lane.running = false;
        if (!lane.pending.length) this.lanes.delete(homeId);
    }

    close() {
        this.closed = true;
        for (const lane of this.lanes.values()) {
            for (const item of lane.pending.splice(0)) item.reject(Object.assign(new Error('Adapter is stopping'), { code: 'CLOSED' }));
        }
    }
}

module.exports = { CommandQueue };
