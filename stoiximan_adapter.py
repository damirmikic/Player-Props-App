"""
Stoiximan adapter — pulls player prop odds from the Stoiximan REST API.

URL pattern (league-level player props):
  https://en.stoiximan.gr/api/sport/basketball/{region}/{slug}/{id}/{market_type}/
  ?req=la,s,stnf,c,mb,mbl

Prop market types (as URL path segment → internal market name):
  playerspoints   → "points"
  playersrebounds → "rebounds"
  playersassists  → "assists"

Odds format: "N+" threshold bets (e.g. "21+" = score at least 21).
  Conversion: "N+" → line = N − 0.5  (so "21+" ≡ "Over 20.5")
  Only over odds are offered; under_odds_decimal is always None.

Supported leagues (Lega A is not available on Stoiximan):
  Liga Endesa (Spain) → "ACB"
  WNBA (USA)          → "WNBA"
  Super League (Israel) → "Izrael"

Game strings: Stoiximan lists "Home - Away"; we invert to "Away @ Home"
to match the convention used by other adapters.
"""
from __future__ import annotations

import datetime
import json
import re
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen

from unabated_adapter import PropRecord
from name_utils import to_canonical_name

_BASE = "https://en.stoiximan.gr/api/sport/basketball"
_REQ_PARAMS = "req=la,s,stnf,c,mb,mbl"

BOOKMAKER_NAME = "Stoiximan"

SUPPORTED_LEAGUES = [
    {"path": "spain/liga-endesa/438g", "league": "ACB"},
    {"path": "spain/supercopa-endesa/471g", "league": "ACB"},
    {"path": "usa/wnba/440g",           "league": "WNBA"},
    {"path": "israel/super-league/1042g", "league": "Izrael"},
    {"path": "international/club-friendlies/16726", "league": "Club Friendly"},
    {"path": "euroleague/euroleague/439g", "league": "Euroleague"},
    {"path": "euroleague/euroleague-super-cup/1127g", "league": "Euroleague"},
    {"path": "germany/bbl/458g", "league": "BBL"},
]

PROP_MARKET_TYPES = {
    "playerspoints":   "points",
    "playersrebounds": "rebounds",
    "playersassists":  "assists",
}

EVENT_MARKET_TYPES = {
    "PLNP": "points",
    "PLNR": "rebounds",
    "PLNA": "assists",
    "PLN3": "three_pointers",
}

_CACHE_FILE        = Path(__file__).resolve().parent / "stoiximan_cache.json"
_CACHE_TTL_SECONDS = 300
_FETCH_TIMEOUT     = 20

_memory_cache: list | None = None
_memory_cache_time: float  = 0.0
_cache_lock = threading.Lock()

_HEADERS = {
    "Accept": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
}


def _get(url: str) -> dict:
    req = Request(url, headers=_HEADERS)
    with urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


_ODDS_TARGET = 1.95   # midpoint of realistic 1.7-2.2 range
_ODDS_LO     = 1.70
_ODDS_HI     = 2.20


def _parse_threshold(name: str) -> float | None:
    """Convert '21+' to 20.5 (score >= N is equivalent to Over N-0.5)."""
    m = re.match(r"^(\d+)\+$", name.strip())
    return float(m.group(1)) - 0.5 if m else None


def _pick_best_threshold(
    candidates: list[tuple[float, float]],  # [(line, over_odds), ...]
) -> tuple[float, float] | None:
    """Return the (line, over_odds) pair closest to 1.95 within 1.70-2.20.

    Returns None if no candidate falls within the realistic range.
    """
    in_range = [c for c in candidates if _ODDS_LO <= c[1] <= _ODDS_HI]
    if not in_range:
        return None
    return min(in_range, key=lambda c: abs(c[1] - _ODDS_TARGET))


def fetch_league_market(league_path: str, market_type: str) -> dict:
    url = f"{_BASE}/{league_path}/{market_type}/?{_REQ_PARAMS}"
    return _get(url)


