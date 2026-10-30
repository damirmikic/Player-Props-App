from __future__ import annotations


from dataclasses import asdict, replace
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import re
import threading
import time
import urllib.parse
import urllib.request

import news_utils

import unabated_adapter
import merkur_adapter
import superbet_adapter
import stoiximan_adapter
import maxbet_adapter
import mozzart_adapter
import admiralbet_adapter
import balkanbet_adapter
from unabated_adapter import build_highlights
from name_utils import (
    to_canonical_name, to_canonical_league, to_canonical_game,
    disambiguate_player, disambiguation_candidates,
)


ROOT = Path(__file__).resolve().parent

# Snapshot of the last API response used to detect line/odds movement.
# Keyed by "player|market|bookmaker"; values are {line, over_odds_decimal, under_odds_decimal}.
_prev_snapshot: dict = {}
_snapshot_lock = threading.Lock()

# ---- News feed cache -------------------------------------------------------
# Books whose "Away @ Home" is reconstructed by pairing teams on a kickoff
# slot, so the order is not a real home/away signal.
_UNORDERED_GAME_BOOKS = {"MaxBet", "AdmiralBet"}

_NEWS_FEED_URL = "https://rss.app/feeds/v1.1/5Wdnismo41isPtyA.json"
_NEWS_TTL_SECONDS = 300  # 5 minuta

_news_cache: dict | None = None
_news_cache_ts: float = 0.0
_news_lock = threading.Lock()


def _snapshot_key(r) -> str:
    return f"{r.player}|{r.market}|{r.bookmaker}"


def _is_upcoming(r) -> bool:
    """Keep records with no known kickoff time; drop games that have already started."""
    if not r.kickoff_time:
        return True
    try:
        kickoff = datetime.fromisoformat(r.kickoff_time.replace("Z", "+00:00"))
    except ValueError:
        return True
    if kickoff.tzinfo is None:
        kickoff = kickoff.replace(tzinfo=timezone.utc)
    return kickoff >= datetime.now(timezone.utc)


def _compute_deltas(records: list, prev: dict) -> dict:
    """Return {snapshot_key: delta_dict} for records whose line or odds changed since prev."""
    result = {}
    for r in records:
        key = _snapshot_key(r)
        p = prev.get(key)
        if p is None:
            continue

        ld = round(r.line - p["line"], 2)
        od = (
            round(r.over_odds_decimal - p["over_odds_decimal"], 3)
            if r.over_odds_decimal is not None and p["over_odds_decimal"] is not None
            else None
        )
        ud = (
            round(r.under_odds_decimal - p["under_odds_decimal"], 3)
            if r.under_odds_decimal is not None and p["under_odds_decimal"] is not None
            else None
        )

        if not (
            abs(ld) > 0.001
            or (od is not None and abs(od) > 0.001)
            or (ud is not None and abs(ud) > 0.001)
        ):
            continue

        result[key] = {
            "line_delta":       ld if abs(ld) > 0.001 else None,
            "over_odds_delta":  od if od is not None and abs(od) > 0.001 else None,
            "under_odds_delta": ud if ud is not None and abs(ud) > 0.001 else None,
        }
    return result


STATIC_ROOT = ROOT / "static"
HOST = "127.0.0.1"
PORT = 8000


