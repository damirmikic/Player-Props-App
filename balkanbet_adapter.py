"""
BalkanBet adapter — pulls basketball player prop odds from the BalkanBet / NSoft API.

Endpoints:
  GET https://sports-sm-distribution-api.de-2.nsoftcdn.com/api/v1/tournaments
      ?companyUuid=4f54c6aa-82a9-475d-bf0e-dc02ded89225&deliveryPlatformId=3
      &timezone=Europe/Belgrade&language={"default":"sr-Latn"}&filter[sportId]=273
      -> Maps tournamentId to tournament name (e.g. "Igrači Evroliga Super Kup").

  GET https://sports-sm-distribution-api.de-2.nsoftcdn.com/api/v1/events
      ?deliveryPlatformId=3&dataFormat={"default":"object","events":"array","outcomes":"array"}
      &language={"default":"sr-Latn"}&timezone=Europe/Belgrade
      &companyUuid=4f54c6aa-82a9-475d-bf0e-dc02ded89225&filter[sportId]=273
      &filter[from]={now}&sort=categoryPosition,categoryName,tournamentPosition,tournamentName,startsAt
      -> Returns player prop events, each containing market groups and outcomes.

Structure:
  Each event in sportId == 273 represents a player prop entity:
    name: "Player Name (Team Name)"  (e.g. "S.Vezenkov (Olympiacos)")
    startsAt: "2026-09-18T14:00:00.000Z"
    tournamentId: mapped to competition name via tournaments endpoint.

Markets:
  2402: "points"
  2403: "rebounds"
  2406: "assists"

Line selection:
  When multiple lines exist for a market, the one marked with favourite == True
  is chosen (the primary balanced bookmaker line).
"""
from __future__ import annotations

import datetime
from collections import defaultdict
import json
from pathlib import Path
import re
import threading
import time
import urllib.parse
from urllib.request import Request, urlopen

from unabated_adapter import PropRecord
from name_utils import to_canonical_name, to_canonical_league

BOOKMAKER_NAME = "BalkanBet"
SPORT_ID_PROPS = 273
COMPANY_UUID = "4f54c6aa-82a9-475d-bf0e-dc02ded89225"
DELIVERY_PLATFORM_ID = 3

_BASE_API = "https://sports-sm-distribution-api.de-2.nsoftcdn.com/api/v1"

_HEADERS = {
    "Accept": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Origin": "https://balkanbet.rs",
    "Referer": "https://balkanbet.rs/",
}

_FETCH_TIMEOUT = 25
_CACHE_TTL_SECONDS = 300  # 5 minutes
_CACHE_FILE = Path(__file__).parent / "balkanbet_cache.json"

_cache_lock = threading.Lock()
_memory_cache: list[PropRecord] | None = None
_memory_cache_time: float = 0.0

# Tournament lookup cache (tournament_id -> raw_name)
_tournament_map_cache: dict[int, str] = {}
_tournament_map_time: float = 0.0
_TOURNAMENT_TTL = 1800  # 30 minutes

# Market mapping: marketId -> internal canonical market name
_MARKET_MAP = {
    2402: "points",
    2403: "rebounds",
    2406: "assists",
}


def _fetch_json(url: str) -> dict:
    req = Request(url, headers=_HEADERS)
    with urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _get_tournament_map() -> dict[int, str]:
    global _tournament_map_cache, _tournament_map_time
    now = time.time()
    if _tournament_map_cache and (now - _tournament_map_time) < _TOURNAMENT_TTL:
        return _tournament_map_cache

    try:
        lang_json = urllib.parse.quote(json.dumps({"default": "sr-Latn"}))
        url = (
            f"{_BASE_API}/tournaments?"
            f"companyUuid={COMPANY_UUID}&deliveryPlatformId={DELIVERY_PLATFORM_ID}"
            f"&timezone=Europe%2FBelgrade&language={lang_json}"
            f"&filter[sportId]={SPORT_ID_PROPS}"
        )
        data = _fetch_json(url)
        tournaments = data.get("data", {}).get("tournaments", [])
        if isinstance(tournaments, list):
            res = {}
            for t in tournaments:
                t_id = t.get("id")
                t_name = t.get("name") or t.get("shortName") or ""
                if t_id is not None:
                    res[int(t_id)] = t_name
            _tournament_map_cache = res
            _tournament_map_time = now
            return res
    except Exception as exc:
        print(f"[balkanbet] failed to fetch tournament map: {exc}")

    return _tournament_map_cache


