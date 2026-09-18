/**
 * BalkanBet RS adapter — ported from balkanbet_adapter.py.
 *
 * Basketball player props live under sportId == 273 via NSoft distribution API.
 */
import type { Context } from "@netlify/functions";
import { loadWithCache } from "./cache.js";
import { toCanonicalName, toCanonicalLeague } from "./name-utils.js";
import type { PropRecord } from "./types.js";

export const BALKANBET_BASE_URL =
  "https://sports-sm-distribution-api.de-2.nsoftcdn.com/api/v1";

const SPORT_ID_PROPS = 273;
const BOOKMAKER_NAME = "BalkanBet";
const COMPANY_UUID = "4f54c6aa-82a9-475d-bf0e-dc02ded89225";
const DELIVERY_PLATFORM_ID = 3;

const MARKET_MAP: Record<number, string> = {
  2402: "points",
  2403: "rebounds",
  2406: "assists",
};

const CACHE_STORE = "balkanbet-cache";
const CACHE_TTL_SECONDS = 300;

const HEADERS = {
  Accept: "application/json",
  Origin: "https://balkanbet.rs",
  Referer: "https://balkanbet.rs/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function fetchTournamentMap(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  try {
    const langJson = encodeURIComponent(JSON.stringify({ default: "sr-Latn" }));
    const url =
      `${BALKANBET_BASE_URL}/tournaments?` +
      `companyUuid=${COMPANY_UUID}&deliveryPlatformId=${DELIVERY_PLATFORM_ID}` +
      `&timezone=Europe%2FBelgrade&language=${langJson}` +
      `&filter[sportId]=${SPORT_ID_PROPS}`;

    const res = await fetch(url, { headers: HEADERS });
    const data = await res.json();
    const tourns = data?.data?.tournaments;
    if (Array.isArray(tourns)) {
      for (const t of tourns) {
        if (t.id != null) {
          map.set(Number(t.id), (t.name || t.shortName || "").trim());
        }
      }
    }
  } catch (exc) {
    console.error("[balkanbet] failed to fetch tournament map:", exc);
  }
  return map;
}

const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV"]);

