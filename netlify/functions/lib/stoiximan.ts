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
  { path: "usa/wnba/440g", league: "WNBA" },
  { path: "israel/super-league/1042g", league: "Izrael" },
];

const PROP_MARKET_TYPES: Record<string, string> = {
  playerspoints: "points",
  playersrebounds: "rebounds",
  playersassists: "assists",
};

const CACHE_STORE = "stoiximan-cache";
const CACHE_TTL_SECONDS = 300;

const ODDS_TARGET = 1.95;
const ODDS_LO = 1.7;
const ODDS_HI = 2.2;

const HEADERS = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function get(url: string): Promise<any> {
  const response = await fetch(url, { headers: HEADERS });
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
          const playerRaw: string = (row.title || "").trim();
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

async function fetchAllStoiximanProps(): Promise<PropRecord[]> {
  const allRecords: PropRecord[] = [];
  for (const leagueInfo of SUPPORTED_LEAGUES) {
    for (const [marketType, marketName] of Object.entries(PROP_MARKET_TYPES)) {
      try {
        const data = await fetchLeagueMarket(leagueInfo.path, marketType);
        allRecords.push(...parseLeagueMarket(data, leagueInfo.league, marketName));
      } catch (exc) {
        console.error(`[stoiximan] failed ${leagueInfo.path}/${marketType}:`, exc);
      }
    }
  }
  return allRecords;
}

export async function loadStoiximanProps(context: Context): Promise<PropRecord[]> {
  return loadWithCache(CACHE_STORE, CACHE_TTL_SECONDS, fetchAllStoiximanProps, context);
}
