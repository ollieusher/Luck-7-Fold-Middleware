const fs = require("fs");
const path = require("path");

/** Match server.js / Express defaults; override with CACHE_MAX_KEYS. -1 = unlimited. */
const DEFAULT_CACHE_MAX_KEYS = 2048;

function readCacheMaxEntries() {
  const raw = process.env.CACHE_MAX_KEYS;
  if (raw === undefined || raw === "") return DEFAULT_CACHE_MAX_KEYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CACHE_MAX_KEYS;
  if (n < 0) return -1;
  return Math.max(32, Math.floor(n));
}

/** 0 = disable periodic disk writes (avoids huge JSON.stringify spikes on ephemeral hosts). Set CACHE_DISK_MS=60000 to enable. */
function readPersistIntervalMs() {
  const raw = process.env.CACHE_DISK_MS;
  if (raw === undefined || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

class TtlCache {
  constructor(options = {}) {
    this.store = new Map();
    this.cleanupIntervalMs = options.cleanupIntervalMs || 60_000;
    this.persistencePath =
      options.persistencePath || path.join(process.cwd(), "cache-store.json");
    this.maxEntries = options.maxEntries ?? readCacheMaxEntries();
    this.persistIntervalMs = options.persistIntervalMs ?? readPersistIntervalMs();

    this.loadFromDisk();

    this.cleanupTimer = setInterval(() => {
      this.deleteExpired();
    }, this.cleanupIntervalMs);

    if (this.persistIntervalMs > 0) {
      this.persistTimer = setInterval(() => {
        this.saveToDisk();
      }, this.persistIntervalMs);
    }

    // Do not keep the Node process alive only for cache cleanup.
    if (typeof this.cleanupTimer.unref === "function") {
      this.cleanupTimer.unref();
    }
    if (this.persistTimer && typeof this.persistTimer.unref === "function") {
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
    this.enforceMaxEntries();
  }

  enforceMaxEntries() {
    if (this.maxEntries < 0) return;
    this.deleteExpired();
    while (this.store.size > this.maxEntries) {
      const firstKey = this.store.keys().next().value;
      if (firstKey === undefined) break;
      this.store.delete(firstKey);
    }
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
      this.enforceMaxEntries();
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
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.saveToDisk();
  }
}

const cache = new TtlCache();

module.exports = { cache };