def load_all_props():
    """
    Fetch and merge player props from all configured sources.

    Sources
    -------
    - Unabated  (WNBA only, multiple US sportsbooks)
    - Merkur Xtip (WNBA + ACB + Lega A + Izrael, single bookmaker)
    """
    # --- Unabated (primary WNBA source — multiple books) ---
    unabated_raw     = unabated_adapter.fetch_unabated_props()
    unabated_records = unabated_adapter.parse_unabated_props(unabated_raw)
    unabated_records = [
        r for r in unabated_records
        if r.market in unabated_adapter.SUPPORTED_MARKETS
    ]

    # --- Merkur Xtip (multi-league, single book) ---
    merkur_records = []
    try:
        merkur_records = merkur_adapter.load_merkur_props()
    except Exception as exc:
        print(f"[merkur] fetch failed — {exc}")

    # --- Superbet RS (multi-league, single book) ---
    superbet_records = []
    try:
        superbet_records = superbet_adapter.load_superbet_props()
    except Exception as exc:
        print(f"[superbet] fetch failed — {exc}")

    # --- Stoiximan (ACB, WNBA, Izrael — "N+" threshold bets, over only) ---
    stoiximan_records = []
    try:
        stoiximan_records = stoiximan_adapter.load_stoiximan_props()
    except Exception as exc:
        print(f"[stoiximan] fetch failed — {exc}")

    # --- MaxBet RS (WNBA, ACB — full O/U player props) ---
    maxbet_records = []
    try:
        maxbet_records = maxbet_adapter.load_maxbet_props()
    except Exception as exc:
        print(f"[maxbet] fetch failed — {exc}")

    # --- Mozzart (whichever "...Players" competitions are currently live) ---
    mozzart_records = []
    try:
        mozzart_records = mozzart_adapter.load_mozzart_props()
    except Exception as exc:
        print(f"[mozzart] fetch failed — {exc}")

    # --- AdmiralBet RS (multi-league, single book) ---
    admiralbet_records = []
    try:
        admiralbet_records = admiralbet_adapter.load_admiralbet_props()
    except Exception as exc:
        print(f"[admiralbet] fetch failed — {exc}")

    # --- BalkanBet RS (multi-league, single book) ---
    balkanbet_records = []
    try:
        balkanbet_records = balkanbet_adapter.load_balkanbet_props()
    except Exception as exc:
        print(f"[balkanbet] fetch failed — {exc}")

    all_records = (
        unabated_records + merkur_records + superbet_records
        + stoiximan_records + maxbet_records + mozzart_records
        + admiralbet_records + balkanbet_records
    )

    # Temporarily hidden markets — pull back out once ready to show them again.
    _HIDDEN_MARKETS = {"three_pointers", "tpra"}
    all_records = [r for r in all_records if r.market not in _HIDDEN_MARKETS]

    # Re-normalize player names against the current alias table so that alias
    # changes take effect immediately without flushing adapter caches.
    all_records = [replace(r, player=to_canonical_name(r.player)) for r in all_records]

    # Split canonical names shared by two different players (player_disambiguation.json),
    # using team/game. Must run before the per-(league, player) game resolution below,
    # otherwise both players get collapsed onto one game string.
    all_records = [
        replace(r, player=disambiguate_player(r.player, r.team, r.game))
        for r in all_records
    ]

    # Re-normalize league names against league_aliases.json so that the same
    # competition appears under one canonical label regardless of which source
    # named it (e.g. "Kvalifikacije SP" and "World Ch. Qual." → "FIBA Qualifiers").
    all_records = [replace(r, league=to_canonical_league(r.league)) for r in all_records]

    # Records still carrying an ambiguous name (no team/game to split on, e.g.
    # Mozzart's bare "Mitchell D.") take the one variant actually present in
    # that league today, if exactly one is.
    present = {(r.league, r.player) for r in all_records}
    def _settle_ambiguous(r):
        hits = [c for c in disambiguation_candidates(r.player) if (r.league, c) in present]
        return replace(r, player=hits[0]) if len(hits) == 1 else r
    all_records = [_settle_ambiguous(r) for r in all_records]

    # Strip gender markers (e.g. "(W)", "(M)") from all game strings so that
    # "Washington Mystics (W) @ Minnesota Lynx (W)" and
    # "Washington Mystics @ Minnesota Lynx" resolve to the same event.
    all_records = [
        replace(r, game=re.sub(r'\s*\([WM]\)', '', r.game).strip())
        for r in all_records
    ]

    # Canonicalize team names inside game strings via team_aliases.json, so
    # "Memphis @ Portland" (MaxBet) and "Memphis Grizzlies @ Portland Trail
    # Blazers" (Unabated) resolve to the same event.
    all_records = [
        replace(r, game=to_canonical_game(r.game, r.league))
        for r in all_records
    ]

    # Collapse "A @ B" / "B @ A" into one fixture. MaxBet and AdmiralBet build
    # matchups by pairing two teams on the same kickoff slot, so their
    # home/away order is arbitrary; take the order from books that report it.
    votes = {}
    for r in all_records:
        if " @ " not in r.game:
            continue
        sides = frozenset(r.game.split(" @ ", 1))
        weight = 0 if r.bookmaker in _UNORDERED_GAME_BOOKS else 1
        books = votes.setdefault((r.league, sides), {}).setdefault(r.game, [set(), 0])
        books[0].add(r.bookmaker)
        books[1] += weight
    oriented = {}
    for key, by_game in votes.items():
        if len(by_game) > 1:
            best = max(by_game, key=lambda g: (by_game[g][1] > 0, len(by_game[g][0]), by_game[g][1]))
            for g in by_game:
                oriented[(key[0], g)] = best
    if oriented:
        all_records = [
            replace(r, game=oriented[(r.league, r.game)]) if (r.league, r.game) in oriented else r
            for r in all_records
        ]

    # Normalize event names and kickoff times across all sources
    # 1. Collect full game strings that contain " @ "
    full_games = {(r.league, r.game) for r in all_records if " @ " in r.game}
    game_to_kickoff = {r.game: r.kickoff_time for r in all_records if r.kickoff_time}

    def _parse_ts(ts):
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except (AttributeError, ValueError):
            return None

    def _resolve_partial_game(r):
        """Map a single-team label (e.g. "Crvena Zvezda") to the full
        "Away @ Home" fixture in the same league that contains that team,
        preferring the one whose kickoff is closest to this record's."""
        team = re.sub(r'^(vs\.?|@)\s+', '', r.game, flags=re.I)
        if not team:
            return None
        candidates = [g for lg, g in full_games if lg == r.league and team in g]
        if len(candidates) <= 1:
            return candidates[0] if candidates else None
        own_ts = _parse_ts(r.kickoff_time)
        if own_ts is None:
            return None
        timed = []
        for g in candidates:
            ts = _parse_ts(game_to_kickoff.get(g, ""))
            if ts is not None and abs(ts - own_ts) <= 6 * 3600:
                timed.append((abs(ts - own_ts), -len(g), g))
        # Same kickoff → spelling variants of one fixture; prefer the longest,
        # matching the per-player "longest wins" rule below.
        timed.sort()
        return timed[0][2] if timed else None

    # Expand single-team labels before the per-player pass, so a player who
    # only has partial labels elsewhere (Merkur "Atlanta", BalkanBet
    # "vs Atlanta") still lends a full game to blank-labelled records (Mozzart).
    all_records = [
        replace(r, game=_resolve_partial_game(r) or r.game) if " @ " not in r.game else r
        for r in all_records
    ]

    # 2. Map (league, player) -> best game string
    player_to_game = {}
    for r in all_records:
        player_key = (r.league, r.player)
        current_best = player_to_game.get(player_key, "")
        has_at_current = " @ " in current_best
        has_at_new = " @ " in r.game
        
        if not has_at_current and has_at_new:
            player_to_game[player_key] = r.game
        elif has_at_current == has_at_new:
            if len(r.game) > len(current_best):
                player_to_game[player_key] = r.game

    # 3. Apply normalized game strings and kickoff times to records
    normalized_records = []
    for r in all_records:
        best_game = player_to_game.get((r.league, r.player))
        new_game = best_game if best_game else r.game
        new_kickoff = game_to_kickoff.get(new_game, r.kickoff_time)
        
        if new_game != r.game or new_kickoff != r.kickoff_time:
            normalized_records.append(replace(r, game=new_game, kickoff_time=new_kickoff))
        else:
            normalized_records.append(r)
            
    all_records = normalized_records

    # Drop props for games that have already tipped off.
    all_records = [r for r in all_records if _is_upcoming(r)]

    # All distinct leagues present in the merged dataset
    all_leagues = sorted({r.league for r in all_records})

    # All distinct markets across all leagues / sources
    all_markets = sorted({r.market for r in all_records})

    # --- Movement detection ---
    with _snapshot_lock:
        prev = dict(_prev_snapshot)

    movements = _compute_deltas(all_records, prev)

    with _snapshot_lock:
        _prev_snapshot.clear()
        for r in all_records:
            _prev_snapshot[_snapshot_key(r)] = {
                "line":               r.line,
                "over_odds_decimal":  r.over_odds_decimal,
                "under_odds_decimal": r.under_odds_decimal,
            }

    def _record_dict(r):
        d = asdict(r)
        mv = movements.get(_snapshot_key(r))
        d["line_delta"]       = mv["line_delta"]       if mv else None
        d["over_odds_delta"]  = mv["over_odds_delta"]  if mv else None
        d["under_odds_delta"] = mv["under_odds_delta"] if mv else None
        return d

    return {
        "phase": "Phase 2: Multi-Source, Multi-League Odds Comparison",
        "leagues": all_leagues,
        "markets": all_markets,
        "records": [_record_dict(r) for r in all_records],
        "highlights": build_highlights(all_records),
        "sources": {
            "unabated":   unabated_adapter.UNABATED_WNBA_PROPS_URL,
            "merkur":     merkur_adapter.MERKUR_SK_URL,
            "superbet":   superbet_adapter.EVENTS_BY_DATE_URL,
            "stoiximan":  stoiximan_adapter._BASE,
            "maxbet":     maxbet_adapter._BASE_URL,
            "mozzart":    mozzart_adapter._BASE_URL,
            "admiralbet": "https://srboffer.admiralbet.rs",
        },
    }


