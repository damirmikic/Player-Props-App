/**
 * Unabated adapter — ported from unabated_adapter.py.
 * WNBA only, multiple US sportsbooks. American odds -> decimal conversion.
 * Not cached — fetched fresh on every request (matches the Python version).
 */
import { toCanonicalName } from "./name-utils.js";
import type { PropRecord } from "./types.js";

export const UNABATED_NBA_PROPS_URL =
  "https://content.unabated.com/markets/v2/league/3/propodds.json";
export const UNABATED_WNBA_PROPS_URL =
  "https://content.unabated.com/markets/v2/league/7/propodds.json";

export const LEAGUE_MAP: Record<number, string> = {
  3: "NBA",
  7: "WNBA",
};

export const SUPPORTED_MARKETS = new Set(["points", "assists", "rebounds"]);

const EXCLUDED_BOOKMAKERS = new Set([
  "betrivers",
  "bookmaker",
  "bovada",
  "caesars",
  "draftkings pick6",
  "fanatics",
  "fanduel - delayed",
  "fliff",
  "hard rock",
  "hard rock (s)",
  "kalshi",
  "parx",
  "polymarket",
  "polymarket us",
  "prizepicks",
  "prophet exchange",
  "sleeper",
  "splash sports",
  "sportsbetting",
  "sugarhouse",
  "the score us",
  "thescore us",
  "underdog fantasy",
  "underdog prediction market",
]);

const BET_TYPE_MARKETS: Record<number, string> = {
  73: "points",
  70: "assists",
  77: "rebounds",
};

const SIDE_OVER = "si0";
const SIDE_UNDER = "si1";

function americanToDecimal(odds: number | null | undefined): number | null {
  if (odds === null || odds === undefined) return null;
  const decimal = odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds);
  return Math.round(decimal * 100) / 100;
}

interface BookPrice {
  line: number | null;
  over: number | null;
  under: number | null;
  updated_at: string;
}

function sideFromKey(sideKey: string): "over" | "under" | null {
  if (sideKey.startsWith(`${SIDE_OVER}:`)) return "over";
  if (sideKey.startsWith(`${SIDE_UNDER}:`)) return "under";
  return null;
}

function isVisibleLine(line: any): boolean {
  if (line.isBlurred) return false;
  if (line.statusId !== 1) return false;
  const price = line.americanPrice;
  if (price === null || price === undefined || price === -100000 || price === -10000) {
    return false;
  }
  return true;
}

function firstNumber(current: number | null, candidate: any): number | null {
  if (current !== null) return current;
  if (candidate === null || candidate === undefined) return null;
  return Number(candidate);
}

function collectBookPrices(
  sides: Record<string, any>,
  sources: Record<string, any>
): Record<string, BookPrice> {
  const bookPrices: Record<string, BookPrice> = {};

  for (const [sideKey, books] of Object.entries(sides ?? {})) {
    const side = sideFromKey(sideKey);
    if (!side) continue;

    for (const [sourceKey, line] of Object.entries(books as Record<string, any>)) {
      if (!isVisibleLine(line)) continue;

      const bookId = sourceKey.startsWith("ms")
        ? sourceKey.slice(2)
        : String(line.marketSourceId);
      const source = sources[bookId] ?? {};
      const bookmaker: string = source.name || `Book ${bookId}`;
      if (EXCLUDED_BOOKMAKERS.has(bookmaker.toLowerCase())) continue;
      if (source.isEnabledForProps === false) continue;

      const current =
        bookPrices[bookId] ??
        (bookPrices[bookId] = { line: null, over: null, under: null, updated_at: "" });
      current.line = firstNumber(current.line, line.points);
      current[side] = line.americanPrice ?? null;
      current.updated_at =
        (current.updated_at > (line.modifiedOn ?? "") ? current.updated_at : line.modifiedOn) ?? "";
    }
  }

  return bookPrices;
}

function playerName(person: any): string {
  const preferred = person?.preferredName;
  const first = preferred || person?.firstName || "";
  const last = person?.lastName || "";
  const full = `${first} ${last}`.trim();
  if (!full) return "Unknown Player";
  return toCanonicalName(full);
}

/**
 * Build "Away @ Home" from the teams table (sideId 0 = away, 1 = home).
 * Unabated's eventName uses a "Nickname City ABBR" form (e.g. "Cavaliers
 * Cleveland CLE") that no other source matches; the team `name` field is the
 * plain "Cleveland Cavaliers" form the other books use.
 */
function buildEventGames(teams: Record<string, any>): Map<any, string> {
  const sides = new Map<any, Record<number, string>>();
  for (const team of Object.values(teams)) {
    const { eventId, sideId, name } = team ?? {};
    if (eventId == null || (sideId !== 0 && sideId !== 1) || !name) continue;
    if (!sides.has(eventId)) sides.set(eventId, {});
    sides.get(eventId)![sideId] = String(name).trim();
  }
  const games = new Map<any, string>();
  for (const [eventId, s] of sides) {
    if (s[0] && s[1]) games.set(eventId, `${s[0]} @ ${s[1]}`);
  }
  return games;
}

