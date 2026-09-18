/**
 * Superbet RS adapter — ported from superbet_adapter.py.
 *
 * Two-step fetch per run:
 *   1. GET /events/by-date  -> list today's basketball event IDs
 *   2. GET /events/{id}     -> per-event full odds (flat array of all markets)
 *
 * Over/under determined from the odds `name` field ("Više od" / "Manje od").
 * Prices are already decimal — no conversion needed.
 */
import type { Context } from "@netlify/functions";
import { loadWithCache } from "./cache.js";
import { toCanonicalName } from "./name-utils.js";
import type { PropRecord } from "./types.js";

const BASE = "https://production-superbet-offer-rs.freetls.fastly.net/sb-rs/api/v2/sr-Latn-RS";
export const EVENTS_BY_DATE_URL = `${BASE}/events/by-date`;
const EVENT_DETAIL_URL = `${BASE}/events/{event_id}`;

const BOOKMAKER_NAME = "Superbet";
const SPORT_ID_BASKETBALL = 4;

const CATEGORY_NAMES: Record<number, string> = {
  61: "WNBA",
  108: "ACB",
  56: "Lega A",
  185: "Izrael",
  36: "FIBA Qualifiers",
};

// categoryId 36 is a shared "international/other" bucket that Superbet
// reuses across unrelated competitions (FIBA Qualifiers, World Cup Women,
// Euroleague, various domestic leagues) — categoryName is never populated
// by this API, so a single categoryId → label mapping isn't enough to
// disambiguate. tournamentId is the only field that varies per competition
// within that bucket, so give it its own override table, checked first.
const TOURNAMENT_NAMES: Record<number, string> = {
  2401: "Club Friendly",
  6361: "World Cup Women",
  6362: "World Cup Women",
  6363: "World Cup Women",
  6364: "World Cup Women",
  6751: "World Cup Women",
  101815: "Euroleague Supercup",
  19114: "Euroleague",
};

const PLAYER_PROP_MARKETS: Record<number, string> = {
  // ACB / Lega A / Izrael
  239934: "points",
  239935: "assists",
  239936: "rebounds",
  // WNBA (different feed IDs, same semantic markets)
  233565: "points",
  233566: "assists",
  233567: "rebounds",
  // Friendlies / Internationals
  231182: "points",
};

const CACHE_STORE = "superbet-cache";
const CACHE_TTL_SECONDS = 300;

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

function todayStart(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}+00:00:00`;
}

async function fetchSuperbetEvents(): Promise<any[]> {
  const url = `${EVENTS_BY_DATE_URL}?currentStatus=active&offerState=prematch&startDate=${todayStart()}`;
  const data = await get(url);
  return (data.data ?? []).filter((e: any) => e.sportId === SPORT_ID_BASKETBALL);
}

async function fetchEventOdds(eventId: number): Promise<any[]> {
  const url = EVENT_DETAIL_URL.replace("{event_id}", String(eventId));
  const data = await get(url);
  const events = data.data ?? [];
  return events.length > 0 ? events[0].odds ?? [] : [];
}

function normalizePlayerName(raw: string): string {
  let name = raw.trim();
  if (name.includes(",")) {
    // "Boston, Aliyah" -> "Aliyah Boston"
    const [last, first] = name.split(",", 2);
    name = `${first.trim()} ${last.trim()}`;
  }
  return toCanonicalName(name);
}

async function parseSuperbetProps(events: any[]): Promise<PropRecord[]> {
  const records: PropRecord[] = [];
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  for (const event of events) {
    let league = TOURNAMENT_NAMES[event.tournamentId ?? -1] ?? CATEGORY_NAMES[event.categoryId ?? -1];
    if (!league) {
      const cid = event.categoryId ?? "?";
      league = (event.categoryName || `Cat ${cid}`).trim();
    }

    let game: string = event.matchName || "";
    game = game.replace(/\s*\([ŽWw]\)/g, "");

    // Superbet (European) lists Home vs Away. Unabated (US) lists Away @ Home.
    const parts = game.split(/\s+(?:vs|-|·)\s+/);
    if (parts.length === 2) {
      game = `${parts[1]} @ ${parts[0]}`;
    } else {
      game = game.replace(/·/g, " @ ").replace(/ vs /g, " @ ").replace(/ - /g, " @ ");
    }

    const eventId = event.eventId;
    const kickoffTime = (event.matchDate || "").replace(" ", "T") + "Z";

    let oddsList: any[];
    try {
      oddsList = await fetchEventOdds(eventId);
    } catch (exc) {
      console.error(`[superbet] failed to fetch event ${eventId}:`, exc);
      continue;
    }

    // Group by (player, market, line) to pair over + under
    const groups = new Map<string, { over: number | null; under: number | null }>();
    for (const odd of oddsList) {
      const market = PLAYER_PROP_MARKETS[odd.marketId];
      if (!market) continue;
      if (odd.status !== "active") continue;

      const spec = odd.specifiers ?? {};
      const player: string = (spec.player || "").trim();
      const total = spec.total ?? "";
      if (!player || !total) continue;

      const line = Number(total);
      if (Number.isNaN(line)) continue;

      const key = `${player}|${market}|${line}`;
      const name: string = odd.name || "";
      const price = odd.price;
      if (price === undefined || price === null) continue;

      const entry = groups.get(key) ?? { over: null, under: null };
      if (name.includes("Više od") || name.toLowerCase().includes("vise od")) {
        entry.over = Number(price);
      } else if (name.includes("Manje od") || name.toLowerCase().includes("manje od")) {
        entry.under = Number(price);
      }
      groups.set(key, entry);
    }

    for (const [key, sides] of groups) {
      if (sides.over === null && sides.under === null) continue;
      const [rawPlayer, market, lineStr] = key.split("|");
      records.push({
        league,
        game,
        team: "",
        player: normalizePlayerName(rawPlayer),
        market,
        line: Number(lineStr),
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

export async function loadSuperbetProps(context: Context): Promise<PropRecord[]> {
  return loadWithCache(
    CACHE_STORE,
    CACHE_TTL_SECONDS,
    async () => parseSuperbetProps(await fetchSuperbetEvents()),
    context
  );
}
