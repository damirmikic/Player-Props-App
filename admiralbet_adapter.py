"""
AdmiralBet RS adapter — pulls basketball player prop odds from the AdmiralBet REST API.

Endpoints:
  GET https://srboffer.admiralbet.rs/api/offer/webTree/null/true/true/true/{dateFrom}/{dateTo}/false
      ?eventMappingTypes=1&eventMappingTypes=2&eventMappingTypes=3&eventMappingTypes=4&eventMappingTypes=5
      -> Discovers competition names and regions under sportId == 123 ("Košarka igrači").

  GET https://srboffer.admiralbet.rs/api/offer/GetWebEvents?dateFrom={dateFrom}&dateTo={dateTo}&isLive=false
      -> Returns events, bets, and betOutcomes for all sports. Filter sportId == 123.

Structure:
  Each event in sportId == 123 represents a player and their team:
    name: "Player Name - Team Name"  (e.g. "Paige Bueckers - Dallas Wings W")
    dateTime: "2026-08-21T00:00:00"
    competitionId: mapped to competitionName via webTree

Odds & Markets:
  betTypeId:
    1598: "Ukupno poena"                    -> "points"
    1599: "Ukupno asistencija"              -> "assists"
    1600: "Ukupno skokova"                  -> "rebounds"
    300:  "Ukupno pogodjenih trojki"        -> "three_pointers"
    1604: "Ukupno poena+asistencija+skokova" -> "tpra"

  betTypeOutcomeId:
    5688 / 5689 -> points over / under
    5690 / 5691 -> assists over / under
    5692 / 5693 -> rebounds over / under
    1082 / 1083 -> three_pointers over / under
    5700 / 5701 -> tpra over / under

Alternate line selection:
  When a player has multiple lines for a market (e.g. 18.5, 20.5, 22.5),
  the standard line closest to target over odds (1.90) is selected.
"""
from __future__ import annotations

import datetime
from collections import defaultdict
import json
from pathlib import Path
import threading
import time
from urllib.request import Request, urlopen

from unabated_adapter import PropRecord
from name_utils import to_canonical_name

BOOKMAKER_NAME = "AdmiralBet"
SPORT_ID_PROPS = 123

_TREE_URL_TEMPLATE = (
    "https://srboffer.admiralbet.rs/api/offer/webTree/null/true/true/true/"
    "{date_from}/{date_to}/false"
    "?eventMappingTypes=1&eventMappingTypes=2&eventMappingTypes=3"
    "&eventMappingTypes=4&eventMappingTypes=5"
)
_EVENTS_URL_TEMPLATE = (
    "https://srboffer.admiralbet.rs/api/offer/GetWebEvents"
    "?dateFrom={date_from}&dateTo={date_to}&isLive=false"
)

# Outcome ID -> (market_name, side)
_OUTCOMES_MAP: dict[int, tuple[str, str]] = {
    5688: ("points", "over"),
    5689: ("points", "under"),
    5690: ("assists", "over"),
    5691: ("assists", "under"),
    5692: ("rebounds", "over"),
    5693: ("rebounds", "under"),
    1082: ("three_pointers", "over"),
    1083: ("three_pointers", "under"),
    5700: ("tpra", "over"),
    5701: ("tpra", "under"),
}

_TARGET_OVER_ODDS = 1.90

_CACHE_FILE = Path(__file__).resolve().parent / "admiralbet_cache.json"
_CACHE_TTL_SECONDS = 300
_FETCH_TIMEOUT = 20

_memory_cache: list[PropRecord] | None = None
_memory_cache_time: float = 0.0
_cache_lock = threading.Lock()

_HEADERS = {
    "OfficeId": "138",
    "Language": "sr-Latn",
    "Origin": "https://admiralbet.rs",
    "Referer": "https://admiralbet.rs/",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}