function cleanEventName(eventName: string | undefined, eventId: any): string {
  if (!eventName) return `Event ${eventId}`;
  return eventName.replace(" - @ ", " @ ").replace(/^-+|-+$/g, "").trim();
}

export async function fetchUnabatedPropsForLeague(leagueId: number): Promise<any> {
  const url = `https://content.unabated.com/markets/v2/league/${leagueId}/propodds.json`;
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "PlayerPropsApp/0.1",
    },
  });
  return response.json();
}

export async function fetchUnabatedProps(): Promise<any> {
  const leagueIds = Object.keys(LEAGUE_MAP).map(Number);
  const results = await Promise.all(
    leagueIds.map((id) =>
      fetchUnabatedPropsForLeague(id).catch((err) => {
        console.error(`[unabated] Failed to fetch league ${id}:`, err);
        return null;
      })
    )
  );

  const combined: any = { odds: {}, people: {}, teams: {}, marketSources: [] };
  const sourceIds = new Set<any>();

  for (const r of results) {
    if (!r) continue;
    Object.assign(combined.odds, r.odds ?? {});
    Object.assign(combined.people, r.people ?? {});
    Object.assign(combined.teams, r.teams ?? {});
    for (const source of r.marketSources ?? []) {
      if (!sourceIds.has(source.id)) {
        sourceIds.add(source.id);
        combined.marketSources.push(source);
      }
    }
  }

  return combined;
}

export function parseUnabatedProps(raw: any): PropRecord[] {
  const people = raw.people ?? {};
  const teams = raw.teams ?? {};
  const sources: Record<string, any> = {};
  for (const source of raw.marketSources ?? []) {
    sources[String(source.id)] = source;
  }

  const eventGames = buildEventGames(teams);
  const records: PropRecord[] = [];

  for (const [oddsKey, rows] of Object.entries(raw.odds ?? {})) {
    let league: string | undefined;
    if (oddsKey.startsWith("lg")) {
      const prefix = oddsKey.split(":")[0]?.slice(2);
      if (prefix && !isNaN(Number(prefix))) {
        league = LEAGUE_MAP[Number(prefix)];
      }
    }
    if (!league) continue;

    for (const row of rows as any[]) {
      const market = BET_TYPE_MARKETS[row.betTypeId];
      if (!market || row.periodTypeId !== 1 || row.betSubType != null) continue;
      // statusId 1 = scheduled/upcoming; anything else means the event has
      // already started, so drop it here as a fast pre-filter.
      if (row.statusId !== 1) continue;

      const player = playerName(people[String(row.personId)] ?? {});
      const team = teams[String(row.teamId)] ?? {};
      const game = eventGames.get(row.eventId) ?? cleanEventName(row.eventName, row.eventId);
      const bookPrices = collectBookPrices(row.sides ?? {}, sources);

      for (const [bookId, price] of Object.entries(bookPrices)) {
        if (price.line === null) continue;

        const source = sources[bookId] ?? {};
        const bookmaker: string = source.name || `Book ${bookId}`;
        records.push({
          league,
          game,
          team: team.abbreviation || "",
          player,
          market,
          line: price.line,
          over_odds_decimal: americanToDecimal(price.over),
          under_odds_decimal: americanToDecimal(price.under),
          bookmaker,
          kickoff_time: row.eventStart || "",
          updated_at: price.updated_at || "",
        });
      }
    }
  }

  return records;
}

export function buildHighlights(records: PropRecord[]): Record<string, { best_over: string | null; best_under: string | null }> {
  const grouped = new Map<string, PropRecord[]>();
  for (const record of records) {
    const key = `${record.player}|${record.market}`;
    const list = grouped.get(key) ?? [];
    list.push(record);
    grouped.set(key, list);
  }

  const highlights: Record<string, { best_over: string | null; best_under: string | null }> = {};
  for (const [key, group] of grouped) {
    const overGroup = group.filter((r) => r.over_odds_decimal !== null);
    const underGroup = group.filter((r) => r.under_odds_decimal !== null);

    const bestOver =
      overGroup.length > 0
        ? overGroup.reduce((a, b) => (a.over_odds_decimal! > b.over_odds_decimal! ? a : b))
        : null;
    const bestUnder =
      underGroup.length > 0
        ? underGroup.reduce((a, b) => (a.under_odds_decimal! > b.under_odds_decimal! ? a : b))
        : null;

    highlights[key] = {
      best_over: bestOver ? highlightId(bestOver) : null,
      best_under: bestUnder ? highlightId(bestUnder) : null,
    };
  }

  return highlights;
}

function highlightId(record: PropRecord): string {
  return `${record.player}|${record.market}|${record.bookmaker}|${record.line}`;
}
