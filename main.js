'use strict';

const utils = require('@iobroker/adapter-core');
const { AdapterRuntime } = require('./lib/adapter-runtime');

class VeluxExtended extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'velux-extended' });
        this.runtime = new AdapterRuntime(this);
        this.on('ready', () => this.runtime.start().catch(error => this.log.error(error.message)));
        this.on('stateChange', (id, state) => {
            void this.runtime.onStateChange(id, state).catch(error => this.log.error(error.message));
        });
        this.on('message', message => { void this.runtime.onMessage(message).catch(error => this.log.error(error.message)); });
        this.on('unload', callback => { void this.runtime.stop().catch(error => this.log.warn(error.message)).finally(callback); });
    }
}

if (require.main === module) new VeluxExtended();
else module.exports = options => new VeluxExtended(options);
