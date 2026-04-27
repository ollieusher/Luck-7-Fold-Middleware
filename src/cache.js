class TtlCache {
  constructor(options = {}) {
    this.store = new Map();
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60_000;
    this.cleanupTimer = setInterval(() => {
      this.deleteExpired();
    }, this.cleanupIntervalMs);

    // Do not keep the Node process alive only for cache cleanup.
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
  }

  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  set(key, value, ttlSeconds) {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }

  deleteExpired() {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (now > item.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
  }
}

const cache = new TtlCache();

module.exports = { cache };