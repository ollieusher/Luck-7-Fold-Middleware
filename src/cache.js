const fs = require("fs");
const path = require("path");

class TtlCache {
  constructor(options = {}) {
    this.store = new Map();
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60_000;
    this.persistencePath =
      options.persistencePath || path.join(process.cwd(), "cache-store.json");
    this.persistIntervalMs = options.persistIntervalMs || 60_000;

    this.loadFromDisk();

    this.cleanupTimer = setInterval(() => {
      this.deleteExpired();
    }, this.cleanupIntervalMs);
    this.persistTimer = setInterval(() => {
      this.saveToDisk();
    }, this.persistIntervalMs);

    // Do not keep the Node process alive only for cache cleanup.
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
    if (typeof this.persistTimer.unref === "function") {
      this.persistTimer.unref();
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

  loadFromDisk() {
    if (!fs.existsSync(this.persistencePath)) return;

    try {
      const raw = fs.readFileSync(this.persistencePath, "utf8");
      const data = JSON.parse(raw);
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const now = Date.now();

      for (const entry of entries) {
        if (!entry || typeof entry.key !== "string") continue;
        if (!entry.item || typeof entry.item.expiresAt !== "number") continue;
        if (now > entry.item.expiresAt) continue;
        this.store.set(entry.key, entry.item);
      }
    } catch (_error) {
      // Ignore cache restore issues and continue with empty in-memory cache.
    }
  }

  saveToDisk() {
    this.deleteExpired();
    const serializable = {
      savedAt: Date.now(),
      entries: Array.from(this.store.entries()).map(([key, item]) => ({ key, item }))
    };

    const tmpPath = `${this.persistencePath}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(serializable), "utf8");
      fs.renameSync(tmpPath, this.persistencePath);
    } catch (_error) {
      // Ignore cache persistence issues to avoid breaking request flow.
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
    clearInterval(this.persistTimer);
    this.saveToDisk();
  }
}

const cache = new TtlCache();

module.exports = { cache };