_SUFFIXES = {"JR", "SR", "II", "III", "IV"}


def _parse_balkanbet_player(raw: str) -> str:
    raw = raw.strip()
    # Handle double initials with dots like E.J.Liddell -> Liddell E.
    m_dbl = re.match(r"^([A-Za-z])\.[A-Za-z]\.([A-Za-z\-']+)$", raw)
    if m_dbl:
        initial, surname = m_dbl.groups()
        return f"{surname} {initial.upper()}."

    # Handle Abbr.Surname [Suffix] (e.g. W.Baldwin IV, T.Horton Tucker, S.Vezenkov)
    m_init = re.match(r"^([A-Za-z]+)\.(.+)$", raw)
    if m_init:
        abbr, rest = m_init.groups()
        initial = abbr[0].upper()
        tokens = rest.strip().split()

        # Strip Roman numerals or generational suffixes
        if tokens and tokens[-1].rstrip(".").upper() in _SUFFIXES:
            tokens.pop()

        if len(tokens) >= 2:
            # Compound surnames (Horton Tucker -> Horton-Tucker, Luwawu Cabarrot -> Luwawu-Cabarrot)
            surname = "-".join(tokens)
        elif len(tokens) == 1:
            surname = tokens[0]
        else:
            surname = rest.strip()

        return f"{surname} {initial}."

    return raw


def fetch_balkanbet_props() -> list[PropRecord]:
    """Fetch live player props from BalkanBet NSoft API."""
    tournament_map = _get_tournament_map()

    # Time filter: from now - 2 hours (to not miss props currently active)
    now_utc = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)
    now_iso = now_utc.strftime("%Y-%m-%dT%H:%M:%S")

    data_format = urllib.parse.quote(
        json.dumps({"default": "object", "events": "array", "outcomes": "array"})
    )
    lang_json = urllib.parse.quote(json.dumps({"default": "sr-Latn"}))

    events_url = (
        f"{_BASE_API}/events?"
        f"deliveryPlatformId={DELIVERY_PLATFORM_ID}"
        f"&dataFormat={data_format}"
        f"&language={lang_json}"
        f"&timezone=Europe%2FBelgrade"
        f"&companyUuid={COMPANY_UUID}"
        f"&filter[sportId]={SPORT_ID_PROPS}"
        f"&filter[from]={now_iso}"
        f"&sort=categoryPosition,categoryName,tournamentPosition,tournamentName,startsAt"
    )

    data = _fetch_json(events_url)
    raw_events = data.get("data", {}).get("events", [])
    if not isinstance(raw_events, list):
        return []

    records: list[PropRecord] = []
    now_iso_updated = datetime.datetime.now(datetime.timezone.utc).isoformat()

    for ev in raw_events:
        event_name = (ev.get("name") or ev.get("j") or "").strip()
        if not event_name:
            continue

        # Clean trailing dashes e.g. "J.Motley (Crvena zvezda) - "
        clean_event = re.sub(r"[\s\-–—]+$", "", event_name).strip()

        # Extract player and team: "Player Name (Team Name)"
        m = re.match(r"^(.*?)\s*\((.*?)\)$", clean_event)
        if m:
            raw_player = m.group(1).strip()
            team = m.group(2).strip()
        else:
            raw_player = clean_event
            team = ""

        parsed_player = _parse_balkanbet_player(raw_player)
        player = to_canonical_name(parsed_player)
        tournament_id = ev.get("tournamentId") or ev.get("f")
        raw_league = tournament_map.get(tournament_id, "")
        # Strip "Igrači " prefix (e.g. "Igrači Evroliga Super Kup" -> "Evroliga Super Kup")
        cleaned_league = re.sub(r"^[Ii]gra[čc\ufffd]i\s+", "", raw_league).strip()
        league = to_canonical_league(cleaned_league if cleaned_league else raw_league)

        starts_at = ev.get("startsAt") or ev.get("n") or ""
        game = f"vs {team}" if team else ""

        # Markets container
        markets_raw = ev.get("markets") or ev.get("o") or {}
        if isinstance(markets_raw, dict):
            markets_list = list(markets_raw.values())
        elif isinstance(markets_raw, list):
            markets_list = markets_raw
        else:
            markets_list = []

        # Group markets by marketId
        markets_by_type: dict[int, list[dict]] = defaultdict(list)
        for mkt in markets_list:
            m_id = mkt.get("marketId") or mkt.get("b")
            if m_id in _MARKET_MAP:
                markets_by_type[int(m_id)].append(mkt)

        for m_id, instances in markets_by_type.items():
            market_name = _MARKET_MAP[m_id]

            # Select primary line: favourite == True first, or first instance
            chosen = None
            for inst in instances:
                fav = inst.get("favourite") or inst.get("e")
                if fav is True:
                    chosen = inst
                    break
            if chosen is None and instances:
                chosen = instances[0]

            if not chosen:
                continue

            specials = chosen.get("specialValues") or chosen.get("g") or []
            if not specials:
                continue

            try:
                line = float(specials[0])
            except (ValueError, TypeError):
                continue

            outcomes = chosen.get("outcomes") or chosen.get("h") or []
            over_odds: float | None = None
            under_odds: float | None = None

            for oc in outcomes:
                oc_name = (oc.get("name") or oc.get("e") or "").lower()
                try:
                    odd_val = float(oc.get("odd") or oc.get("g") or 0)
                except (ValueError, TypeError):
                    continue

                if "manje" in oc_name or "under" in oc_name:
                    under_odds = odd_val
                elif "vi" in oc_name or "over" in oc_name:
                    over_odds = odd_val

            if over_odds is not None or under_odds is not None:
                records.append(
                    PropRecord(
                        player=player,
                        team=team,
                        league=league,
                        market=market_name,
                        line=line,
                        over_odds_decimal=over_odds,
                        under_odds_decimal=under_odds,
                        bookmaker=BOOKMAKER_NAME,
                        game=game,
                        kickoff_time=starts_at,
                        updated_at=now_iso_updated,
                    )
                )

    return records


