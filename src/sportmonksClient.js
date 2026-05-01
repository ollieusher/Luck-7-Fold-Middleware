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

async function requestSportmonks(path, query, cachePolicy) {
  const url = buildUrl(path, query);
  const cacheKey = `${path}?${new URL(url).searchParams.toString()}`;

  if (cachePolicy && cachePolicy.ttlSeconds > 0) {
    const cached = cache.get(cacheKey);
    if (cached) return { payload: cached, cache: "HIT", source: "cache" };
  }

  const response = await fetch(url, { method: "GET" });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`Sportmonks error ${response.status}: ${body}`);
    error.status = response.status;
    throw error;
  }

  const payload = await response.json();
  if (cachePolicy && cachePolicy.ttlSeconds > 0) {
    cache.set(cacheKey, payload, cachePolicy.ttlSeconds);
  }

  return { payload, cache: "MISS", source: "sportmonks" };
}

function toSimpleFixture(item) {
  return {
    id: item.id,
    starting_at: item.starting_at,
    league: item.league || null,
    participants: item.participants || [],
    state: item.state || null,
    scores: item.scores || [],
    predictions: item.predictions || [],
    odds: item.odds || []
  };
}

async function getFixturesByDate(date) {
  const include = "participants;league;odds";
  const result = await requestSportmonks(
    `/football/fixtures/date/${date}`,
    { include, per_page: 50 },
    { ttlSeconds: config.cacheTtls.fixtureCore }
  );

  return {
    ...result,
    payload: {
      date,
      fixtures: (result.payload.data || []).map(toSimpleFixture)
    }
  };
}

async function getFixturesMulti(ids) {
  const include = "participants;league;predictions.type;odds";
  const result = await requestSportmonks(
    `/football/fixtures/multi/${ids.join(",")}`,
    { include, per_page: 50 },
    { ttlSeconds: config.cacheTtls.odds }
  );

  return {
    ...result,
    payload: {
      fixtures: (result.payload.data || []).map(toSimpleFixture)
    }
  };
}

async function getValueBets(from, to) {
  const include = "participants;league;predictions.type;odds";
  const filters = "predictionTypes:33";
  const result = await requestSportmonks(
    `/football/fixtures/between/${from}/${to}`,
    { include, filters, per_page: 25 },
    { ttlSeconds: config.cacheTtls.predictions }
  );

  return {
    ...result,
    payload: {
      from,
      to,
      fixtures: (result.payload.data || []).map(toSimpleFixture)
    }
  };
}

async function getResultsByDate(date) {
  const include = "participants;scores;state";
  const result = await requestSportmonks(
    `/football/fixtures/date/${date}`,
    { include, per_page: 50 },
    { ttlSeconds: config.cacheTtls.fixtureCore }
  );

  return {
    ...result,
    payload: {
      date,
      fixtures: (result.payload.data || []).map(toSimpleFixture)
    }
  };
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
    { per_page: 5 },
    { ttlSeconds: config.cacheTtls.fixtureCore }
  );
}

module.exports = {
  getFixturesByDate,
  getFixturesMulti,
  getValueBets,
  getResultsByDate,
  getSchedulesByTeam,
  getHeadToHead
};
