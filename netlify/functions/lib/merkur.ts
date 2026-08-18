/**
 * Merkur Xtip adapter — ported from merkur_adapter.py.
 *
 * Merkur encodes each match as a player-vs-opponent event (not a team matchup).
 *   home   = player name  (e.g. "Clark C.")
 *   away   = opponent team (e.g. "Indiana Fever")
 *   odds   = {oddId: decimal_odds, ...}   — already in decimal, no conversion
 *   params = {ouPlPoints: "19.5", ouPlAssists: "8.5", ...}
 *
 * Leagues are auto-discovered: any esMatch entry with at least one player-prop
 * parameter is accepted regardless of leagueId.
 */
import type { Context } from "@netlify/functions";
import { loadWithCache } from "./cache.js";
import { toCanonicalName } from "./name-utils.js";
import type { PropRecord } from "./types.js";

export const MERKUR_SK_URL =
  "https://www.merkurxtip.rs/restapi/offer/sr/sport/SK/mob" +
  "?annex=0&desktopVersion=2.44.3.18&locale=sr";

const IGRACI_RE = /\s+igra[čc][ei]\s*$/i;

const BOOKMAKER_NAME = "Merkur Xtip";

const CACHE_STORE = "merkur-cache";
const CACHE_TTL_SECONDS = 300;

// param key -> market name (used to read the line value)
const PARAM_TO_MARKET: Record<string, string> = {
  ouPlPoints: "points",
  ouPlAssists: "assists",
  ouPlRebounds: "rebounds",
  ouPl3Points: "three_pointers",
  ouPlTPRA: "tpra",
};

// market -> (over_odd_id, under_odd_id)
const MARKET_ODD_IDS: Record<string, [string, string]> = {
  points: ["51679", "51681"],
  assists: ["51682", "51684"],
  rebounds: ["51685", "51687"],
  three_pointers: ["51688", "51690"],
  tpra: ["55215", "55217"],
};

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

function leagueLabel(match: any): string {
  const raw = (match.leagueName || match.league || "").trim();
  if (raw) {
    return raw.replace(IGRACI_RE, "").trim();
  }
  const leagueId = match.leagueId;
  return leagueId !== undefined && leagueId !== null ? `League ${leagueId}` : "Unknown";
}

async function fetchMerkurProps(): Promise<any> {
  const response = await fetch(MERKUR_SK_URL, { headers: HEADERS });
  return response.json();
}

function parseMerkurAllLeagues(raw: any): PropRecord[] {
  const records: PropRecord[] = [];
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  for (const match of raw.esMatches ?? []) {
    const params = match.params ?? {};
    if (!Object.keys(params).some((k) => k in PARAM_TO_MARKET)) continue;

    const league = leagueLabel(match);
    const player = toCanonicalName((match.home || "").trim());
    const opponent = (match.away || "").trim();
    const oddsRaw = match.odds ?? {};

    if (!player) continue;

    const game = opponent || "Unknown";

    const kickoffMs = match.kickOffTime;
    const kickoffTime = kickoffMs
      ? new Date(kickoffMs).toISOString().replace(/\.\d{3}Z$/, "Z")
      : "";

    for (const [paramKey, market] of Object.entries(PARAM_TO_MARKET)) {
      const rawLine = params[paramKey];
      if (rawLine === undefined || rawLine === null) continue;
      const line = Number(rawLine);
      if (Number.isNaN(line) || line === 0) continue; // 0 = "no line" placeholder

      const [overId, underId] = MARKET_ODD_IDS[market];
      const overOdds = oddsRaw[overId];
      const underOdds = oddsRaw[underId];

      if (overOdds === undefined && underOdds === undefined) continue;

      records.push({
        league,
        game,
        team: "",
        player,
        market,
        line,
        over_odds_decimal: overOdds !== undefined ? Number(overOdds) : null,
        under_odds_decimal: underOdds !== undefined ? Number(underOdds) : null,
        bookmaker: BOOKMAKER_NAME,
        kickoff_time: kickoffTime,
        updated_at: timestamp,
      });
    }
  }

  return records;
}

export async function loadMerkurProps(context: Context): Promise<PropRecord[]> {
  return loadWithCache(
    CACHE_STORE,
    CACHE_TTL_SECONDS,
    async () => parseMerkurAllLeagues(await fetchMerkurProps()),
    context
  );
}