function parseBalkanbetPlayer(raw: string): string {
  const trimmed = raw.trim();
  // Handle double initials with dots like E.J.Liddell -> Liddell E.
  const mDbl = trimmed.match(/^([A-Za-z])\.[A-Za-z]\.([A-Za-z\-']+)$/);
  if (mDbl) {
    const [, initial, surname] = mDbl;
    return `${surname} ${initial.toUpperCase()}.`;
  }

  // Handle Abbr.Surname [Suffix] (e.g. W.Baldwin IV, T.Horton Tucker, S.Vezenkov)
  const mInit = trimmed.match(/^([A-Za-z]+)\.(.+)$/);
  if (mInit) {
    const [, abbr, rest] = mInit;
    const initial = abbr[0].toUpperCase();
    const tokens = rest.trim().split(/\s+/).filter(Boolean);

    // Strip Roman numerals or generational suffixes
    if (tokens.length > 0 && SUFFIXES.has(tokens[tokens.length - 1].replace(/\.+$/, "").toUpperCase())) {
      tokens.pop();
    }

    let surname = rest.trim();
    if (tokens.length >= 2) {
      // Compound surnames (Horton Tucker -> Horton-Tucker, Luwawu Cabarrot -> Luwawu-Cabarrot)
      surname = tokens.join("-");
    } else if (tokens.length === 1) {
      surname = tokens[0];
    }

    return `${surname} ${initial}.`;
  }

  return trimmed;
}

export async function fetchBalkanbetProps(): Promise<PropRecord[]> {
  const tournamentMap = await fetchTournamentMap();

  const nowUtc = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const nowIso = nowUtc.toISOString().split(".")[0];

  const dataFormat = encodeURIComponent(
    JSON.stringify({ default: "object", events: "array", outcomes: "array" })
  );
  const langJson = encodeURIComponent(JSON.stringify({ default: "sr-Latn" }));

  const eventsUrl =
    `${BALKANBET_BASE_URL}/events?` +
    `deliveryPlatformId=${DELIVERY_PLATFORM_ID}` +
    `&dataFormat=${dataFormat}` +
    `&language=${langJson}` +
    `&timezone=Europe%2FBelgrade` +
    `&companyUuid=${COMPANY_UUID}` +
    `&filter[sportId]=${SPORT_ID_PROPS}` +
    `&filter[from]=${nowIso}` +
    `&sort=categoryPosition,categoryName,tournamentPosition,tournamentName,startsAt`;

  const res = await fetch(eventsUrl, { headers: HEADERS });
  const data = await res.json();
  const rawEvents = data?.data?.events;

  if (!Array.isArray(rawEvents)) {
    return [];
  }

  const records: PropRecord[] = [];
  const updatedAt = new Date().toISOString();

  for (const ev of rawEvents) {
    const eventName = (ev.name || ev.j || "").trim();
    if (!eventName) continue;

    // Clean trailing dashes e.g. "J.Motley (Crvena zvezda) - "
    const cleanEvent = eventName.replace(/[\s\-–—]+$/, "").trim();

    // "Player Name (Team Name)"
    const m = cleanEvent.match(/^(.*?)\s*\((.*?)\)$/);
    const rawPlayer = m ? m[1].trim() : cleanEvent;
    const team = m ? m[2].trim() : "";

    const parsedPlayer = parseBalkanbetPlayer(rawPlayer);
    const player = toCanonicalName(parsedPlayer);
    const tournamentId = ev.tournamentId || ev.f;
    const rawLeague = tournamentMap.get(Number(tournamentId)) || "";
    const cleanedLeague = rawLeague
      .replace(/^[Ii]gra[čc\ufffd]i\s+/, "")
      .trim();
    const league = toCanonicalLeague(cleanedLeague || rawLeague);

    const startsAt = ev.startsAt || ev.n || "";
    const game = team ? `vs ${team}` : "";

    const marketsRaw = ev.markets || ev.o || {};
    const marketsList: any[] = Array.isArray(marketsRaw)
      ? marketsRaw
      : typeof marketsRaw === "object"
      ? Object.values(marketsRaw)
      : [];

    const marketsByType = new Map<number, any[]>();
    for (const mkt of marketsList) {
      const mId = Number(mkt.marketId || mkt.b);
      if (MARKET_MAP[mId]) {
        if (!marketsByType.has(mId)) {
          marketsByType.set(mId, []);
        }
        marketsByType.get(mId)!.push(mkt);
      }
    }

    for (const [mId, instances] of marketsByType.entries()) {
      const marketName = MARKET_MAP[mId];
      let chosen = instances.find((inst) => inst.favourite === true || inst.e === true);
      if (!chosen && instances.length > 0) {
        chosen = instances[0];
      }
      if (!chosen) continue;

      const specials = chosen.specialValues || chosen.g || [];
      if (!specials || specials.length === 0) continue;

      const line = parseFloat(specials[0]);
      if (isNaN(line)) continue;

      const outcomes = chosen.outcomes || chosen.h || [];
      let overOdds: number | null = null;
      let underOdds: number | null = null;

      for (const oc of outcomes) {
        const ocName = (oc.name || oc.e || "").toLowerCase();
        const oddVal = parseFloat(oc.odd || oc.g);
        if (isNaN(oddVal)) continue;

        if (ocName.includes("manje") || ocName.includes("under")) {
          underOdds = oddVal;
        } else if (ocName.includes("vi") || ocName.includes("over")) {
          overOdds = oddVal;
        }
      }

      if (overOdds !== null || underOdds !== null) {
        records.push({
          player,
          team,
          league,
          market: marketName,
          line,
          over_odds_decimal: overOdds,
          under_odds_decimal: underOdds,
          bookmaker: BOOKMAKER_NAME,
          game,
          kickoff_time: startsAt,
          updated_at: updatedAt,
        });
      }
    }
  }

  return records;
}

export async function loadBalkanbetProps(context: Context): Promise<PropRecord[]> {
  return loadWithCache<PropRecord[]>(
    CACHE_STORE,
    CACHE_TTL_SECONDS,
    fetchBalkanbetProps,
    context
  );
}
