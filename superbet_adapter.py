"""
Superbet RS adapter — pulls player prop odds from the Superbet REST API
and normalises them into the same PropRecord schema used by other adapters.

Two-step fetch per run:
  1. GET /events/by-date  → list today's basketball event IDs
  2. GET /events/{id}     → per-event full odds (flat array of all markets)

Player prop market IDs (basketball):
  239934  Points O/U       → "points"
  239935  Assists O/U      → "assists"
  239936  Rebounds O/U     → "rebounds"

Over/under is determined from the odds `name` field:
  "Više od"  → over
  "Manje od" → under

All basketball categories (sportId == 4) are fetched automatically.
The ``categoryName`` returned by the API is used as the league label.
Only events that contain known player-prop market IDs produce records.

Prices are already in decimal format — no conversion needed.
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

_BASE = "https://production-superbet-offer-rs.freetls.fastly.net/sb-rs/api/v2/sr-Latn-RS"
EVENTS_BY_DATE_URL = _BASE + "/events/by-date"
EVENT_DETAIL_URL   = _BASE + "/events/{event_id}"

BOOKMAKER_NAME = "Superbet"

SPORT_ID_BASKETBALL = 4

# Soft name map: categoryId → human-readable league label.
# Used for display only — does NOT filter out unknown categories.
# Any categoryId missing here falls back to "Cat {id}" so new leagues
# are automatically included with a temporary numeric label.
CATEGORY_NAMES: dict[int, str] = {
    61:  "WNBA",
    108: "ACB",
    56:  "Lega A",
    185: "Izrael",
    36:  "FIBA Qualifiers",
}

# categoryId 36 is a shared "international/other" bucket that Superbet
# reuses across unrelated competitions (FIBA Qualifiers, World Cup Women,
# Euroleague, various domestic leagues) — categoryName is never populated
# by this API, so a single categoryId → label mapping isn't enough to
# disambiguate. tournamentId is the only field that varies per competition
# within that bucket, so give it its own override table, checked first.
TOURNAMENT_NAMES: dict[int, str] = {
    2401: "Club Friendly",
    6361: "World Cup Women",
    6362: "World Cup Women",
    6363: "World Cup Women",
    6364: "World Cup Women",
    6751: "World Cup Women",
    101815: "Euroleague Supercup",
    19114: "Euroleague",
}


PLAYER_PROP_MARKETS = {
    # ACB / Lega A / Izrael
    239934: "points",
    239935: "assists",
    239936: "rebounds",
    # WNBA (different feed IDs, same semantic markets)
    233565: "points",
    233566: "assists",
    233567: "rebounds",
    # Friendlies / Internationals
    231182: "points",
}

_CACHE_FILE       = Path(__file__).resolve().parent / "superbet_cache.json"
_CACHE_TTL_SECONDS = 300   # 5 minutes
_FETCH_TIMEOUT    = 20

_memory_cache: list | None = None
_memory_cache_time: float = 0.0
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


def _today_start() -> str:
    return datetime.datetime.utcnow().strftime("%Y-%m-%d+00:00:00")


def fetch_superbet_events() -> list[dict]:
    """Return today's basketball events that belong to a supported league."""
    url = (
        f"{EVENTS_BY_DATE_URL}"
        f"?currentStatus=active&offerState=prematch&startDate={_today_start()}"
    )
    data = _get(url)
    return [
        e for e in data.get("data", [])
        if e.get("sportId") == SPORT_ID_BASKETBALL
    ]


def fetch_event_odds(event_id: int) -> list[dict]:
    """Return the flat odds array for a single event."""
    url = EVENT_DETAIL_URL.format(event_id=event_id)
    data = _get(url)
    events = data.get("data", [])
    return events[0].get("odds", []) if events else []


def _normalize_player_name(raw: str) -> str:
    """Convert 'Last, First' (WNBA feed) or 'First Last' to canonical 'Last F.' form."""
    name = raw.strip()
    if "," in name:
        # "Boston, Aliyah" → "Aliyah Boston"
        parts = name.split(",", 1)
        name = f"{parts[1].strip()} {parts[0].strip()}"
    return to_canonical_name(name)


