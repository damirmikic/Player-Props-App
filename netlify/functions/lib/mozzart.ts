/**
 * Mozzart adapter — ported from mozzart_adapter.py.
 *
 * Mozzart does not expose player props as a subgame layer on regular
 * matches. Instead, each tournament that offers them gets its own
 * competition with competitionOfferType == "PLAYER". Each "match" inside
 * such a competition is actually a single player — no opponent/team data.
 *
 * Not cached — offer set changes rarely and volume is low, matching the
 * Python version.
 */
import { toCanonicalName, toCanonicalLeague } from "./name-utils.js";
import type { PropRecord } from "./types.js";

const BOOKMAKER_NAME = "Mozzart";

const BASE_URL = "https://www.mozzartbet.ng";
const REGULAR_GROUPS_URL = `${BASE_URL}/getRegularGroups`;
const BET_OFFER_URL = `${BASE_URL}/betOffer2`;
const BETTING_ODDS_URL = `${BASE_URL}/getBettingOdds`;

const HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

// gameId (from subGame) -> internal market name. All known ids so far are
// alternate lines of the same "points" prop.
const SUBGAME_MARKETS: Record<number, string> = {
  197: "points",
  722: "points",
  723: "points",
};

// getBettingOdds requires explicit subgame ids in the request body. These
// are the over/under subgame ids for every gameId in SUBGAME_MARKETS
// (basketball's "1002" + gameId + 001/002 pattern).
const REQUEST_SUBGAME_IDS: number[] = Object.keys(SUBGAME_MARKETS).flatMap((gameId) => [
  Number(`1002${gameId}001`),
  Number(`1002${gameId}002`),
]);

// Midpoint used to pick the "standard" line among a player's alternate lines.
const TARGET_OVER_ODDS = 1.95;

async function post(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  return response.json();
}

async function fetchRegularGroups(): Promise<any[]> {
  const body = {
    date: "all",
    sportIds: [],
    competitionIds: [],
    sort: "bycompetition",
    specials: null,
    subgames: [],
    size: 50,
    mostPlayed: false,
    type: "betting",
    numberOfGames: 0,
    activeCompleteOffer: false,
    lang: "en",
    offset: 0,
  };
  return post(REGULAR_GROUPS_URL, body);
}

interface PlayerPropCompetition {
  sport: string;
  id: number;
  name: string;
  shortName: string | null;
  count: number | null;
}

function findPlayerPropCompetitions(sports: any[]): PlayerPropCompetition[] {
  const found: PlayerPropCompetition[] = [];
  for (const sport of sports) {
    const sportName = sport.name || "";
    for (const compet of sport.compets ?? []) {
      const name: string = compet.name || "";
      if (name.toLowerCase().includes("player")) {
        found.push({
          sport: sportName,
          id: compet.id,
          name,
          shortName: compet.shortName ?? null,
          count: compet.count ?? null,
        });
      }
    }
  }
  return found;
}

export async function loadMozzartPlayerPropLeagues(): Promise<{
  fetched_at: string;
  competitions: PlayerPropCompetition[];
  error: string | null;
}> {
  try {
    const sports = await fetchRegularGroups();
    const competitions = findPlayerPropCompetitions(sports);
    return {
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      competitions,
      error: null,
    };
  } catch (exc) {
    return {
      fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      competitions: [],
      error: String(exc),
    };
  }
}

const PAGE_SIZE = 50;

