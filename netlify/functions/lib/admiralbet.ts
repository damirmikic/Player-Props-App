/**
 * AdmiralBet RS adapter — ported from admiralbet_adapter.py.
 *
 * Basketball player props live under sportId == 123 ("Košarka igrači").
 */
import type { Context } from "@netlify/functions";
import { loadWithCache } from "./cache.js";
import { toCanonicalName } from "./name-utils.js";
import type { PropRecord } from "./types.js";

export const ADMIRALBET_BASE_URL = "https://srboffer.admiralbet.rs";
const SPORT_ID_PROPS = 123;
const BOOKMAKER_NAME = "AdmiralBet";

const TREE_URL_TEMPLATE =
  "https://srboffer.admiralbet.rs/api/offer/webTree/null/true/true/true/" +
  "{date_from}/{date_to}/false" +
  "?eventMappingTypes=1&eventMappingTypes=2&eventMappingTypes=3" +
  "&eventMappingTypes=4&eventMappingTypes=5";

const EVENTS_URL_TEMPLATE =
  "https://srboffer.admiralbet.rs/api/offer/GetWebEvents" +
  "?dateFrom={date_from}&dateTo={date_to}&isLive=false";

const OUTCOMES_MAP: Record<number, [string, "over" | "under"]> = {
  5688: ["points", "over"],
  5689: ["points", "under"],
  5690: ["assists", "over"],
  5691: ["assists", "under"],
  5692: ["rebounds", "over"],
  5693: ["rebounds", "under"],
  1082: ["three_pointers", "over"],
  1083: ["three_pointers", "under"],
  5700: ["tpra", "over"],
  5701: ["tpra", "under"],
};

const TARGET_OVER_ODDS = 1.90;
const CACHE_STORE = "admiralbet-cache";
const CACHE_TTL_SECONDS = 300;

const HEADERS = {
  OfficeId: "138",
  Language: "sr-Latn",
  Origin: "https://admiralbet.rs",
  Referer: "https://admiralbet.rs/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
};

function buildDateRange(): [string, string] {
  const now = new Date();
  const dateFrom = now.toISOString().replace("Z", "");
  const farFuture = new Date(now.getTime() + 5 * 365 * 24 * 60 * 60 * 1000);
  const dateTo = farFuture.toISOString().replace("Z", "");
  return [dateFrom, dateTo];
}

