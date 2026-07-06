"""
Mozzart adapter — player prop odds from Mozzart's "...Players" competitions,
plus a monitor of which such competitions currently exist.

Mozzart does not expose player props as a subgame layer on regular matches.
Instead, each tournament that offers them gets its own competition with
competitionOfferType == "PLAYER" (e.g. "Eurobasket (q) - Players"). Each
"match" inside such a competition is actually a single player, not a
fixture — there is no opponent/team data, only the player's name and a
kickoff time.

Endpoints:
  POST /getRegularGroups  -> sport/competition tree, used to discover
                              competitions whose name contains "Players".
  POST /betOffer2          -> per-competition list of player entities
                              ({id, participants[0].name, startTime, ...}).
  POST /getBettingOdds     -> per-matchId odds, keyed by subgame id
                              ({subGame: {gameName, subGameName: over/under},
                                specialOddValue: line, value: odds}).

Only "Number of Player Points" (subgame ids 197/722/723) has been observed
so far; extend _SUBGAME_MARKETS as new markets/leagues appear.
"""
from __future__ import annotations

import datetime
import json
import time
from urllib.request import Request, urlopen

from unabated_adapter import PropRecord
from name_utils import to_canonical_name, to_canonical_league

BOOKMAKER_NAME = "Mozzart"

_BASE_URL = "https://www.mozzartbet.ng"
_REGULAR_GROUPS_URL = f"{_BASE_URL}/getRegularGroups"
_BET_OFFER_URL = f"{_BASE_URL}/betOffer2"
_BETTING_ODDS_URL = f"{_BASE_URL}/getBettingOdds"
_FETCH_TIMEOUT = 20

_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
}

# gameId (from subGame) -> internal market name. All known ids so far are
# alternate lines of the same "points" prop.
_SUBGAME_MARKETS = {
    197: "points",
    722: "points",
    723: "points",
}

# getBettingOdds requires explicit subgame ids in the request body — an empty
# list returns no kodds at all. These are the over/under subgame ids for
# every gameId in _SUBGAME_MARKETS (basketball's "1002" + gameId + 001/002
# pattern, confirmed against a live capture). Extend alongside
# _SUBGAME_MARKETS when new markets are observed.
_REQUEST_SUBGAME_IDS = [
    int(f"1002{game_id}{suffix}")
    for game_id in _SUBGAME_MARKETS
    for suffix in ("001", "002")
]

# Midpoint used to pick the "standard" line among a player's alternate lines
# for the same market (mirrors stoiximan_adapter's threshold-selection logic).
_TARGET_OVER_ODDS = 1.95


def _post(url: str, body: dict) -> dict | list:
    req = Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=_HEADERS,
        method="POST",
    )
    with urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_regular_groups() -> list[dict]:
    body = {
        "date": "all", "sportIds": [], "competitionIds": [], "sort": "bycompetition",
        "specials": None, "subgames": [], "size": 50, "mostPlayed": False,
        "type": "betting", "numberOfGames": 0, "activeCompleteOffer": False,
        "lang": "en", "offset": 0,
    }
    return _post(_REGULAR_GROUPS_URL, body)


def find_player_prop_competitions(sports: list[dict]) -> list[dict]:
    """Return every competition whose name marks it as a player-props offer."""
    found = []
    for sport in sports:
        sport_name = sport.get("name", "")
        for compet in sport.get("compets", []):
            name = compet.get("name", "")
            if "player" in name.lower():
                found.append(
                    {
                        "sport": sport_name,
                        "id": compet.get("id"),
                        "name": name,
                        "shortName": compet.get("shortName"),
                        "count": compet.get("count"),
                    }
                )
    return found


def load_mozzart_player_prop_leagues() -> dict:
    """Return the current list of Mozzart "...Players" competitions (for monitoring)."""
    try:
        sports = fetch_regular_groups()
        competitions = find_player_prop_competitions(sports)
        return {
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "competitions": competitions,
            "error": None,
        }
    except Exception as exc:
        return {
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "competitions": [],
            "error": str(exc),
        }


_PAGE_SIZE = 50


def fetch_player_entities(competition_id: int) -> list[dict]:
    """Fetch all player entities in a competition, paging past betOffer2's page size."""
    all_matches: list[dict] = []
    offset = 0
    while True:
        body = {
            "date": "all", "sportIds": [], "competitionIds": [competition_id],
            "sort": "bycompetition", "specials": None, "subgames": [], "size": _PAGE_SIZE,
            "mostPlayed": False, "type": "betting", "numberOfGames": 0,
            "activeCompleteOffer": False, "lang": "en", "offset": offset,
        }
        data = _post(_BET_OFFER_URL, body)
        page = data.get("matches", [])
        all_matches.extend(page)
        if len(page) < _PAGE_SIZE:
            break
        offset += _PAGE_SIZE
    return all_matches


