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
const DEFAULT_CACHE_MAX_KEYS = 3072;

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

/** Hard stop on pagination so a malformed has_more cannot spin forever. */
const MAX_PAGINATED_PAGES = 10;

/** A page failure leaves a truncated result; cache it briefly so it self-heals. */
const PARTIAL_RESULT_TTL_SECONDS = 60;

const TTL_SECONDS = {
  fixturesByDate: 30 * 60,
  fixturesMulti: 12 * 60 * 60,
  fixturesBetween: 30 * 60,
  tournamentFixtures: 30 * 60,
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

async function fetchSportmonksPage(path, queryParams) {
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

  return { statusCode: response.status, body };
}

function hasMorePages(body) {
  return Boolean(body && body.pagination && body.pagination.has_more);
}

/**
 * Sportmonks returns fixtures sorted by kick-off, so a truncated first page hides the
 * evening programme. Re-issue the same query with an incrementing page rather than
 * following pagination.next_page, which comes back without the api_token.
 */
async function fetchAllPages(path, queryParams) {
  const first = await fetchSportmonksPage(path, queryParams);
  const firstBody = first.body;

  if (!firstBody || typeof firstBody !== "object" || !Array.isArray(firstBody.data)) {
    return { ...first, stoppedOnError: false };
  }

  const data = firstBody.data.slice();
  let latestBody = firstBody;
  let page = 1;
  let stoppedOnError = false;

  while (hasMorePages(latestBody) && page < MAX_PAGINATED_PAGES) {
    page += 1;
    let next;
    try {
      next = await fetchSportmonksPage(path, { ...queryParams, page });
    } catch (error) {
      // Keep the pages already assembled; latestBody still reports has_more, so the
      // caller sees a result honestly marked as truncated rather than a failed request.
      stoppedOnError = true;
      process.stderr.write(
        `Sportmonks page ${page} failed for ${path}: ${error.message}; ` +
          `returning the ${data.length} records assembled so far\n`
      );
      break;
    }
    latestBody = next.body;
    if (!latestBody || !Array.isArray(latestBody.data)) break;
    data.push(...latestBody.data);
  }

  if (!stoppedOnError && hasMorePages(latestBody)) {
    process.stderr.write(
      `Sportmonks pagination cap of ${MAX_PAGINATED_PAGES} pages reached for ${path}; ` +
        `returning ${data.length} records and dropping the remainder\n`
    );
  }

  const pagination =
    latestBody && latestBody.pagination
      ? { ...latestBody.pagination, count: data.length }
      : firstBody.pagination;

  return {
    statusCode: first.statusCode,
    body: { ...firstBody, data, pagination },
    stoppedOnError
  };
}

async function fetchWithCache({ path, queryParams, ttlSeconds, paginate = false }) {
  const cacheKey = buildCacheKey(path, queryParams);
  const cached = cache.get(cacheKey);

  if (cached !== undefined) {
    return { statusCode: 200, payload: cached, cacheStatus: "HIT" };
  }

  const { statusCode, body, stoppedOnError = false } = paginate
    ? await fetchAllPages(path, queryParams)
    : await fetchSportmonksPage(path, queryParams);

  let resolvedTtl =
    typeof ttlSeconds === "function" ? ttlSeconds(body) : ttlSeconds;
  if (stoppedOnError) {
    resolvedTtl = Math.min(resolvedTtl, PARTIAL_RESULT_TTL_SECONDS);
  }
  if (resolvedTtl > 0) {
    cacheSet(cacheKey, body, resolvedTtl);
  }
  return { statusCode, payload: body, cacheStatus: "MISS" };
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
        include: "participants;scores;league.country"
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
        per_page: 50
      },
      paginate: true,
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
        include: "participants;league.country;predictions.type;odds",
        filters: "markets:1,2,14,80",
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
      ttlSeconds: 15
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
        include: "participants;league.country;predictions.type",
        filters: "predictionTypes:33",
        per_page: 50
      },
      paginate: true,
      ttlSeconds: TTL_SECONDS.fixturesBetween
    });
    return sendProxyResponse(res, result);
  } catch (error) {
    return next(error);
  }
});

app.get("/tournament/fixtures/between/:from/:to", async (req, res, next) => {
  const { from, to } = req.params;
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return res.status(400).json({ error: "Invalid date format, expected YYYY-MM-DD" });
  }

  try {
    const result = await fetchWithCache({
      path: `/fixtures/between/${from}/${to}`,
      queryParams: {
        filters: "leagueIds:732",
        include: "participants;league.country"
      },
      ttlSeconds: TTL_SECONDS.tournamentFixtures
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