async function fetchPlayerEntities(competitionId: number): Promise<any[]> {
  const allMatches: any[] = [];
  let offset = 0;
  while (true) {
    const body = {
      date: "all",
      sportIds: [],
      competitionIds: [competitionId],
      sort: "bycompetition",
      specials: null,
      subgames: [],
      size: PAGE_SIZE,
      mostPlayed: false,
      type: "betting",
      numberOfGames: 0,
      activeCompleteOffer: false,
      lang: "en",
      offset,
    };
    const data = await post(BET_OFFER_URL, body);
    const page: any[] = data.matches ?? [];
    allMatches.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return allMatches;
}

// getBettingOdds silently returns an empty list once a request carries too
// many matchIds (observed: 50 succeeds, 55+ returns nothing) — chunk at 50.
const ODDS_BATCH_SIZE = 50;

async function fetchOdds(matchIds: number[]): Promise<any[]> {
  const allOdds: any[] = [];
  for (let i = 0; i < matchIds.length; i += ODDS_BATCH_SIZE) {
    const batch = matchIds.slice(i, i + ODDS_BATCH_SIZE);
    const body = { matchIds: batch, subgames: REQUEST_SUBGAME_IDS };
    const result = await post(BETTING_ODDS_URL, body);
    allOdds.push(...(Array.isArray(result) ? result : []));
  }
  return allOdds;
}

function parsePlayerPropCompetition(
  entities: any[],
  oddsByMatch: any[],
  leagueLabel: string
): PropRecord[] {
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const playerByMatch = new Map<number, { player: string; kickoff_time: string }>();
  for (const entity of entities) {
    const participants = entity.participants ?? [];
    if (participants.length === 0) continue;
    const matchId = entity.id;
    const startMs = entity.startTime ?? 0;
    const kickoffTime = startMs
      ? new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z")
      : "";
    playerByMatch.set(matchId, {
      player: toCanonicalName(participants[0].name || ""),
      kickoff_time: kickoffTime,
    });
  }

  // Collect (line, over_odds, under_odds) per (matchId, market) across the
  // over/under subgame pair.
  const grouped = new Map<string, { matchId: number; market: string; line: number; over: number | null; under: number | null }>();
  for (const matchOdds of oddsByMatch) {
    const matchId = matchOdds.id;
    if (!playerByMatch.has(matchId)) continue;

    for (const kodd of Object.values(matchOdds.kodds ?? {}) as any[]) {
      if (!kodd) continue;
      const subGame = kodd.subGame ?? {};
      const market = SUBGAME_MARKETS[subGame.gameId];
      if (market === undefined) continue;

      const line = kodd.specialOddValue;
      const odds = kodd.value;
      const side = subGame.subGameName;
      if (line === undefined || line === null || odds === undefined || odds === null) continue;
      if (side !== "over" && side !== "under") continue;

      const key = `${matchId}|${market}|${line}`;
      const slot =
        grouped.get(key) ?? { matchId, market, line: Number(line), over: null, under: null };
      slot[side as "over" | "under"] = Number(odds);
      grouped.set(key, slot);
    }
  }

  // A player can have multiple alternate lines for the same market. Keep
  // only the one whose over odds sit closest to a standard price.
  const bestByPlayerMarket = new Map<
    string,
    { distance: number; matchId: number; market: string; line: number; over: number; under: number | null }
  >();
  for (const { matchId, market, line, over, under } of grouped.values()) {
    if (over === null) continue;
    const pmKey = `${matchId}|${market}`;
    const distance = Math.abs(over - TARGET_OVER_ODDS);
    const current = bestByPlayerMarket.get(pmKey);
    if (!current || distance < current.distance) {
      bestByPlayerMarket.set(pmKey, { distance, matchId, market, line, over, under });
    }
  }

  const records: PropRecord[] = [];
  for (const { matchId, market, line, over, under } of bestByPlayerMarket.values()) {
    const info = playerByMatch.get(matchId);
    if (!info) continue;
    records.push({
      league: leagueLabel,
      game: "",
      team: "",
      player: info.player,
      market,
      line,
      over_odds_decimal: over,
      under_odds_decimal: under,
      bookmaker: BOOKMAKER_NAME,
      kickoff_time: info.kickoff_time,
      updated_at: timestamp,
    });
  }
  return records;
}

export async function loadMozzartProps(): Promise<PropRecord[]> {
  const leaguesPayload = await loadMozzartPlayerPropLeagues();
  if (leaguesPayload.error) return [];

  const allRecords: PropRecord[] = [];
  for (const compet of leaguesPayload.competitions) {
    if (compet.sport !== "Basketball") continue;
    try {
      const entities = await fetchPlayerEntities(compet.id);
      const matchIds: number[] = entities
        .map((e) => e.id)
        .filter((id): id is number => id !== undefined && id !== null);
      const odds = await fetchOdds(matchIds);
      const leagueLabel = toCanonicalLeague(compet.name);
      allRecords.push(...parsePlayerPropCompetition(entities, odds, leagueLabel));
    } catch (exc) {
      console.error(`[mozzart] failed competition ${compet.id} (${compet.name}):`, exc);
    }
  }

  return allRecords;
}

export { BASE_URL as MOZZART_BASE_URL };
