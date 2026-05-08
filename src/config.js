const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  PORT: 3000,
  SPORTMONKS_BASE_URL: "https://api.sportmonks.com/v3",
  SPORTMONKS_TIMEOUT_MS: 12000,
  SERVER_REQUEST_TIMEOUT_MS: 15000,
  SERVER_HEADERS_TIMEOUT_MS: 16000,
  PREDICTIONS_TTL_SECONDS: 60 * 5,
  ODDS_TTL_SECONDS: 60 * 5,
  FIXTURE_CORE_TTL_SECONDS: 60 * 5
};

function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx < 0) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && !process.env[key]) process.env[key] = value;
  });
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

loadEnvFile();

const config = {
  port: readNumber("PORT", DEFAULTS.PORT),
  sportmonksToken: process.env.SPORTMONKS_TOKEN || "",
  sportmonksBaseUrl: process.env.SPORTMONKS_BASE_URL || DEFAULTS.SPORTMONKS_BASE_URL,
  timeouts: {
    sportmonksMs: readNumber("SPORTMONKS_TIMEOUT_MS", DEFAULTS.SPORTMONKS_TIMEOUT_MS),
    serverRequestMs: readNumber("SERVER_REQUEST_TIMEOUT_MS", DEFAULTS.SERVER_REQUEST_TIMEOUT_MS),
    serverHeadersMs: readNumber("SERVER_HEADERS_TIMEOUT_MS", DEFAULTS.SERVER_HEADERS_TIMEOUT_MS)
  },
  cacheTtls: {
    predictions: readNumber("PREDICTIONS_TTL_SECONDS", DEFAULTS.PREDICTIONS_TTL_SECONDS),
    odds: readNumber("ODDS_TTL_SECONDS", DEFAULTS.ODDS_TTL_SECONDS),
    fixtureCore: readNumber("FIXTURE_CORE_TTL_SECONDS", DEFAULTS.FIXTURE_CORE_TTL_SECONDS)
  }
};

module.exports = { config };