def _get_json(url: str) -> dict | list:
    req = Request(url, headers=_HEADERS)
    with urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _build_date_range() -> tuple[str, str]:
    now = datetime.datetime.now(datetime.timezone.utc)
    date_from = now.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
    date_to = (now + datetime.timedelta(days=365 * 5)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]
    return date_from, date_to


def fetch_competitions_map() -> dict[int, str]:
    """Discover competitionId -> competitionName under sportId 123."""
    date_from, date_to = _build_date_range()
    url = _TREE_URL_TEMPLATE.format(date_from=date_from, date_to=date_to)
    competitions: dict[int, str] = {}
    try:
        sports = _get_json(url)
        if isinstance(sports, list):
            for s in sports:
                if s.get("id") == SPORT_ID_PROPS or "košarka igra" in (s.get("name") or "").lower():
                    for reg in s.get("regions", []):
                        for comp in reg.get("competitions", []):
                            cid = comp.get("competitionId")
                            cname = comp.get("competitionName", "").strip()
                            if cid is not None:
                                competitions[cid] = cname
    except Exception as exc:
        print(f"[admiralbet] failed to fetch webTree: {exc}")
    return competitions


def _build_game_strings(events: list[dict]) -> dict[tuple[int, str], str]:
    """
    For each (competitionId, dateTime) slot, collect participating teams and build
    "TeamA @ TeamB" game string if exactly two teams are found.
    """
    teams_by_slot: dict[tuple[int, str], set[str]] = defaultdict(set)
    for e in events:
        slot = (e.get("competitionId"), e.get("dateTime"))
        name = e.get("name", "")
        if " - " in name:
            _, team = name.split(" - ", 1)
            team = team.strip()
            if team:
                teams_by_slot[slot].add(team)

    game_strings: dict[tuple[int, str], str] = {}
    for slot, teams in teams_by_slot.items():
        sorted_teams = sorted(teams)
        if len(sorted_teams) == 2:
            game_strings[slot] = f"{sorted_teams[0]} @ {sorted_teams[1]}"
        else:
            game_strings[slot] = ""
    return game_strings


def fetch_admiralbet_props() -> list[PropRecord]:
    competitions = fetch_competitions_map()
    date_from, date_to = _build_date_range()
    events_url = _EVENTS_URL_TEMPLATE.format(date_from=date_from, date_to=date_to)
    
    data = _get_json(events_url)
    all_events = data.get("events", []) if isinstance(data, dict) else []
    prop_events = [e for e in all_events if e.get("sportId") == SPORT_ID_PROPS]

    game_strings = _build_game_strings(prop_events)
    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    records: list[PropRecord] = []

    for e in prop_events:
        cid = e.get("competitionId")
        league = competitions.get(cid, f"League {cid}")
        raw_name = e.get("name", "")
        
        if " - " in raw_name:
            player_raw, team_raw = raw_name.split(" - ", 1)
        else:
            player_raw, team_raw = raw_name, ""
        
        player = to_canonical_name(player_raw.strip())
        team = team_raw.strip()

        dt_str = e.get("dateTime", "")
        kickoff_time = f"{dt_str}Z" if dt_str and not dt_str.endswith("Z") else dt_str

        slot = (cid, dt_str)
        game = game_strings.get(slot, "")

        # Group playable bets by market
        market_lines: dict[str, list[dict]] = defaultdict(list)
        for b in e.get("bets", []):
            if not b.get("isPlayable", True):
                continue
            sbv = b.get("sbv")
            if sbv is None:
                continue
            try:
                line_val = float(sbv)
            except (ValueError, TypeError):
                continue

            over_odd: float | None = None
            under_odd: float | None = None
            market_name: str | None = None

            for out in b.get("betOutcomes", []):
                if not out.get("isPlayable", True):
                    continue
                oid = out.get("betTypeOutcomeId")
                odd_val = out.get("odd")
                if oid in _OUTCOMES_MAP:
                    m_name, side = _OUTCOMES_MAP[oid]
                    market_name = m_name
                    if side == "over":
                        over_odd = float(odd_val) if odd_val is not None else None
                    elif side == "under":
                        under_odd = float(odd_val) if odd_val is not None else None

            if market_name and (over_odd is not None or under_odd is not None):
                market_lines[market_name].append({
                    "line": line_val,
                    "over": over_odd,
                    "under": under_odd,
                })

        # Select standard line closest to target over odds
        for m_name, lines in market_lines.items():
            best_line = None
            best_dist = float("inf")
            for l_info in lines:
                ov = l_info["over"]
                dist = abs(ov - _TARGET_OVER_ODDS) if ov is not None else 999.0
                if dist < best_dist:
                    best_dist = dist
                    best_line = l_info

            if best_line:
                records.append(
                    PropRecord(
                        league=league,
                        game=game,
                        team=team,
                        player=player,
                        market=m_name,
                        line=best_line["line"],
                        over_odds_decimal=best_line["over"],
                        under_odds_decimal=best_line["under"],
                        bookmaker=BOOKMAKER_NAME,
                        kickoff_time=kickoff_time,
                        updated_at=timestamp,
                    )
                )

    return records