async function fetchCompetitionsMap(): Promise<Map<number, string>> {
  const [dateFrom, dateTo] = buildDateRange();
  const url = TREE_URL_TEMPLATE.replace("{date_from}", dateFrom).replace(
    "{date_to}",
    dateTo
  );
  const map = new Map<number, string>();
  try {
    const res = await fetch(url, { headers: HEADERS });
    const sports = await res.json();
    if (Array.isArray(sports)) {
      for (const s of sports) {
        if (
          s.id === SPORT_ID_PROPS ||
          (s.name || "").toLowerCase().includes("košarka igra")
        ) {
          for (const reg of s.regions || []) {
            for (const comp of reg.competitions || []) {
              if (comp.competitionId != null) {
                map.set(comp.competitionId, (comp.competitionName || "").trim());
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[admiralbet] webTree fetch failed:", err);
  }
  return map;
}

function buildGameStrings(events: any[]): Map<string, string> {
  const teamsBySlot = new Map<string, Set<string>>();
  for (const e of events) {
    const slot = `${e.competitionId}|${e.dateTime}`;
    const rawName: string = e.name || "";
    if (rawName.includes(" - ")) {
      const [, team] = rawName.split(" - ");
      const t = (team || "").trim();
      if (t) {
        const set = teamsBySlot.get(slot) ?? new Set<string>();
        set.add(t);
        teamsBySlot.set(slot, set);
      }
    }
  }

  const gameStrings = new Map<string, string>();
  for (const [slot, teams] of teamsBySlot) {
    const sortedTeams = [...teams].sort();
    if (sortedTeams.length === 2) {
      gameStrings.set(slot, `${sortedTeams[0]} @ ${sortedTeams[1]}`);
    } else {
      gameStrings.set(slot, "");
    }
  }
  return gameStrings;
}

export async function fetchAdmiralbetProps(): Promise<PropRecord[]> {
  const competitions = await fetchCompetitionsMap();
  const [dateFrom, dateTo] = buildDateRange();
  const url = EVENTS_URL_TEMPLATE.replace("{date_from}", dateFrom).replace(
    "{date_to}",
    dateTo
  );

  const res = await fetch(url, { headers: HEADERS });
  const data = await res.json();
  const allEvents: any[] = Array.isArray(data?.events) ? data.events : [];
  const propEvents = allEvents.filter((e) => e.sportId === SPORT_ID_PROPS);

  const gameStrings = buildGameStrings(propEvents);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const records: PropRecord[] = [];

  for (const e of propEvents) {
    const cid = e.competitionId;
    const league = competitions.get(cid) || `League ${cid}`;
    const rawName: string = e.name || "";

    let playerRaw = "";
    let teamRaw = "";
    if (rawName.includes(" - ")) {
      const parts = rawName.split(" - ");
      playerRaw = parts[0].trim();
      teamRaw = (parts[1] || "").trim();
    } else {
      playerRaw = rawName.trim();
    }

    const player = toCanonicalName(playerRaw);
    const team = teamRaw;

    const dtStr: string = e.dateTime || "";
    const kickoffTime = dtStr && !dtStr.endsWith("Z") ? `${dtStr}Z` : dtStr;
    const slot = `${cid}|${dtStr}`;
    const game = gameStrings.get(slot) || "";

    // Group playable bets by market
    const marketLines = new Map<
      string,
      Array<{ line: number; over: number | null; under: number | null }>
    >();

    for (const b of e.bets || []) {
      if (b.isPlayable === false) continue;
      if (b.sbv === null || b.sbv === undefined) continue;
      const lineVal = Number(b.sbv);
      if (isNaN(lineVal)) continue;

      let overOdd: number | null = null;
      let underOdd: number | null = null;
      let marketName: string | null = null;

      for (const out of b.betOutcomes || []) {
        if (out.isPlayable === false) continue;
        const mapping = OUTCOMES_MAP[out.betTypeOutcomeId];
        if (mapping) {
          const [mName, side] = mapping;
          marketName = mName;
          const oddVal = out.odd != null ? Number(out.odd) : null;
          if (side === "over") overOdd = oddVal;
          else if (side === "under") underOdd = oddVal;
        }
      }

      if (marketName && (overOdd !== null || underOdd !== null)) {
        const list = marketLines.get(marketName) ?? [];
        list.push({ line: lineVal, over: overOdd, under: underOdd });
        marketLines.set(marketName, list);
      }
    }

    // Select standard line closest to target over odds
    for (const [mName, lines] of marketLines) {
      let bestLine: { line: number; over: number | null; under: number | null } | null =
        null;
      let bestDist = Infinity;

      for (const lInfo of lines) {
        const ov = lInfo.over;
        const dist = ov != null ? Math.abs(ov - TARGET_OVER_ODDS) : 999;
        if (dist < bestDist) {
          bestDist = dist;
          bestLine = lInfo;
        }
      }

      if (bestLine) {
        records.push({
          league,
          game,
          team,
          player,
          market: mName,
          line: bestLine.line,
          over_odds_decimal: bestLine.over,
          under_odds_decimal: bestLine.under,
          bookmaker: BOOKMAKER_NAME,
          kickoff_time: kickoffTime,
          updated_at: timestamp,
        });
      }
    }
  }

  return records;
}

export async function loadAdmiralbetProps(context: Context): Promise<PropRecord[]> {
  return loadWithCache(
    CACHE_STORE,
    CACHE_TTL_SECONDS,
    fetchAdmiralbetProps,
    context
  );
}
