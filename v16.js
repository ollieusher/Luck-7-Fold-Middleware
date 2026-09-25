/**
 * v1.6 response shaping.
 *
 * Everything in here is used ONLY when a request carries ?shape=v16. The live v1.5
 * app never sends that flag, so its responses are byte-for-byte what they were
 * before this file existed. Android and iOS v1.6 send it and share this logic.
 */

/** Requests opt in with ?shape=v16. */
function isV16(req) {
  return req && req.query && req.query.shape === "v16";
}

/** ?shape=v16&debug=full returns the unselected odds (market_description etc.). */
function isDebugFull(req) {
  return isV16(req) && req.query.debug === "full";
}

const ODD_FIELDS = "market_id,label,value,total,latest_bookmaker_update";

const MULTI_INCLUDE =
  `participants;league.country;predictions.type;odds:${ODD_FIELDS};weatherReport`;
const MULTI_INCLUDE_DEBUG = "participants;league.country;predictions.type;odds;weatherReport";
const TEAMSHEET_INCLUDE = "participants;predictedLineups;lineups;metadata";

/** Held picks only, so never more than a slip's worth. */
const MAX_TEAMSHEET_IDS = 7;

/** v1.5's 12-hour cache on odds is far staler than any bookmaker lag, so v16 uses 30 min. */
const MULTI_TTL_SECONDS = 30 * 60;

