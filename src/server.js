const http = require("http");
const { URL } = require("url");
const { config } = require("./config");
const {
  getFixturesByDate,
  getFixturesMulti,
  getFixtureResult,
  getValueBets,
  getResultsByDate,
  getSchedulesByTeam,
  getHeadToHead,
  getLiveScores
} = require("./sportmonksClient");

const memoryDebugEnabled = false;

function logError(context, error) {
  const err = error instanceof Error ? error : new Error(String(error));
  process.stderr.write(
    `[${new Date().toISOString()}] ${context}: ${err.message}\n${err.stack || ""}\n`
  );
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function logMemoryUsage(context) {
  const mem = process.memoryUsage();
  process.stdout.write(
    `[${new Date().toISOString()}] ${context} rss=${formatMb(mem.rss)} heapUsed=${formatMb(mem.heapUsed)} heapTotal=${formatMb(mem.heapTotal)} external=${formatMb(mem.external)} uptimeSec=${Math.round(process.uptime())}\n`
  );
}

function getMemorySnapshot() {
  const mem = process.memoryUsage();
  return {
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    heapTotalBytes: mem.heapTotal,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers,
    rssMb: formatMb(mem.rss),
    heapUsedMb: formatMb(mem.heapUsed),
    heapTotalMb: formatMb(mem.heapTotal),
    externalMb: formatMb(mem.external),
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  };
}

function sendJson(res, statusCode, payload, cacheStatus) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (cacheStatus) res.setHeader("X-Cache", cacheStatus);
  res.end(JSON.stringify(payload));
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isNumericId(value) {
  return /^\d+$/.test(value);
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return sendJson(res, 204, {});
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = requestUrl;
  console.log(`Incoming: ${req.method} ${pathname}`);

  try {
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { status: "ok" });
    }

    if (req.method === "GET" && pathname.startsWith("/fixtures/date/")) {
      const date = pathname.slice("/fixtures/date/".length);
      if (!isIsoDate(date)) {
        return sendJson(res, 400, { error: "Invalid date format, expected YYYY-MM-DD" });
      }
      const result = await getFixturesByDate(date);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname.startsWith("/fixtures/result/")) {
      const id = pathname.slice("/fixtures/result/".length);
      if (!isNumericId(id)) {
        return sendJson(res, 400, { error: "id must be numeric" });
      }
      const result = await getFixtureResult(id);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname.startsWith("/fixtures/multi/")) {
      const ids = pathname
        .slice("/fixtures/multi/".length)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      if (ids.length === 0 || ids.length > 50) {
        return sendJson(res, 400, { error: "Provide 1-50 comma-separated fixture IDs" });
      }
      const result = await getFixturesMulti(ids);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname.startsWith("/fixtures/between/")) {
      const parts = pathname.split("/");
      const from = parts[3];
      const to = parts[4];
      if (!isIsoDate(from) || !isIsoDate(to)) {
        return sendJson(res, 400, { error: "Invalid date format, expected YYYY-MM-DD" });
      }
      const result = await getValueBets(from, to);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname.startsWith("/schedules/teams/")) {
      const teamId = pathname.slice("/schedules/teams/".length);
      if (!isNumericId(teamId)) {
        return sendJson(res, 400, { error: "teamId must be numeric" });
      }
      const result = await getSchedulesByTeam(teamId);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname.startsWith("/h2h/")) {
      const parts = pathname.split("/");
      const homeId = parts[2];
      const awayId = parts[3];
      if (!isNumericId(homeId) || !isNumericId(awayId)) {
        return sendJson(res, 400, { error: "homeId and awayId must be numeric" });
      }
      const result = await getHeadToHead(homeId, awayId);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname.startsWith("/results/")) {
      const date = pathname.slice("/results/".length);
      if (!isIsoDate(date)) {
        return sendJson(res, 400, { error: "Invalid date format, expected YYYY-MM-DD" });
      }
      const result = await getResultsByDate(date);
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname === "/livescores") {
      const result = await getLiveScores();
      return sendJson(res, 200, result.payload, result.cache);
    }

    if (req.method === "GET" && pathname === "/debug/memory") {
      if (!memoryDebugEnabled) {
        return sendJson(res, 404, { error: "Route not found" });
      }
      return sendJson(res, 200, { memory: getMemorySnapshot() });
    }

    return sendJson(res, 404, { error: "Route not found" });
  } catch (error) {
    logError(`Request failed: ${req.method} ${pathname}`, error);
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
const memoryLogIntervalMs = Number(process.env.MEMORY_LOG_INTERVAL_MS || 0);

if (Number.isFinite(memoryLogIntervalMs) && memoryLogIntervalMs > 0) {
  const timer = setInterval(() => {
    logMemoryUsage("Process memory");
  }, memoryLogIntervalMs);
  timer.unref();
}

server.requestTimeout = Math.max(1000, config.timeouts.serverRequestMs);
server.headersTimeout = Math.max(server.requestTimeout + 1000, config.timeouts.serverHeadersMs);

process.on("unhandledRejection", (reason) => {
  logError("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error) => {
  logError("Uncaught exception", error);
  logMemoryUsage("Process memory at uncaughtException");
  process.exit(1);
});

server.listen(config.port, () => {
  logMemoryUsage("Process memory on startup");
  process.stdout.write(
    `Sportmonks middleware running on http://localhost:${config.port}\n`
  );
});