# getBettingOdds silently returns an empty list once a request carries too
# many matchIds (observed: 50 succeeds, 55+ returns nothing) — chunk requests
# to stay under that limit.
_ODDS_BATCH_SIZE = 50


def fetch_odds(match_ids: list[int]) -> list[dict]:
    all_odds: list[dict] = []
    for i in range(0, len(match_ids), _ODDS_BATCH_SIZE):
        batch = match_ids[i:i + _ODDS_BATCH_SIZE]
        body = {"matchIds": batch, "subgames": _REQUEST_SUBGAME_IDS}
        all_odds.extend(_post(_BETTING_ODDS_URL, body))
    return all_odds


def parse_player_prop_competition(
    entities: list[dict],
    odds_by_match: list[dict],
    league_label: str,
) -> list[PropRecord]:
    timestamp = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    player_by_match: dict[int, dict] = {}
    for entity in entities:
        participants = entity.get("participants") or []
        if not participants:
            continue
        match_id = entity.get("id")
        start_ms = entity.get("startTime") or 0
        kickoff_time = (
            datetime.datetime.utcfromtimestamp(start_ms / 1000).strftime("%Y-%m-%dT%H:%M:%SZ")
            if start_ms else ""
        )
        player_by_match[match_id] = {
            "player": to_canonical_name(participants[0].get("name", "")),
            "kickoff_time": kickoff_time,
        }

    # Collect (line, over_odds, under_odds) per (matchId, market) across the
    # over/under subgame pair.
    grouped: dict[tuple, dict] = {}
    for match_odds in odds_by_match:
        match_id = match_odds.get("id")
        if match_id not in player_by_match:
            continue
        for kodd in (match_odds.get("kodds") or {}).values():
            if not kodd:
                continue
            sub_game = kodd.get("subGame") or {}
            market = _SUBGAME_MARKETS.get(sub_game.get("gameId"))
            if market is None:
                continue

            line = kodd.get("specialOddValue")
            odds = kodd.get("value")
            side = sub_game.get("subGameName")
            if line is None or odds is None or side not in ("over", "under"):
                continue

            key = (match_id, market, str(line))
            slot = grouped.setdefault(key, {"line": float(line), "over": None, "under": None})
            slot[side] = float(odds)

    # A player can have multiple alternate lines for the same market (e.g.
    # 8.5/10.5/12.5 points). Keep only the one whose over odds sit closest to
    # a standard -110-ish price, so each player×market contributes one row
    # comparable to other bookmakers' single-line offers.
    best_by_player_market: dict[tuple, tuple] = {}
    for (match_id, market, _line_str), prices in grouped.items():
        if prices["over"] is None:
            continue
        pm_key = (match_id, market)
        candidate_distance = abs(prices["over"] - _TARGET_OVER_ODDS)
        current = best_by_player_market.get(pm_key)
        if current is None or candidate_distance < current[0]:
            best_by_player_market[pm_key] = (candidate_distance, prices)

    records = []
    for (match_id, market), (_dist, prices) in best_by_player_market.items():
        info = player_by_match[match_id]
        records.append(
            PropRecord(
                league=league_label,
                game="",
                team="",
                player=info["player"],
                market=market,
                line=prices["line"],
                over_odds_decimal=prices["over"],
                under_odds_decimal=prices["under"],
                bookmaker=BOOKMAKER_NAME,
                kickoff_time=info["kickoff_time"],
                updated_at=timestamp,
            )
        )
    return records


def fetch_all_mozzart_props() -> list[PropRecord]:
    """Fetch player props from every currently-live "...Players" competition."""
    leagues_payload = load_mozzart_player_prop_leagues()
    if leagues_payload["error"]:
        return []

    all_records: list[PropRecord] = []
    for compet in leagues_payload["competitions"]:
        if compet["sport"] != "Basketball":
            continue
        try:
            entities = fetch_player_entities(compet["id"])
            match_ids = [e["id"] for e in entities if e.get("id") is not None]
            odds = fetch_odds(match_ids)
            league_label = to_canonical_league(compet["name"])
            records = parse_player_prop_competition(entities, odds, league_label)
            all_records.extend(records)
        except Exception as exc:
            print(f"[mozzart] failed competition {compet.get('id')} ({compet.get('name')}): {exc}")

    return all_records


# ---------- Public API (mirrors other adapters; Mozzart is not cached — the
# offer set changes rarely and volume is low, so we fetch fresh each time) ----------

def load_mozzart_props() -> list[PropRecord]:
    return fetch_all_mozzart_props()
