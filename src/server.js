const http = require("http");
const { URL } = require("url");
const { config } = require("./config");
const {
  getFixturesByDate,
  getFixturesMulti,
  getValueBets,
  getResultsByDate
} = require("./sportmonksClient");

function sendJson(res, statusCode, payload, cacheStatus) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (cacheStatus) res.setHeader("X-Cache", cacheStatus);
  res.end(JSON.stringify(payload));
}

function parseDateShift(daysToAdd) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return date.toISOString().slice(0, 10);
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = requestUrl;

  try {
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/fixtures/upcoming") {
      const dates = [parseDateShift(0), parseDateShift(1), parseDateShift(2)];
      const results = await Promise.all(dates.map((date) => getFixturesByDate(date)));
      const cacheHeader = results.map((x) => x.cache).join(",");
      return sendJson(
        res,
        200,
        {
          dates,
          fixturesByDate: results.map((r) => r.payload)
        },
        cacheHeader
      );
    }

    if (req.method === "GET" && pathname === "/api/fixtures/details") {
      const idsRaw = searchParams.get("ids") || "";
      const ids = idsRaw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);

      if (ids.length === 0 || ids.length > 50) {
        return sendJson(res, 400, {
          error: "Provide ids query param with 1-50 comma-separated fixture ids"
        });
      }

      const result = await getFixturesMulti(ids);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname === "/api/value-bets") {
      const from = searchParams.get("from");
      const to = searchParams.get("to");

      if (!from || !to) {
        return sendJson(res, 400, {
          error: "from and to query params are required (YYYY-MM-DD)"
        });
      }

      const result = await getValueBets(from, to);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname === "/api/results/today") {
      const date = searchParams.get("date") || parseDateShift(0);
      const result = await getResultsByDate(date);
      return sendJson(res, 200, result.payload, result.cache);
    }

    return sendJson(res, 404, { error: "Route not found" });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: "Middleware request failed",
      message: error.message
    });
  }
}

if (!config.sportmonksToken) {
  process.stderr.write(
    "Missing SPORTMONKS_TOKEN. Set it in environment before starting the server.\n"
  );
  process.exit(1);
}

const server = http.createServer(handler);

server.listen(config.port, () => {
  process.stdout.write(
    `Sportmonks middleware running on http://localhost:${config.port}\n`
  );
});
