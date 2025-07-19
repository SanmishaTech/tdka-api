const { EventEmitter } = require('events');

class DomainEventEmitter extends EventEmitter {
  /**
   * Emit a domain event with a name and payload.
   * @param {string} name - Event name, e.g., 'dayclose.created'.
   * @param {any} payload - Arbitrary event data.
   */
  emitDomainEvent(name, payload) {
    this.emit(name, payload);
  }
}

// Export a singleton instance so the same emitter is shared across the app.
module.exports = new DomainEventEmitter();
