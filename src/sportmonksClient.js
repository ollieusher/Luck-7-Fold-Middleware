const { config } = require("./config");
const { cache } = require("./cache");

function buildUrl(path, query = {}) {
  const url = new URL(`${config.sportmonksBaseUrl}${path}`);
  url.searchParams.set("api_token", config.sportmonksToken);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  return url.toString();
}

/** Hard stop on pagination so a malformed has_more cannot spin forever. */
const MAX_PAGINATED_PAGES = 10;

/** A page failure leaves a truncated result; cache it briefly so it self-heals. */
const PARTIAL_RESULT_TTL_SECONDS = 60;

async function fetchPage(path, query) {
  const url = buildUrl(path, query);
  const controller = new AbortController();
  const timeoutMs = Math.max(1, config.timeouts.sportmonksMs);
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(url, { method: "GET", signal: controller.signal });
  } catch (error) {
    if (error && error.name === "AbortError") {
      const timeoutError = new Error(`Sportmonks request timed out after ${timeoutMs}ms`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Sportmonks error ${response.status}: ${body}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

function hasMorePages(payload) {
  return Boolean(payload && payload.pagination && payload.pagination.has_more);
}

/**
 * Sportmonks returns fixtures sorted by kick-off, so a truncated first page hides the
 * evening programme. Re-issue the same query with an incrementing page rather than
 * following pagination.next_page, which comes back without the api_token.
 */
async function fetchAllPages(path, query) {
  const firstPayload = await fetchPage(path, query);

  if (!firstPayload || typeof firstPayload !== "object" || !Array.isArray(firstPayload.data)) {
    return { payload: firstPayload, stoppedOnError: false };
  }

  const data = firstPayload.data.slice();
  let latestPayload = firstPayload;
  let page = 1;
  let stoppedOnError = false;

  while (hasMorePages(latestPayload) && page < MAX_PAGINATED_PAGES) {
    page += 1;
    let nextPayload;
    try {
      nextPayload = await fetchPage(path, { ...query, page });
    } catch (error) {
      // Keep the pages already assembled; latestPayload still reports has_more, so the
      // caller sees a result honestly marked as truncated rather than a failed request.
      stoppedOnError = true;
      process.stderr.write(
        `Sportmonks page ${page} failed for ${path}: ${error.message}; ` +
          `returning the ${data.length} records assembled so far\n`
      );
      break;
    }
    latestPayload = nextPayload;
    if (!latestPayload || !Array.isArray(latestPayload.data)) break;
    data.push(...latestPayload.data);
  }

  if (!stoppedOnError && hasMorePages(latestPayload)) {
    process.stderr.write(
      `Sportmonks pagination cap of ${MAX_PAGINATED_PAGES} pages reached for ${path}; ` +
        `returning ${data.length} records and dropping the remainder\n`
    );
  }

  const pagination =
    latestPayload && latestPayload.pagination
      ? { ...latestPayload.pagination, count: data.length }
      : firstPayload.pagination;

  return { payload: { ...firstPayload, data, pagination }, stoppedOnError };
}

async function requestSportmonks(path, query, cachePolicy, options = {}) {
  const cacheKey = `${path}?${new URL(buildUrl(path, query)).searchParams.toString()}`;
  const wantsCache = Boolean(cachePolicy);

  if (wantsCache) {
    const cached = cache.get(cacheKey);
    if (cached) return { payload: cached, cache: "HIT", source: "cache" };
  }

  let payload;
  let stoppedOnError = false;

  if (options.paginate) {
    ({ payload, stoppedOnError } = await fetchAllPages(path, query));
  } else {
    payload = await fetchPage(path, query);
  }

  if (wantsCache) {
    let ttlSeconds =
      typeof cachePolicy.ttlSeconds === "function"
        ? cachePolicy.ttlSeconds(payload)
        : cachePolicy.ttlSeconds;
    if (stoppedOnError) {
      ttlSeconds = Math.min(ttlSeconds, PARTIAL_RESULT_TTL_SECONDS);
    }
    if (ttlSeconds > 0) {
      cache.set(cacheKey, payload, ttlSeconds);
    }
  }

  return { payload, cache: "MISS", source: "sportmonks" };
}

async function getFixturesByDate(date) {
  const include = "participants;league.country;odds";
  const filters = "markets:1,2,14,80";
  return requestSportmonks(
    `/football/fixtures/date/${date}`,
    { include, filters, per_page: 50 },
    { ttlSeconds: config.cacheTtls.fixtureCore },
    { paginate: true }
  );
}

async function getFixturesMulti(ids) {
  const include = "participants;scores;state";
  const filters = "markets:1,2,14,80";
  return requestSportmonks(
    `/football/fixtures/multi/${ids.join(",")}`,
    { include, filters, per_page: 50 },
    { ttlSeconds: 60 }
  );
}

async function getFixtureResult(id) {
  return requestSportmonks(
    `/football/fixtures/${id}`,
    { include: "participants;scores;state" },
    { ttlSeconds: 15 }
  );
}

async function getValueBets(from, to) {
  const include = "participants;league.country;predictions.type";
  const filters = "predictionTypes:33";
  return requestSportmonks(
    `/football/fixtures/between/${from}/${to}`,
    { include, filters, per_page: 50 },
    { ttlSeconds: config.cacheTtls.predictions },
    { paginate: true }
  );
}

async function getResultsByDate(date) {
  const include = "participants;scores;state";
  return requestSportmonks(
    `/football/fixtures/date/${date}`,
    { include, per_page: 50 },
    { ttlSeconds: config.cacheTtls.fixtureCore }
  );
}

async function getSchedulesByTeam(teamId) {
  return requestSportmonks(
    `/football/schedules/teams/${teamId}`,
    {},
    { ttlSeconds: config.cacheTtls.fixtureCore }
  );
}

async function getHeadToHead(homeId, awayId) {
  return requestSportmonks(
    `/football/fixtures/head-to-head/${homeId}/${awayId}`,
    { per_page: 5, include: "participants" },
    { ttlSeconds: config.cacheTtls.fixtureCore }
  );
}

async function getLiveScores() {
  const include = "participants;scores;league.country";
  return requestSportmonks(
    `/football/livescores/inplay`,
    { include },
    { ttlSeconds: 60 }
  );
}

async function getTournamentFixtures(from, to) {
  return requestSportmonks(
    `/football/fixtures/between/${from}/${to}`,
    {
      filters: "leagueIds:732",
      include: "participants;league.country"
    },
    { ttlSeconds: 1800 }
  );
}

module.exports = {
  getFixturesByDate,
  getFixturesMulti,
  getFixtureResult,
  getValueBets,
  getResultsByDate,
  getSchedulesByTeam,
  getHeadToHead,
  getLiveScores,
  getTournamentFixtures
};