# ---------- Cache helpers ----------

def _write_cache(records: list[PropRecord]) -> None:
    try:
        data = {
            "fetched_at": time.time(),
            "records": [
                {
                    "league":             r.league,
                    "game":               r.game,
                    "team":               r.team,
                    "player":             r.player,
                    "market":             r.market,
                    "line":               r.line,
                    "over_odds_decimal":  r.over_odds_decimal,
                    "under_odds_decimal": r.under_odds_decimal,
                    "bookmaker":          r.bookmaker,
                    "kickoff_time":       r.kickoff_time,
                    "updated_at":         r.updated_at,
                }
                for r in records
            ],
        }
        _CACHE_FILE.write_text(json.dumps(data), encoding="utf-8")
    except Exception as exc:
        print(f"[admiralbet] cache write failed: {exc}")


def _read_cache() -> tuple[list[PropRecord] | None, float]:
    try:
        if not _CACHE_FILE.exists():
            return None, float("inf")
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        age = time.time() - data.get("fetched_at", 0)
        records = [PropRecord(**r) for r in data.get("records", [])]
        return records, age
    except Exception as exc:
        print(f"[admiralbet] cache read failed: {exc}")
        return None, float("inf")


def _refresh_cache_background() -> None:
    global _memory_cache, _memory_cache_time
    try:
        records = fetch_admiralbet_props()
        _write_cache(records)
        with _cache_lock:
            _memory_cache = records
            _memory_cache_time = time.time()
        leagues = sorted({r.league for r in records})
        print(f"[admiralbet] refreshed {len(records)} records across {leagues}")
    except Exception as exc:
        print(f"[admiralbet] background refresh failed: {exc}")


# ---------- Public API ----------

def load_admiralbet_props() -> list[PropRecord]:
    """
    Return all PropRecord instances from AdmiralBet across supported leagues.

    Stale-while-revalidate:
      1. In-memory hit  → return immediately (< TTL)
      2. Disk cache     → return immediately, kick off background refresh if stale
      3. No cache       → block on live fetch (first run only)
    """
    global _memory_cache, _memory_cache_time

    now = time.time()

    with _cache_lock:
        if _memory_cache is not None and (now - _memory_cache_time) < _CACHE_TTL_SECONDS:
            return list(_memory_cache)

    cached_records, age = _read_cache()
    if cached_records is not None:
        with _cache_lock:
            _memory_cache = cached_records
            _memory_cache_time = now - age

        if age > _CACHE_TTL_SECONDS:
            threading.Thread(target=_refresh_cache_background, daemon=True).start()

        return list(cached_records)

    records = fetch_admiralbet_props()
    _write_cache(records)
    with _cache_lock:
        _memory_cache = records
        _memory_cache_time = time.time()
    return records
