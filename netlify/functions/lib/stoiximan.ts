/**
 * Stoiximan adapter — ported from stoiximan_adapter.py.
 *
 * Offers "N+" threshold bets only (e.g. "21+" = score >= 21).
 * Converted to line = N - 0.5; under_odds_decimal is always null.
 * Per player x market, only the single threshold whose over odds are
 * closest to 1.95 (within 1.70-2.20) is kept.
 */
import type { Context } from "@netlify/functions";
import { loadWithCache } from "./cache.js";
import { toCanonicalName } from "./name-utils.js";
import type { PropRecord } from "./types.js";

export const BASE = "https://en.stoiximan.gr/api/sport/basketball";
const REQ_PARAMS = "req=la,s,stnf,c,mb,mbl";

const BOOKMAKER_NAME = "Stoiximan";

const SUPPORTED_LEAGUES = [
  { path: "spain/liga-endesa/438g", league: "ACB" },
  { path: "spain/supercopa-endesa/471g", league: "ACB" },
  { path: "usa/wnba/440g", league: "WNBA" },
  { path: "israel/super-league/1042g", league: "Izrael" },
  { path: "international/club-friendlies/16726", league: "Club Friendly" },
  { path: "euroleague/euroleague/439g", league: "Euroleague" },
  { path: "euroleague/euroleague-super-cup/1127g", league: "Euroleague" },
  { path: "germany/bbl/458g", league: "BBL" },
];

const PROP_MARKET_TYPES: Record<string, string> = {
  playerspoints: "points",
  playersrebounds: "rebounds",
  playersassists: "assists",
};

const EVENT_MARKET_TYPES: Record<string, string> = {
  PLNP: "points",
  PLNR: "rebounds",
  PLNA: "assists",
  PLN3: "three_pointers",
};

const CACHE_STORE = "stoiximan-cache";
const CACHE_TTL_SECONDS = 300;

const ODDS_TARGET = 1.95;
const ODDS_LO = 1.7;
const ODDS_HI = 2.2;

const HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9,el;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://en.stoiximan.gr/",
  Origin: "https://en.stoiximan.gr",
  "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

async function get(url: string): Promise<any> {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    const text = await response.text();
    console.error(`[stoiximan] HTTP ${response.status} ${response.statusText} for ${url}: ${text.slice(0, 300)}`);
    return null;
  }
  return response.json();
}

function parseThreshold(name: string): number | null {
  const m = /^(\d+)\+$/.exec(name.trim());
  return m ? Number(m[1]) - 0.5 : null;
}

function pickBestThreshold(
  candidates: [number, number][]
): [number, number] | null {
  const inRange = candidates.filter(([, odds]) => odds >= ODDS_LO && odds <= ODDS_HI);
  if (inRange.length === 0) return null;
  return inRange.reduce((best, cur) =>
    Math.abs(cur[1] - ODDS_TARGET) < Math.abs(best[1] - ODDS_TARGET) ? cur : best
  );
}

async function fetchLeagueMarket(leaguePath: string, marketType: string): Promise<any> {
  const url = `${BASE}/${leaguePath}/${marketType}/?${REQ_PARAMS}`;
  return get(url);
}

function parseLeagueMarket(
  data: any,
  leagueLabel: string,
  marketName: string
): PropRecord[] {
  const records: PropRecord[] = [];
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  for (const block of data?.data?.blocks ?? []) {
    for (const event of block.events ?? []) {
      const rawName: string = event.name || "";
      const parts = rawName.split(/\s+-\s+/);
      const game = parts.length === 2 ? `${parts[1]} @ ${parts[0]}` : rawName;

      const startMs = event.startTime ?? 0;
      const kickoffTime = startMs
        ? new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z")
        : "";

      for (const market of event.markets ?? []) {
        const tl = market.tableLayout;
        if (!tl) continue;

        const groupMap: Record<string, string> = {};
        for (const g of tl.groups ?? []) {
          groupMap[g.id] = g.title;
        }

        for (const row of tl.rows ?? []) {
          const playerRaw: string = (row.title || row.name || "").trim();
          if (!playerRaw) continue;
          const player = toCanonicalName(playerRaw);
          const team = groupMap[row.groupId] ?? "";

          const candidates: [number, number][] = [];
          for (const gs of row.groupSelections ?? []) {
            for (const sel of gs.selections ?? []) {
              const line = parseThreshold(sel.name || "");
              const price = sel.price;
              if (line !== null && price !== undefined && price !== null) {
                candidates.push([line, Number(price)]);
              }
            }
          }

          const best = pickBestThreshold(candidates);
          if (best === null) continue;
          const [line, overOdds] = best;

          records.push({
            league: leagueLabel,
            game,
            team,
            player,
            market: marketName,
            line,
            over_odds_decimal: overOdds,
            under_odds_decimal: null,
            bookmaker: BOOKMAKER_NAME,
            kickoff_time: kickoffTime,
            updated_at: timestamp,
          });
        }
      }
    }
  }

  return records;
}