def parse_league_market(
    data: dict,
    league_label: str,
    market_name: str,
) -> list[PropRecord]:
    records = []
    timestamp = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    for block in data.get("data", {}).get("blocks", []):
        for event in block.get("events", []):
            raw_name = event.get("name", "")
            parts = re.split(r"\s+-\s+", raw_name)
            game = f"{parts[1]} @ {parts[0]}" if len(parts) == 2 else raw_name

            start_ms = event.get("startTime", 0)
            kickoff_time = (
                datetime.datetime.utcfromtimestamp(start_ms / 1000)
                .strftime("%Y-%m-%dT%H:%M:%SZ")
                if start_ms else ""
            )

            for market in event.get("markets", []):
                tl = market.get("tableLayout")
                if not tl:
                    continue

                group_map = {g["id"]: g["title"] for g in tl.get("groups", []) if "id" in g and "title" in g}

                for row in tl.get("rows", []):
                    player_raw = (row.get("title") or row.get("name") or "").strip()
                    if not player_raw:
                        continue
                    player = to_canonical_name(player_raw)
                    team   = group_map.get(row.get("groupId", ""), "")

                    # Collect all (line, odds) thresholds for this player
                    candidates: list[tuple[float, float]] = []
                    for gs in row.get("groupSelections", []):
                        for sel in gs.get("selections", []):
                            line = _parse_threshold(sel.get("name", ""))
                            price = sel.get("price")
                            if line is not None and price is not None:
                                candidates.append((line, float(price)))

                    best = _pick_best_threshold(candidates)
                    if best is None:
                        continue
                    line, over_odds = best
                    records.append(
                        PropRecord(
                            league=league_label,
                            game=game,
                            team=team,
                            player=player,
                            market=market_name,
                            line=line,
                            over_odds_decimal=over_odds,
                            under_odds_decimal=None,
                            bookmaker=BOOKMAKER_NAME,
                            kickoff_time=kickoff_time,
                            updated_at=timestamp,
                        )
                    )
    return records


def parse_match_event_props(data: dict, league_label: str) -> list[PropRecord]:
    """Parse player props from a single event match detail payload."""
    records = []
    timestamp = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    event = data.get("data", {}).get("event", {})
    if not event:
        return records

    raw_name = event.get("name", "")
    parts = re.split(r"\s+-\s+", raw_name)
    game = f"{parts[1]} @ {parts[0]}" if len(parts) == 2 else raw_name

    start_ms = event.get("startTime", 0)
    kickoff_time = (
        datetime.datetime.utcfromtimestamp(start_ms / 1000)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
        if start_ms else ""
    )

    for market in event.get("markets", []):
        tl = market.get("tableLayout")
        if not tl:
            continue

        mtype = market.get("type", "")
        mname = market.get("name", "")
        market_name = EVENT_MARKET_TYPES.get(mtype)
        if not market_name:
            if "Total Points" in mname or "Poeni" in mname:
                market_name = "points"
            elif "Total Rebounds" in mname or "Skokovi" in mname:
                market_name = "rebounds"
            elif "Total Assists" in mname or "Asistencije" in mname:
                market_name = "assists"
            elif "Three-Pointers" in mname or "3-Point" in mname:
                market_name = "three_pointers"

        if not market_name:
            continue

        group_map = {g["id"]: g["title"] for g in tl.get("groups", []) if "id" in g and "title" in g}

        for row in tl.get("rows", []):
            player_raw = (row.get("title") or row.get("name") or "").strip()
            if not player_raw:
                continue
            player = to_canonical_name(player_raw)
            team   = group_map.get(row.get("groupId", ""), "")

            candidates: list[tuple[float, float]] = []
            for gs in row.get("groupSelections", []):
                for sel in gs.get("selections", []):
                    line = _parse_threshold(sel.get("name", ""))
                    price = sel.get("price")
                    if line is not None and price is not None:
                        candidates.append((line, float(price)))

            best = _pick_best_threshold(candidates)
            if best is None:
                continue
            line, over_odds = best
            records.append(
                PropRecord(
                    league=league_label,
                    game=game,
                    team=team,
                    player=player,
                    market=market_name,
                    line=line,
                    over_odds_decimal=over_odds,
                    under_odds_decimal=None,
                    bookmaker=BOOKMAKER_NAME,
                    kickoff_time=kickoff_time,
                    updated_at=timestamp,
                )
            )
    return records


