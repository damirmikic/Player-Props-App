"""
Merkur Xtip adapter — pulls player prop odds from the Merkur SK REST endpoint
and normalises them into the same PropRecord schema used by unabated_adapter.

Merkur encodes each match as a player-vs-opponent event (not a team matchup).
  home   = player name  (e.g. "Clark C.")
  away   = opponent team (e.g. "Indiana Fever")
  odds   = {oddId: decimal_odds, ...}   — already in decimal, no conversion
  params = {ouPlPoints: "19.5", ouPlAssists: "8.5", ...}

Odd-ID → market mapping (same IDs used across all supported leagues):
  51681 / 51679  Over / Under Points
  51682 / 51684  Over / Under Assists
  51685 / 51687  Over / Under Rebounds
  51688 / 51690  Over / Under 3-Pointers
  55215 / 55217  Over / Under TPRA (Pts+Reb+Ast combined)

Supported leagues (leagueId → league label):
  2359021  WNBA Igrači     → "WNBA"
  2314422  ACB Igrači      → "ACB"
  2332283  Lega A Igrači   → "Lega A"
  2351877  Izrael igrači   → "Izrael"

The "Duel Strelaca" league (2315079) is a fantasy player-vs-player market with
a different odds structure and is intentionally excluded.

Performance note:
  The Merkur endpoint can be slow. A file-backed stale-while-revalidate cache
  (TTL 5 min) ensures sub-millisecond responses after the first run.
"""

from dataclasses import dataclass, asdict
import json
import gzip
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen
import datetime

from unabated_adapter import PropRecord
from name_utils import to_canonical_name

MERKUR_SK_URL = (
    "https://www.merkurxtip.rs/restapi/offer/sr/sport/SK/mob"
    "?annex=0&desktopVersion=2.44.3.18&locale=sr"
)

# Supported leagues: leagueId → canonical league label shown in the UI
SUPPORTED_LEAGUES = {
    2359021: "WNBA",
    2314422: "ACB",
    2332283: "Lega A",
    2351877: "Izrael",
}

BOOKMAKER_NAME = "Merkur Xtip"

# Cache file lives next to this module
_CACHE_FILE = Path(__file__).resolve().parent / "merkur_cache.json"
_CACHE_TTL_SECONDS = 300   # 5 minutes
_FETCH_TIMEOUT = 30        # seconds; Merkur can be slow

# Thread-safe in-memory cache
_memory_cache: list | None = None
_memory_cache_time: float = 0.0
_cache_lock = threading.Lock()

# Maps (over_odd_id, under_odd_id) → market name
MARKET_ODD_PAIRS = {
    ("51681", "51679"): "points",
    ("51682", "51684"): "assists",
    ("51685", "51687"): "rebounds",
    ("51688", "51690"): "three_pointers",
    ("55215", "55217"): "tpra",
}

# param key → market name (used to read the line value)
PARAM_TO_MARKET = {
    "ouPlPoints":   "points",
    "ouPlAssists":  "assists",
    "ouPlRebounds": "rebounds",
    "ouPl3Points":  "three_pointers",
    "ouPlTPRA":     "tpra",
}

# Reverse: market → over_odd_id, under_odd_id
MARKET_OVER_ID  = {m: over  for (over, under), m in MARKET_ODD_PAIRS.items()}
MARKET_UNDER_ID = {m: under for (over, under), m in MARKET_ODD_PAIRS.items()}


def fetch_merkur_props():
    """Download the raw JSON from the Merkur SK endpoint."""
    request = Request(
        MERKUR_SK_URL,
        headers={
            "Accept": "application/json",
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        },
    )
    with urlopen(request, timeout=_FETCH_TIMEOUT) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip" or body[:2] == b"\x1f\x8b":
            body = gzip.decompress(body)
        return json.loads(body.decode("utf-8-sig"))


