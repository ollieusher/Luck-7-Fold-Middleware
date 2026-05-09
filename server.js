const express = require("express");
const dotenv = require("dotenv");
const NodeCache = require("node-cache");

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SPORTMONKS_TOKEN = process.env.SPORTMONKS_TOKEN;
const SPORTMONKS_BASE_URL =
  process.env.SPORTMONKS_BASE_URL || "https://api.sportmonks.com/v3/football";

if (!SPORTMONKS_TOKEN) {
  throw new Error("Missing SPORTMONKS_TOKEN environment variable.");
}

/**
 * Cap distinct cached API responses (each can be large). Default suits ~8GB RAM; lower CACHE_MAX_KEYS on small instances.
 * Set CACHE_MAX_KEYS=-1 for unlimited (node-cache default; not recommended).
 */
const DEFAULT_CACHE_MAX_KEYS = 2048;

function readCacheMaxKeys() {
  const raw = process.env.CACHE_MAX_KEYS;
  if (raw === undefined || raw === "") return DEFAULT_CACHE_MAX_KEYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_CACHE_MAX_KEYS;
  if (n < 0) return -1;
  return Math.max(32, Math.floor(n));
}

const cacheMaxKeys = readCacheMaxKeys();
const cache = new NodeCache({
  useClones: false,
  stdTTL: 0,
  checkperiod: 60,
  maxKeys: cacheMaxKeys
});

/** node-cache throws ECACHEFULL when full instead of evicting; drop ~20% of keys and retry. */
function cacheSet(key, value, ttlSeconds) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      cache.set(key, value, ttlSeconds);
      return;
    } catch (err) {
      if (!err || err.name !== "ECACHEFULL") throw err;
      const keys = cache.keys();
      if (keys.length === 0) throw err;
      const drop = Math.max(1, Math.ceil(keys.length * 0.2));
      for (let i = 0; i < drop; i++) cache.del(keys[i]);
    }
  }
  cache.set(key, value, ttlSeconds);
}

const TTL_SECONDS = {
  fixturesByDate: 30 * 60,
  fixturesMulti: 12 * 60 * 60,
  fixturesBetween: 30 * 60,
  teamSchedules: 24 * 60 * 60,
  headToHead: 24 * 60 * 60,
  results: 3 * 60,
  liveScores: 60
};

function buildSportmonksUrl(path, queryParams = {}) {
  const url = new URL(`${SPORTMONKS_BASE_URL}${path}`);
  url.searchParams.set("api_token", SPORTMONKS_TOKEN);

  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function buildCacheKey(path, queryParams = {}) {
  const pairs = Object.entries(queryParams)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`);

  return `${path}?${pairs.join("&")}`;
}

async function fetchWithCache({ path, queryParams, ttlSeconds }) {
  const cacheKey = buildCacheKey(path, queryParams);
  const cached = cache.get(cacheKey);

  if (cached !== undefined) {
    return { statusCode: 200, payload: cached, cacheStatus: "HIT" };
  }

  const url = buildSportmonksUrl(path, queryParams);
  const response = await fetch(url.toString(), { method: "GET" });

  const contentType = response.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const error = new Error("Sportmonks request failed");
    error.statusCode = response.status;
    error.payload =
      typeof body === "string"
        ? { message: body || response.statusText }
        : body || { message: response.statusText };
    throw error;
  }

  cacheSet(cacheKey, body, ttlSeconds);
  return { statusCode: response.status, payload: body, cacheStatus: "MISS" };
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function sendProxyResponse(res, result) {
  res.set("X-Cache", result.cacheStatus);
  return res.status(result.statusCode).json(result.payload);
}

function validateIds(idsParam) {
  if (!idsParam) return [];
  return idsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function isNumericId(value) {
  return /^\d+$/.test(value);
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get("/livescores", async (_req, res, next) => {
  try {
    const result = await fetchWithCache({
      path: "/livescores/inplay",
      queryParams: {
        include: "participants;scores;league"
      },
      ttlSeconds: TTL_SECONDS.liveScores
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/fixtures/date/:date", async (req, res, next) => {
  const { date } = req.params;
  if (!isIsoDate(date)) {
    return res.status(400).json({ error: "Invalid date format, expected YYYY-MM-DD" });
  }

  try {
    const result = await fetchWithCache({
      path: `/fixtures/date/${date}`,
      queryParams: {
        include: "participants;league;odds",
        per_page: 50
      },
      ttlSeconds: TTL_SECONDS.fixturesByDate
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/fixtures/multi/:ids", async (req, res, next) => {
  const ids = validateIds(req.params.ids);

  if (ids.length === 0 || ids.length > 50) {
    return res.status(400).json({ error: "Provide 1-50 comma-separated fixture IDs" });
  }

  try {
    const result = await fetchWithCache({
      path: `/fixtures/multi/${ids.join(",")}`,
      queryParams: {
        include: "participants;league;predictions.type;odds",
        per_page: 50
      },
      ttlSeconds: TTL_SECONDS.fixturesMulti
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/fixtures/result/:id", async (req, res, next) => {
  const { id } = req.params;
  if (!isNumericId(id)) {
    return res.status(400).json({ error: "id must be numeric" });
  }

  try {
    const result = await fetchWithCache({
      path: `/fixtures/${id}`,
      queryParams: {
        include: "participants;scores;state"
      },
      ttlSeconds: 60
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/fixtures/between/:from/:to", async (req, res, next) => {
  const { from, to } = req.params;
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return res.status(400).json({ error: "Invalid date format, expected YYYY-MM-DD" });
  }

  try {
    const result = await fetchWithCache({
      path: `/fixtures/between/${from}/${to}`,
      queryParams: {
        include: "participants;league;predictions.type;odds",
        filters: "predictionTypes:33",
        per_page: 25
      },
      ttlSeconds: TTL_SECONDS.fixturesBetween
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/schedules/teams/:teamId", async (req, res, next) => {
  const { teamId } = req.params;
  if (!/^\d+$/.test(teamId)) {
    return res.status(400).json({ error: "teamId must be numeric" });
  }

  try {
    const result = await fetchWithCache({
      path: `/schedules/teams/${teamId}`,
      queryParams: {},
      ttlSeconds: TTL_SECONDS.teamSchedules
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/h2h/:homeId/:awayId", async (req, res, next) => {
  const { homeId, awayId } = req.params;
  if (!/^\d+$/.test(homeId) || !/^\d+$/.test(awayId)) {
    return res.status(400).json({ error: "homeId and awayId must be numeric" });
  }

  try {
    const result = await fetchWithCache({
      path: `/fixtures/head-to-head/${homeId}/${awayId}`,
      queryParams: {
        per_page: 5
      },
      ttlSeconds: TTL_SECONDS.headToHead
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/results/:date", async (req, res, next) => {
  const { date } = req.params;
  if (!isIsoDate(date)) {
    return res.status(400).json({ error: "Invalid date format, expected YYYY-MM-DD" });
  }

  try {
    const result = await fetchWithCache({
      path: `/fixtures/date/${date}`,
      queryParams: {
        include: "participants;scores;state",
        per_page: 50
      },
      ttlSeconds: TTL_SECONDS.results
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;
  const payload =
    error.payload && typeof error.payload === "object"
      ? error.payload
      : { message: error.message || "Internal server error" };

  return res.status(statusCode).json(payload);
});

app.listen(PORT, () => {
  const cap =
    cacheMaxKeys < 0 ? "unlimited" : String(cacheMaxKeys);
  process.stdout.write(
    `Sportmonks middleware listening on port ${PORT} (CACHE_MAX_KEYS=${cap})\n`
  );
});
