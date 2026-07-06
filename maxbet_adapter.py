"""
MaxBet RS adapter — pulls player prop odds from the MaxBet REST API.

Endpoint:
  GET https://www.maxbet.rs/restapi/offer/sr/sport/SK/mob
      ?annex=0&desktopVersion=2.44.3.18&locale=sr

Structure: each entry in esMatches is a *player* (not a team matchup).
  home        → player full name  ("Aliyah Boston")
  away        → player's team     ("Indiana W")
  params      → {ouPlPoints: "16.5", ouPlRebounds: "8.5", ouPlAssists: "2.5"}
  odds        → {tipTypeId: decimal_odds}
  kickOffTime → epoch ms of game start

Odds tip-type IDs:
  51679 PL_POINTS_OVER   51681 PL_POINTS_UNDER
  51682 PL_ASSISTS_OVER  51684 PL_ASSISTS_UNDER
  51685 PL_REBOUNDS_OVER 51687 PL_REBOUNDS_UNDER

Leagues are auto-discovered: any esMatch entry that carries at least one
player-prop parameter (ouPlPoints, ouPlAssists, ouPlRebounds) is accepted.
Series/outright-bet entries are skipped because they have no ouPl* params.

Game strings are reconstructed by pairing the two teams that share a
(league, kickOffTime) slot. The resulting "TeamA @ TeamB" strings are
approximate; cross-source normalization in server.py will refine them.
"""
from __future__ import annotations

import datetime
import re
import json
import threading
import time
from collections import defaultdict
from pathlib import Path
from urllib.request import Request, urlopen

from unabated_adapter import PropRecord
from name_utils import to_canonical_name

_BASE_URL = (
    "https://www.maxbet.rs/restapi/offer/sr/sport/SK/mob"
    "?annex=0&desktopVersion=2.44.3.18&locale=sr"
)

BOOKMAKER_NAME = "MaxBet"

# MaxBet prefixes player-prop league names with the Serbian phrase
# "Poeni igrača" (Player Points). Strip it to get the bare league name.
_MAXBET_PREFIX_RE = re.compile(
    r'^poeni\s+igra[\u010dc]a\s*[-–]?\s*', re.IGNORECASE
)


def _league_label(entry: dict) -> str:
    """Derive a clean league label from a raw MaxBet esMatches entry."""
    raw = (entry.get("leagueName") or entry.get("league") or "").strip()
    if raw:
        return _MAXBET_PREFIX_RE.sub("", raw).strip()
    league_id = entry.get("leagueId")
    return f"League {league_id}" if league_id is not None else "Unknown"

# Tip-type ID → (market_name, side)
_ODDS_MAP: dict[str, tuple[str, str]] = {
    "51679": ("points",   "over"),
    "51681": ("points",   "under"),
    "51682": ("assists",  "over"),
    "51684": ("assists",  "under"),
    "51685": ("rebounds", "over"),
    "51687": ("rebounds", "under"),
}

# Param key → market name (used to check which props a player has a line for)
_PARAM_MARKET: dict[str, str] = {
    "ouPlPoints":   "points",
    "ouPlRebounds": "rebounds",
    "ouPlAssists":  "assists",
}

_CACHE_FILE        = Path(__file__).resolve().parent / "maxbet_cache.json"
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


def _get() -> dict:
    req = Request(_BASE_URL, headers=_HEADERS)
    with urlopen(req, timeout=_FETCH_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _epoch_ms_to_iso(ms: int) -> str:
    return (
        datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ")
    )


def _build_game_strings(entries: list[dict]) -> dict[tuple[int, int], str]:
    """
    For each (leagueId, kickOffTime) pair, collect both teams and build a
    game string "TeamA @ TeamB" (alphabetical order; server.py will refine).
    Returns a dict mapping (leagueId, kickOffTime) → game_string.
    """
    teams_by_slot: dict[tuple[int, int], set[str]] = defaultdict(set)
    for e in entries:
        slot = (e["leagueId"], e["kickOffTime"])
        team = e.get("away", "").strip()
        if team:
            teams_by_slot[slot].add(team)

    game_strings: dict[tuple[int, int], str] = {}
    for slot, teams in teams_by_slot.items():
        sorted_teams = sorted(teams)
        if len(sorted_teams) == 2:
            game_strings[slot] = f"{sorted_teams[0]} @ {sorted_teams[1]}"
        elif len(sorted_teams) == 1:
            game_strings[slot] = sorted_teams[0]
        else:
            game_strings[slot] = " @ ".join(sorted_teams[:2])
    return game_strings


def fetch_maxbet_props() -> list[PropRecord]:
    data      = _get()
    timestamp = datetime.datetime.now(tz=datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entries   = data.get("esMatches", [])

    # Keep only player-prop leagues
    # Auto-discover: keep any entry that exposes at least one player-prop param.
    pl_entries = [
        e for e in entries
        if e.get("params")
        and any(k in _PARAM_MARKET for k in e.get("params", {}))
    ]

    game_strings = _build_game_strings(pl_entries)
    records: list[PropRecord] = []

    for e in pl_entries:
        league      = _league_label(e)
        slot        = (e["leagueId"], e["kickOffTime"])
        game        = game_strings.get(slot, "")
        kickoff_time = _epoch_ms_to_iso(e["kickOffTime"])
        team        = e.get("away", "").strip()
        player      = to_canonical_name(e.get("home", "").strip())
        params      = e.get("params", {})
        odds        = e.get("odds", {})

        # Collect over/under per market from the odds dict
        market_odds: dict[str, dict[str, float | None]] = {}
        for tid, (market, side) in _ODDS_MAP.items():
            if tid in odds:
                market_odds.setdefault(market, {"over": None, "under": None})
                market_odds[market][side] = float(odds[tid])

        # Emit one PropRecord per market that has a line in params
        for param_key, market in _PARAM_MARKET.items():
            line_str = params.get(param_key)
            if line_str is None:
                continue
            try:
                line = float(line_str)
            except ValueError:
                continue

            sides = market_odds.get(market, {})
            over  = sides.get("over")
            under = sides.get("under")
            if over is None and under is None:
                continue

            records.append(
                PropRecord(
                    league=league,
                    game=game,
                    team=team,
                    player=player,
                    market=market,
                    line=line,
                    over_odds_decimal=over,
                    under_odds_decimal=under,
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
        print(f"[maxbet] cache write failed: {exc}")


def _read_cache() -> tuple[list[PropRecord] | None, float]:
    try:
        if not _CACHE_FILE.exists():
            return None, float("inf")
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        age  = time.time() - data.get("fetched_at", 0)
        records = [PropRecord(**r) for r in data.get("records", [])]
        return records, age
    except Exception as exc:
        print(f"[maxbet] cache read failed: {exc}")
        return None, float("inf")


def _refresh_cache_background() -> None:
    global _memory_cache, _memory_cache_time
    try:
        records = fetch_maxbet_props()
        _write_cache(records)
        with _cache_lock:
            _memory_cache      = records
            _memory_cache_time = time.time()
        leagues = sorted({r.league for r in records})
        print(f"[maxbet] refreshed {len(records)} records across {leagues}")
    except Exception as exc:
        print(f"[maxbet] background refresh failed: {exc}")


# ---------- Public API ----------

def load_maxbet_props() -> list[PropRecord]:
    """
    Return all PropRecord instances from MaxBet across supported leagues.

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

    records = fetch_maxbet_props()
    _write_cache(records)
    with _cache_lock:
        _memory_cache      = records
        _memory_cache_time = time.time()
    return records