/** Drop a price this many hours older than the freshest quote for the same selection. */
function staleHours() {
  const n = Number(process.env.ODDS_STALE_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

/* ------------------------------------------------------------------ */
/* /fixtures/date                                                      */
/* ------------------------------------------------------------------ */

/**
 * has_odds:false fixtures never carry a price (10 of 10 in the sample), and
 * placeholder:true fixtures have no teams yet. Neither can become a pick.
 * Returns a new body; the cached one is shared and must not be mutated.
 */
function filterDateFixtures(body) {
  if (!body || !Array.isArray(body.data)) return body;
  const data = body.data.filter((f) => f && f.has_odds !== false && f.placeholder !== true);
  return { ...body, data };
}

/* ------------------------------------------------------------------ */
/* Double Chance labels                                                */
/* ------------------------------------------------------------------ */

const CANONICAL_DC = { "home/draw": "Home/Draw", "draw/away": "Draw/Away", "home/away": "Home/Away" };
const STOP_WORDS = new Set(["fc", "cf", "sc", "ac", "afc", "fk", "bk", "sk", "cd", "ud", "sd", "club", "the", "and", "des", "del", "los"]);

function normaliseName(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameTokens(s) {
  return normaliseName(s).split(" ").filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

function sideOf(part, home, away) {
  const n = normaliseName(part);
  if (n === "draw" || n === "x") return "D";
  if (n === "home" || n === "1") return "H";
  if (n === "away" || n === "2") return "A";
  if (n && n === normaliseName(home)) return "H";
  if (n && n === normaliseName(away)) return "A";
  const tokens = new Set(nameTokens(part));
  if (!tokens.size) return null;
  // Whole-token match, or one token (5+ letters) a prefix of the other:
  // 'Halmstad' ~ 'Halmstads BK', 'Forest' ~ 'Nottingham Forest'.
  const hits = (team) =>
    nameTokens(team).some(
      (x) =>
        tokens.has(x) ||
        [...tokens].some((y) => (y.length >= 5 && x.startsWith(y)) || (x.length >= 5 && y.startsWith(x)))
    );
  const h = hits(home);
  const a = hits(away);
  if (h && !a) return "H";
  if (a && !h) return "A";
  return null; // no match, or matches both teams (a derby) — never guess
}

/**
 * Bookmaker 2 labels Double Chance with team names ("Rosenborg or HamKam").
 * Resolve against this fixture's own participants, or return null to drop the row.
 * A wrongly resolved row would describe a bet the user didn't make, so anything
 * uncertain is dropped, exactly as the app already does.
 */
function resolveDoubleChance(label, home, away) {
  if (!label) return null;
  const direct = CANONICAL_DC[String(label).trim().toLowerCase()];
  if (direct) return direct;
  const parts = String(label)
    .split(/\s+or\s+|\s*\/\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const a = sideOf(parts[0], home, away);
  const b = sideOf(parts[1], home, away);
  if (!a || !b || a === b) return null;
  const key = [a, b].sort().join("");
  return { DH: "Home/Draw", AD: "Draw/Away", AH: "Home/Away" }[key] || null;
}

/* ------------------------------------------------------------------ */
/* /fixtures/multi                                                     */
/* ------------------------------------------------------------------ */

function participantNames(fixture) {
  const list = Array.isArray(fixture.participants) ? fixture.participants : [];
  const find = (loc) => {
    const p = list.find((x) => x && x.meta && x.meta.location === loc);
    return p ? p.name : undefined;
  };
  return { home: find("home"), away: find("away") };
}

function parseUpdate(s) {
  if (!s || typeof s !== "string") return null;
  const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? null : t;
}

function shapeOdds(fixture, stats) {
  if (!Array.isArray(fixture.odds)) return fixture.odds;
  const { home, away } = participantNames(fixture);

  // 1. Double Chance labels to canonical form; drop what can't be resolved.
  const labelled = [];
  for (const row of fixture.odds) {
    if (row && row.market_id === 2) {
      const canonical = resolveDoubleChance(row.label, home, away);
      if (!canonical) {
        stats.dcDropped++;
        continue;
      }
      if (canonical !== row.label) stats.dcRecovered++;
      labelled.push(canonical === row.label ? row : { ...row, label: canonical });
    } else {
      labelled.push(row);
    }
  }

  // 2. Stale prices: drop any row far older than the freshest quote for the same
  //    selection. Relative, because "untouched for a day" three days out can just
  //    mean nothing moved, while "a day behind every other bookmaker" is stale.
  const limitMs = staleHours() * 3600 * 1000;
  const freshest = new Map();
  const keyOf = (r) => `${r.market_id}|${String(r.label).toLowerCase()}|${r.total == null ? "" : r.total}`;
  for (const r of labelled) {
    const t = parseUpdate(r && r.latest_bookmaker_update);
    if (t == null) continue;
    const k = keyOf(r);
    if (!freshest.has(k) || freshest.get(k) < t) freshest.set(k, t);
  }
  return labelled.filter((r) => {
    const t = parseUpdate(r && r.latest_bookmaker_update);
    if (t == null) return true; // no timestamp: keep, as today
    const stale = freshest.get(keyOf(r)) - t > limitMs;
    if (stale) stats.staleDropped++;
    return !stale;
  });
}

/** Applied to the merged /fixtures/multi body before it is cached. */
function transformMulti(body) {
  if (!body || !Array.isArray(body.data)) return body;
  const stats = { dcRecovered: 0, dcDropped: 0, staleDropped: 0 };
  const data = body.data.map((f) => (f && Array.isArray(f.odds) ? { ...f, odds: shapeOdds(f, stats) } : f));
  return { ...body, data, v16: { shape: "v16", staleHours: staleHours(), ...stats } };
}

/* ------------------------------------------------------------------ */
/* /fixtures/teamsheets                                                */
/* ------------------------------------------------------------------ */

const LINEUP_CONFIRMED_TYPE = 572; // metadata: { confirmed: true|false }
const FORMATIONS_TYPE = 159; // metadata: { home: "4-3-3", away: "4-4-2" }
const STARTER_TYPE = 11;
const BENCH_TYPE = 12;

function metadataValue(fixture, typeId) {
  const list = Array.isArray(fixture.metadata) ? fixture.metadata : [];
  const m = list.find((x) => x && x.type_id === typeId);
  return m ? m.values : undefined;
}

function player(row) {
  return {
    player_id: row.player_id,
    name: row.player_name,
    number: row.jersey_number == null ? null : row.jersey_number,
    position_id: row.position_id == null ? null : row.position_id,
    formation_field: row.formation_field == null ? null : row.formation_field,
    formation_position: row.formation_position == null ? null : row.formation_position
  };
}

function byFormationPosition(a, b) {
  const pa = a.formation_position == null ? 99 : a.formation_position;
  const pb = b.formation_position == null ? 99 : b.formation_position;
  return pa - pb;
}

/**
 * One fixture's team sheet. CONFIRMED only when Sportmonks' own flag
 * (metadata type 572) says so AND starters are present. The `lineups` list on its
 * own proves nothing: on 25 Sep it was filled three hours early with 5 of 22
 * starters wrong.
 */
function buildTeamsheet(fixture) {
  const parts = Array.isArray(fixture.participants) ? fixture.participants : [];
  const team = (loc) => parts.find((p) => p && p.meta && p.meta.location === loc) || {};
  const home = team("home");
  const away = team("away");
  const flag = metadataValue(fixture, LINEUP_CONFIRMED_TYPE);
  const confirmedFlag = flag && typeof flag.confirmed === "boolean" ? flag.confirmed : null;
  const formations = metadataValue(fixture, FORMATIONS_TYPE) || {};

  const lineups = Array.isArray(fixture.lineups) ? fixture.lineups : [];
  const predicted = Array.isArray(fixture.predictedlineups)
    ? fixture.predictedlineups
    : Array.isArray(fixture.predictedLineups)
    ? fixture.predictedLineups
    : [];

  const side = (teamId, rows, typeFilter) =>
    rows.filter((r) => r && r.team_id === teamId && typeFilter(r)).map(player).sort(byFormationPosition);

  const confirmedStarters = lineups.filter((r) => r && r.type_id === STARTER_TYPE);
  let status = "none";
  let build;
  if (confirmedFlag === true && confirmedStarters.length > 0) {
    status = "confirmed";
    build = (t) => ({
      xi: side(t.id, lineups, (r) => r.type_id === STARTER_TYPE),
      bench: side(t.id, lineups, (r) => r.type_id === BENCH_TYPE)
    });
  } else if (predicted.length > 0) {
    status = "projected";
    build = (t) => ({ xi: side(t.id, predicted, () => true).slice(0, 11), bench: [] });
  } else {
    build = () => ({ xi: [], bench: [] });
  }

  return {
    fixture_id: fixture.id,
    starting_at_timestamp: fixture.starting_at_timestamp,
    status,
    confirmed_flag: confirmedFlag,
    home: { team_id: home.id, name: home.name, formation: formations.home || null, ...build(home) },
    away: { team_id: away.id, name: away.name, formation: formations.away || null, ...build(away) }
  };
}

function transformTeamsheets(body) {
  if (!body || !Array.isArray(body.data)) return body;
  return { data: body.data.filter(Boolean).map(buildTeamsheet), shape: "v16" };
}

/**
 * Short cache while a line-up could still flip to confirmed; long otherwise.
 * Receives the transformed body.
 */
function teamsheetTtl(body) {
  const now = Date.now() / 1000;
  const sheets = body && Array.isArray(body.data) ? body.data : [];
  const waiting = sheets.some(
    (s) => s.status !== "confirmed" && s.starting_at_timestamp && s.starting_at_timestamp - now < 3 * 3600
  );
  return waiting ? 120 : 30 * 60;
}

/* ------------------------------------------------------------------ */
/* Rate limit telemetry                                                */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_WARN_BELOW = 500;
const rateLimits = {};
let lastWarnedAt = 0;

/** Every Sportmonks response carries rate_limit; keep the latest and warn when low. */
function noteRateLimit(body) {
  const rl = body && typeof body === "object" ? body.rate_limit : null;
  if (!rl || typeof rl.remaining !== "number") return;
  const entity = rl.requested_entity || "unknown";
  rateLimits[entity] = { remaining: rl.remaining, resets_in_seconds: rl.resets_in_seconds, seen_at: new Date().toISOString() };
  if (rl.remaining < RATE_LIMIT_WARN_BELOW && Date.now() - lastWarnedAt > 5 * 60 * 1000) {
    lastWarnedAt = Date.now();
    process.stderr.write(
      `Sportmonks rate limit low: ${rl.remaining} left for ${entity}, resets in ${rl.resets_in_seconds}s\n`
    );
  }
}

function rateLimitSnapshot() {
  return { ...rateLimits };
}

module.exports = {
  isV16,
  isDebugFull,
  MULTI_INCLUDE,
  MULTI_INCLUDE_DEBUG,
  TEAMSHEET_INCLUDE,
  MAX_TEAMSHEET_IDS,
  MULTI_TTL_SECONDS,
  filterDateFixtures,
  resolveDoubleChance,
  transformMulti,
  buildTeamsheet,
  transformTeamsheets,
  teamsheetTtl,
  noteRateLimit,
  rateLimitSnapshot
};