def fetch_league_event_props(league_path: str, league_label: str) -> list[PropRecord]:
    """Fetch all upcoming match events in a league and extract player props."""
    records: list[PropRecord] = []
    league_url = f"{_BASE}/{league_path}/?{_REQ_PARAMS}"
    data = _get(league_url)
    now = time.time()

    events = []
    for block in data.get("data", {}).get("blocks", []):
        for event in block.get("events", []):
            events.append(event)

    # Filter events scheduled within the next 36 hours (or recently started)
    upcoming_events = [
        e for e in events
        if e.get("url") and abs((e.get("startTime", 0) / 1000) - now) < 36 * 3600
    ]

    for event in upcoming_events:
        event_url = event["url"]
        match_api_url = f"https://en.stoiximan.gr/api{event_url}?{_REQ_PARAMS}"
        try:
            match_data = _get(match_api_url)
            match_records = parse_match_event_props(match_data, league_label)
            records.extend(match_records)
        except Exception as exc:
            print(f"[stoiximan] match fetch failed {event_url}: {exc}")

    return records


def fetch_all_stoiximan_props() -> list[PropRecord]:
    all_records: list[PropRecord] = []
    for league_info in SUPPORTED_LEAGUES:
        league_path = league_info["path"]
        league_label = league_info["league"]
        league_records: list[PropRecord] = []

        # 1. Try league-level markets first (fastest, standard for WNBA/ACB)
        for market_type, market_name in PROP_MARKET_TYPES.items():
            try:
                data = fetch_league_market(league_path, market_type)
                records = parse_league_market(data, league_label, market_name)
                league_records.extend(records)
            except Exception:
                pass

        # 2. If league-level returned nothing, fallback to scanning individual match events
        if not league_records:
            try:
                league_records = fetch_league_event_props(league_path, league_label)
            except Exception as exc:
                print(f"[stoiximan] failed league events {league_path}: {exc}")

        all_records.extend(league_records)
    return all_records


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
        print(f"[stoiximan] cache write failed: {exc}")


def _read_cache() -> tuple[list[PropRecord] | None, float]:
    try:
        if not _CACHE_FILE.exists():
            return None, float("inf")
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        age  = time.time() - data.get("fetched_at", 0)
        records = [PropRecord(**r) for r in data.get("records", [])]
        return records, age
    except Exception as exc:
        print(f"[stoiximan] cache read failed: {exc}")
        return None, float("inf")


def _refresh_cache_background() -> None:
    global _memory_cache, _memory_cache_time
    try:
        records = fetch_all_stoiximan_props()
        _write_cache(records)
        with _cache_lock:
            _memory_cache      = records
            _memory_cache_time = time.time()
        leagues = sorted({r.league for r in records})
        print(f"[stoiximan] refreshed {len(records)} records across {leagues}")
    except Exception as exc:
        print(f"[stoiximan] background refresh failed: {exc}")


# ---------- Public API ----------

def load_stoiximan_props() -> list[PropRecord]:
    """
    Return all PropRecord instances from Stoiximan across supported leagues.

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
            _memory_cache      = cached_records
            _memory_cache_time = now - age

        if age > _CACHE_TTL_SECONDS:
            threading.Thread(target=_refresh_cache_background, daemon=True).start()

        return list(cached_records)

    records = fetch_all_stoiximan_props()
    _write_cache(records)
    with _cache_lock:
        _memory_cache      = records
        _memory_cache_time = time.time()
    return records