def parse_superbet_props(events: list[dict]) -> list[PropRecord]:
    """Parse all supported events into PropRecord instances."""
    records = []
    timestamp = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    for event in events:
        league    = TOURNAMENT_NAMES.get(event.get("tournamentId", -1))
        if league is None:
            league = CATEGORY_NAMES.get(event.get("categoryId", -1))
        if league is None:
            cid = event.get("categoryId", "?")
            league = (event.get("categoryName") or f"Cat {cid}").strip()
        game      = event.get("matchName", "")
        game      = re.sub(r'\s*\([ŽWw]\)', '', game)
        
        # Superbet (European) lists Home vs Away. Unabated (US) lists Away @ Home.
        parts = re.split(r'\s+(?:vs|-|·)\s+', game)
        if len(parts) == 2:
            game = f"{parts[1]} @ {parts[0]}"
        else:
            game = game.replace("·", " @ ").replace(" vs ", " @ ").replace(" - ", " @ ")
            
        event_id  = event["eventId"]
        kickoff_time = event.get("matchDate", "").replace(" ", "T") + "Z"

        try:
            odds_list = fetch_event_odds(event_id)
        except Exception as exc:
            print(f"[superbet] failed to fetch event {event_id}: {exc}")
            continue

        # Group by (player, market, line) to pair over + under
        groups: dict[tuple, dict] = {}
        for odd in odds_list:
            market_id = odd.get("marketId")
            market    = PLAYER_PROP_MARKETS.get(market_id)
            if not market:
                continue
            if odd.get("status") != "active":
                continue

            spec   = odd.get("specifiers") or {}
            player = spec.get("player", "").strip()
            total  = spec.get("total", "")
            if not player or not total:
                continue

            try:
                line = float(total)
            except ValueError:
                continue

            key  = (player, market, line)
            name = odd.get("name", "")
            price = odd.get("price")
            if price is None:
                continue

            entry = groups.setdefault(key, {"over": None, "under": None})
            if "Više od" in name or "vise od" in name.lower():
                entry["over"] = float(price)
            elif "Manje od" in name or "manje od" in name.lower():
                entry["under"] = float(price)

        for (raw_player, market, line), sides in groups.items():
            if sides["over"] is None and sides["under"] is None:
                continue
            records.append(
                PropRecord(
                    league=league,
                    game=game,
                    team="",
                    player=_normalize_player_name(raw_player),
                    market=market,
                    line=line,
                    over_odds_decimal=sides["over"],
                    under_odds_decimal=sides["under"],
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
        print(f"[superbet] cache write failed: {exc}")


def _read_cache() -> tuple[list[PropRecord] | None, float]:
    try:
        if not _CACHE_FILE.exists():
            return None, float("inf")
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        age  = time.time() - data.get("fetched_at", 0)
        records = [PropRecord(**r) for r in data.get("records", [])]
        return records, age
    except Exception as exc:
        print(f"[superbet] cache read failed: {exc}")
        return None, float("inf")


def _refresh_cache_background() -> None:
    global _memory_cache, _memory_cache_time
    try:
        events  = fetch_superbet_events()
        records = parse_superbet_props(events)
        _write_cache(records)
        with _cache_lock:
            _memory_cache      = records
            _memory_cache_time = time.time()
        leagues = sorted({r.league for r in records})
        print(f"[superbet] refreshed {len(records)} records across {leagues}")
    except Exception as exc:
        print(f"[superbet] background refresh failed: {exc}")


# ---------- Public API ----------

def load_superbet_props() -> list[PropRecord]:
    """
    Return all PropRecord instances from Superbet across supported leagues.

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

    events  = fetch_superbet_events()
    records = parse_superbet_props(events)
    _write_cache(records)
    with _cache_lock:
        _memory_cache      = records
        _memory_cache_time = time.time()
    return records
