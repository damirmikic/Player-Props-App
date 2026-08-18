/**
 * MaxBet RS adapter — ported from maxbet_adapter.py.
 *
 * Each entry in esMatches is a *player* (not a team matchup):
 *   home        -> player full name  ("Aliyah Boston")
 *   away        -> player's team     ("Indiana W")
 *   params      -> {ouPlPoints, ouPlRebounds, ouPlAssists}
 *   odds        -> {tipTypeId: decimal_odds}
 *   kickOffTime -> epoch ms of game start
 *
 * Game strings are reconstructed by pairing the two teams that share a
 * (league, kickOffTime) slot.
 */
import type { Context } from "@netlify/functions";
import { loadWithCache } from "./cache.js";
import { toCanonicalName } from "./name-utils.js";
import type { PropRecord } from "./types.js";

export const BASE_URL =
  "https://www.maxbet.rs/restapi/offer/sr/sport/SK/mob" +
  "?annex=0&desktopVersion=2.44.3.18&locale=sr";

const BOOKMAKER_NAME = "MaxBet";

// MaxBet prefixes player-prop league names with the Serbian phrase
// "Poeni igrača" (Player Points). Strip it to get the bare league name.
const MAXBET_PREFIX_RE = /^poeni\s+igra[čc]a\s*[-–]?\s*/i;

// Tip-type ID -> (market_name, side)
const ODDS_MAP: Record<string, [string, "over" | "under"]> = {
  "51679": ["points", "over"],
  "51681": ["points", "under"],
  "51682": ["assists", "over"],
  "51684": ["assists", "under"],
  "51685": ["rebounds", "over"],
  "51687": ["rebounds", "under"],
};

// Param key -> market name
const PARAM_MARKET: Record<string, string> = {
  ouPlPoints: "points",
  ouPlRebounds: "rebounds",
  ouPlAssists: "assists",
};

const CACHE_STORE = "maxbet-cache";
const CACHE_TTL_SECONDS = 300;

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function get(): Promise<any> {
  const response = await fetch(BASE_URL, { headers: HEADERS });
  return response.json();
}

function epochMsToIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function leagueLabel(entry: any): string {
  const raw = (entry.leagueName || entry.league || "").trim();
  if (raw) {
    return raw.replace(MAXBET_PREFIX_RE, "").trim();
  }
  const leagueId = entry.leagueId;
  return leagueId !== undefined && leagueId !== null ? `League ${leagueId}` : "Unknown";
}

function buildGameStrings(entries: any[]): Map<string, string> {
  const teamsBySlot = new Map<string, Set<string>>();
  for (const e of entries) {
    const slot = `${e.leagueId}|${e.kickOffTime}`;
    const team: string = (e.away || "").trim();
    if (team) {
      const set = teamsBySlot.get(slot) ?? new Set<string>();
      set.add(team);
      teamsBySlot.set(slot, set);
    }
  }

  const gameStrings = new Map<string, string>();
  for (const [slot, teams] of teamsBySlot) {
    const sortedTeams = [...teams].sort();
    if (sortedTeams.length === 2) {
      gameStrings.set(slot, `${sortedTeams[0]} @ ${sortedTeams[1]}`);
    } else {
      // 1 team (no opponent data) or 3+ teams (multiple simultaneous games
      // sharing this slot) — pairing would be a guess. Leave unpaired;
      // the merge step's cross-source resolution fills in the real
      // opponent from another bookmaker.
      gameStrings.set(slot, "");
    }
  }
  return gameStrings;
}

async function fetchMaxbetProps(): Promise<PropRecord[]> {
  const data = await get();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const entries: any[] = data.esMatches ?? [];

  // Auto-discover: keep any entry that exposes at least one player-prop param.
  const plEntries = entries.filter(
    (e) => e.params && Object.keys(e.params).some((k) => k in PARAM_MARKET)
  );

  const gameStrings = buildGameStrings(plEntries);
  const records: PropRecord[] = [];

  for (const e of plEntries) {
    const league = leagueLabel(e);
    const slot = `${e.leagueId}|${e.kickOffTime}`;
    const game = gameStrings.get(slot) ?? "";
    const kickoffTime = epochMsToIso(e.kickOffTime);
    const team: string = (e.away || "").trim();
    const player = toCanonicalName((e.home || "").trim());
    const params = e.params ?? {};
    const odds = e.odds ?? {};

    // Collect over/under per market from the odds dict
    const marketOdds: Record<string, { over: number | null; under: number | null }> = {};
    for (const [tid, [market, side]] of Object.entries(ODDS_MAP)) {
      if (tid in odds) {
        const entry = marketOdds[market] ?? (marketOdds[market] = { over: null, under: null });
        entry[side] = Number(odds[tid]);
      }
    }

    for (const [paramKey, market] of Object.entries(PARAM_MARKET)) {
      const lineStr = params[paramKey];
      if (lineStr === undefined || lineStr === null) continue;
      const line = Number(lineStr);
      if (Number.isNaN(line)) continue;

      const sides = marketOdds[market] ?? { over: null, under: null };
      if (sides.over === null && sides.under === null) continue;

      records.push({
        league,
        game,
        team,
        player,
        market,
        line,
        over_odds_decimal: sides.over,
        under_odds_decimal: sides.under,
        bookmaker: BOOKMAKER_NAME,
        kickoff_time: kickoffTime,
        updated_at: timestamp,
      });
    }
  }

  return records;
}

export async function loadMaxbetProps(context: Context): Promise<PropRecord[]> {
  return loadWithCache(CACHE_STORE, CACHE_TTL_SECONDS, fetchMaxbetProps, context);
}
