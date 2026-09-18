/**
 * Unabated adapter — ported from unabated_adapter.py.
 * WNBA only, multiple US sportsbooks. American odds -> decimal conversion.
 * Not cached — fetched fresh on every request (matches the Python version).
 */
import { toCanonicalName } from "./name-utils.js";
import type { PropRecord } from "./types.js";

export const UNABATED_WNBA_PROPS_URL =
  "https://content.unabated.com/markets/v2/league/7/propodds.json";

export const SUPPORTED_MARKETS = new Set(["points", "assists", "rebounds"]);

const EXCLUDED_BOOKMAKERS = new Set([
  "betrivers",
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
const LEAGUE = "WNBA";

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

function cleanEventName(eventName: string | undefined, eventId: any): string {
  if (!eventName) return `Event ${eventId}`;
  return eventName.replace(" - @ ", " @ ").replace(/^-+|-+$/g, "").trim();
}

export async function fetchUnabatedProps(): Promise<any> {
  const response = await fetch(UNABATED_WNBA_PROPS_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": "PlayerPropsApp/0.1",
    },
  });
  return response.json();
}

export function parseUnabatedProps(raw: any): PropRecord[] {
  const people = raw.people ?? {};
  const teams = raw.teams ?? {};
  const sources: Record<string, any> = {};
  for (const source of raw.marketSources ?? []) {
    sources[String(source.id)] = source;
  }

  const records: PropRecord[] = [];

  for (const [oddsKey, rows] of Object.entries(raw.odds ?? {})) {
    if (!oddsKey.startsWith("lg7:")) continue;

    for (const row of rows as any[]) {
      const market = BET_TYPE_MARKETS[row.betTypeId];
      if (!market || row.periodTypeId !== 1 || row.betSubType != null) continue;
      // statusId 1 = scheduled/upcoming; anything else means the event has
      // already started, so drop it here as a fast pre-filter.
      if (row.statusId !== 1) continue;

      const player = playerName(people[String(row.personId)] ?? {});
      const team = teams[String(row.teamId)] ?? {};
      const game = cleanEventName(row.eventName, row.eventId);
      const bookPrices = collectBookPrices(row.sides ?? {}, sources);

      for (const [bookId, price] of Object.entries(bookPrices)) {
        if (price.line === null) continue;

        const source = sources[bookId] ?? {};
        const bookmaker: string = source.name || `Book ${bookId}`;
        records.push({
          league: LEAGUE,
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