def _fetch_news_feed() -> dict:
    """Fetch the RSS JSON feed, return the parsed dict (or {} on error)."""
    req = urllib.request.Request(
        _NEWS_FEED_URL,
        headers={"User-Agent": "PlayerPropsApp/1.0"},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_news() -> dict:
    """
    Return news items annotated with recognised players.

    The feed is cached for _NEWS_TTL_SECONDS.  On the first call after a cache
    miss the feed is re-fetched; failures return the stale cache (or []).
    """
    global _news_cache, _news_cache_ts

    now = time.monotonic()

    with _news_lock:
        if _news_cache is not None and (now - _news_cache_ts) < _NEWS_TTL_SECONDS:
            return _news_cache

    try:
        raw = _fetch_news_feed()
    except Exception as exc:
        print(f"[news] feed fetch failed — {exc}")
        with _news_lock:
            return _news_cache or {"items": []}

    # Collect the canonical players that currently have active props
    with _snapshot_lock:
        known_players = [
            key.split("|")[0] for key in _prev_snapshot
        ]
    known_players = list(dict.fromkeys(known_players))  # deduplicate, keep order

    items_out = []
    for item in raw.get("items", [])[:30]:
        # Combine title + body text for better matching surface
        title = item.get("title", "")
        body  = item.get("content_text", "")
        full_text = f"{title} {body}"

        players = news_utils.extract_players_from_text(full_text, known_players)

        items_out.append({
            "id":           item.get("id", ""),
            "text":         body or title,
            "url":          item.get("url", ""),
            "image":        item.get("image"),
            "published_at": item.get("date_published", ""),
            "players":      players,
        })

    result = {"items": [i for i in items_out if i["players"]]}

    with _news_lock:
        _news_cache = result
        _news_cache_ts = time.monotonic()

    return result


class AppHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/props":
            payload = load_all_props()
            self.send_json(payload)
            return

        if parsed.path == "/api/news":
            payload = load_news()
            self.send_json(payload)
            return

        if parsed.path == "/api/mozzart-leagues":
            payload = mozzart_adapter.load_mozzart_player_prop_leagues()
            self.send_json(payload)
            return

        if parsed.path in ("", "/"):
            self.serve_file(STATIC_ROOT / "index.html")
            return

        requested = (STATIC_ROOT / parsed.path.lstrip("/")).resolve()
        if STATIC_ROOT in requested.parents and requested.is_file():
            self.serve_file(requested)
            return

        self.send_error(404, "Not found")

    def serve_file(self, path):
        content_type, _ = mimetypes.guess_type(str(path))
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload):
        data = json.dumps(payload, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        # Suppress per-request access logs in the console
        pass


def main():
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Serving Player Props App at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