# ---------- Cache management ----------

def _write_cache(records: list[PropRecord]) -> None:
    try:
        data = {
            "fetched_at": time.time(),
            "count": len(records),
            "records": [
                {
                    "league": r.league,
                    "game": r.game,
                    "team": r.team,
                    "player": r.player,
                    "market": r.market,
                    "line": r.line,
                    "over_odds_decimal": r.over_odds_decimal,
                    "under_odds_decimal": r.under_odds_decimal,
                    "bookmaker": r.bookmaker,
                    "kickoff_time": r.kickoff_time,
                    "updated_at": r.updated_at,
                }
                for r in records
            ],
        }
        _CACHE_FILE.write_text(json.dumps(data), encoding="utf-8")
    except Exception as exc:
        print(f"[balkanbet] cache write failed: {exc}")


def _read_cache() -> tuple[list[PropRecord] | None, float]:
    try:
        if not _CACHE_FILE.exists():
            return None, float("inf")
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        age = time.time() - data.get("fetched_at", 0)
        records = [PropRecord(**r) for r in data.get("records", [])]
        return records, age
    except Exception as exc:
        print(f"[balkanbet] cache read failed: {exc}")
        return None, float("inf")


def _refresh_cache_background() -> None:
    global _memory_cache, _memory_cache_time
    try:
        records = fetch_balkanbet_props()
        _write_cache(records)
        with _cache_lock:
            _memory_cache = records
            _memory_cache_time = time.time()
        leagues = sorted({r.league for r in records})
        print(f"[balkanbet] refreshed {len(records)} records across {leagues}")
    except Exception as exc:
        print(f"[balkanbet] background refresh failed: {exc}")


# ---------- Public API ----------

def load_balkanbet_props() -> list[PropRecord]:
    """
    Return all PropRecord instances from BalkanBet.

    Stale-while-revalidate:
      1. In-memory hit  -> return immediately (< TTL)
      2. Disk cache     -> return immediately, background refresh if stale
      3. No cache       -> block on live fetch (first run only)
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

    records = fetch_balkanbet_props()
    _write_cache(records)
    with _cache_lock:
        _memory_cache = records
        _memory_cache_time = now

    leagues = sorted({r.league for r in records})
    print(f"[balkanbet] initial fetch: {len(records)} records across {leagues}")
    return list(records)