function parseMatchEventProps(data: any, leagueLabel: string): PropRecord[] {
  const records: PropRecord[] = [];
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const event = data?.data?.event;
  if (!event) return records;

  const rawName: string = event.name || "";
  const parts = rawName.split(/\s+-\s+/);
  const game = parts.length === 2 ? `${parts[1]} @ ${parts[0]}` : rawName;

  const startMs = event.startTime ?? 0;
  const kickoffTime = startMs
    ? new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z")
    : "";

  for (const market of event.markets ?? []) {
    const tl = market.tableLayout;
    if (!tl) continue;

    const mtype: string = market.type || "";
    const mname: string = market.name || "";
    let marketName = EVENT_MARKET_TYPES[mtype];
    if (!marketName) {
      if (mname.includes("Total Points") || mname.includes("Poeni")) {
        marketName = "points";
      } else if (mname.includes("Total Rebounds") || mname.includes("Skokovi")) {
        marketName = "rebounds";
      } else if (mname.includes("Total Assists") || mname.includes("Asistencije")) {
        marketName = "assists";
      } else if (mname.includes("Three-Pointers") || mname.includes("3-Point")) {
        marketName = "three_pointers";
      }
    }
    if (!marketName) continue;

    const groupMap: Record<string, string> = {};
    for (const g of tl.groups ?? []) {
      if (g.id && g.title) groupMap[g.id] = g.title;
    }

    for (const row of tl.rows ?? []) {
      const playerRaw: string = (row.title || row.name || "").trim();
      if (!playerRaw) continue;
      const player = toCanonicalName(playerRaw);
      const team = groupMap[row.groupId] ?? "";

      const candidates: [number, number][] = [];
      for (const gs of row.groupSelections ?? []) {
        for (const sel of gs.selections ?? []) {
          const line = parseThreshold(sel.name || "");
          const price = sel.price;
          if (line !== null && price !== undefined && price !== null) {
            candidates.push([line, Number(price)]);
          }
        }
      }

      const best = pickBestThreshold(candidates);
      if (best === null) continue;
      const [line, overOdds] = best;

      records.push({
        league: leagueLabel,
        game,
        team,
        player,
        market: marketName,
        line,
        over_odds_decimal: overOdds,
        under_odds_decimal: null,
        bookmaker: BOOKMAKER_NAME,
        kickoff_time: kickoffTime,
        updated_at: timestamp,
      });
    }
  }

  return records;
}

async function fetchLeagueEventProps(leaguePath: string, leagueLabel: string): Promise<PropRecord[]> {
  const records: PropRecord[] = [];
  const leagueUrl = `${BASE}/${leaguePath}/?${REQ_PARAMS}`;
  const data = await get(leagueUrl);
  const now = Date.now();

  const events: any[] = [];
  for (const block of data?.data?.blocks ?? []) {
    for (const event of block.events ?? []) {
      events.push(event);
    }
  }

  const upcomingEvents = events.filter(
    (e) => e.url && Math.abs((e.startTime ?? 0) - now) < 36 * 3600 * 1000
  );

  for (const event of upcomingEvents) {
    const matchApiUrl = `https://en.stoiximan.gr/api${event.url}?${REQ_PARAMS}`;
    try {
      const matchData = await get(matchApiUrl);
      const matchRecords = parseMatchEventProps(matchData, leagueLabel);
      records.push(...matchRecords);
    } catch (exc) {
      console.error(`[stoiximan] match fetch failed ${event.url}:`, exc);
    }
  }

  return records;
}

async function fetchAllStoiximanProps(): Promise<PropRecord[]> {
  const allRecords: PropRecord[] = [];
  for (const leagueInfo of SUPPORTED_LEAGUES) {
    const leagueRecords: PropRecord[] = [];

    // 1. Try league-level markets first
    for (const [marketType, marketName] of Object.entries(PROP_MARKET_TYPES)) {
      try {
        const data = await fetchLeagueMarket(leagueInfo.path, marketType);
        const recs = parseLeagueMarket(data, leagueInfo.league, marketName);
        leagueRecords.push(...recs);
      } catch {
        // ignore
      }
    }

    // 2. Fallback to match-level event scanning
    if (leagueRecords.length === 0) {
      try {
        const recs = await fetchLeagueEventProps(leagueInfo.path, leagueInfo.league);
        leagueRecords.push(...recs);
      } catch (exc) {
        console.error(`[stoiximan] failed league events ${leagueInfo.path}:`, exc);
      }
    }

    allRecords.push(...leagueRecords);
  }
  return allRecords;
}

export async function loadStoiximanProps(context: Context): Promise<PropRecord[]> {
  return loadWithCache(CACHE_STORE, CACHE_TTL_SECONDS, fetchAllStoiximanProps, context);
}