def parse_merkur_all_leagues(raw):
    """
    Parse the SK payload and return PropRecord instances for all supported
    basketball leagues. One record is emitted per player × market.
    """
    records = []
    timestamp = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")

    for match in raw.get("esMatches", []):
        league_id = match.get("leagueId")
        league_label = SUPPORTED_LEAGUES.get(league_id)
        if league_label is None:
            continue  # skip unsupported leagues (e.g. Duel Strelaca)

        player   = to_canonical_name((match.get("home") or "").strip())
        opponent = (match.get("away") or "").strip()
        odds_raw = match.get("odds") or {}
        params   = match.get("params") or {}

        if not player:
            continue

        # Game label = opponent team name (Merkur player props are player vs team)
        game = opponent or "Unknown"

        # Emit one record per market that has both a line and at least one odds side
        for param_key, market in PARAM_TO_MARKET.items():
            raw_line = params.get(param_key)
            if raw_line is None:
                continue
            try:
                line = float(raw_line)
            except (ValueError, TypeError):
                continue
            if line == 0:
                continue  # Merkur uses 0 as a "no line" placeholder

            over_id  = MARKET_OVER_ID.get(market)
            under_id = MARKET_UNDER_ID.get(market)

            over_odds  = odds_raw.get(over_id)
            under_odds = odds_raw.get(under_id)

            if over_odds is None and under_odds is None:
                continue

            records.append(
                PropRecord(
                    league=league_label,
                    game=game,
                    team="",          # Merkur doesn't list the player's own team
                    player=player,
                    market=market,
                    line=line,
                    over_odds_decimal=float(over_odds)  if over_odds  is not None else None,
                    under_odds_decimal=float(under_odds) if under_odds is not None else None,
                    bookmaker=BOOKMAKER_NAME,
                    updated_at=timestamp,
                )
            )

    return records


# ---------- Cache helpers ----------

def _write_cache(records):
    """Persist records list to the disk cache file (as plain dicts for JSON)."""
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
                    "updated_at":         r.updated_at,
                }
                for r in records
            ],
        }
        _CACHE_FILE.write_text(json.dumps(data), encoding="utf-8")
    except Exception as exc:
        print(f"[merkur] cache write failed: {exc}")


def _read_cache():
    """Returns (records, age_seconds) from disk, or (None, inf) if absent/invalid."""
    try:
        if not _CACHE_FILE.exists():
            return None, float("inf")
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        age  = time.time() - data.get("fetched_at", 0)
        records = [PropRecord(**r) for r in data.get("records", [])]
        return records, age
    except Exception as exc:
        print(f"[merkur] cache read failed: {exc}")
        return None, float("inf")


def _refresh_cache_background():
    """Fetch fresh data from Merkur in a daemon thread; update cache on success."""
    global _memory_cache, _memory_cache_time
    try:
        raw     = fetch_merkur_props()
        records = parse_merkur_all_leagues(raw)
        _write_cache(records)
        with _cache_lock:
            _memory_cache      = records
            _memory_cache_time = time.time()
        leagues = set(r.league for r in records)
        print(f"[merkur] refreshed {len(records)} records across {sorted(leagues)}")
    except Exception as exc:
        print(f"[merkur] background refresh failed: {exc}")


# ---------- Public API ----------

def load_merkur_props():
    """
    Return all PropRecord instances from Merkur across all supported leagues.

    Stale-while-revalidate strategy:
      1. In-memory hit  → return immediately (< TTL)
      2. Disk cache     → return immediately, kick off background refresh if stale
      3. No cache       → block on live fetch (first run only)
    """
    global _memory_cache, _memory_cache_time

    now = time.time()

    # 1. In-memory cache hit
    with _cache_lock:
        if _memory_cache is not None and (now - _memory_cache_time) < _CACHE_TTL_SECONDS:
            return list(_memory_cache)

    # 2. Disk cache (may be stale)
    cached_records, age = _read_cache()
    if cached_records is not None:
        with _cache_lock:
            _memory_cache      = cached_records
            _memory_cache_time = now - age

        if age > _CACHE_TTL_SECONDS:
            thread = threading.Thread(target=_refresh_cache_background, daemon=True)
            thread.start()

        return list(cached_records)

    # 3. No cache at all — block on live fetch
    raw     = fetch_merkur_props()
    records = parse_merkur_all_leagues(raw)
    _write_cache(records)
    with _cache_lock:
        _memory_cache      = records
        _memory_cache_time = time.time()
    return records


# Backward-compat alias used by older code / tests
def load_merkur_wnba_props():
    """Return only WNBA records (backward-compatible alias)."""
    return [r for r in load_merkur_props() if r.league == "WNBA"]
