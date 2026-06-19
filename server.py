from dataclasses import asdict, replace
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import urllib.parse

import unabated_adapter
import merkur_adapter
import superbet_adapter
from unabated_adapter import build_highlights


ROOT = Path(__file__).resolve().parent
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

    all_records = unabated_records + merkur_records + superbet_records

    # Normalize event names and kickoff times across all sources
    # 1. Collect full game strings that contain " @ "
    full_games = {r.game for r in all_records if " @ " in r.game}
    game_to_kickoff = {r.game: r.kickoff_time for r in all_records if r.kickoff_time}

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
        
        # If best_game has no " @ ", maybe it's a partial string.
        # Try substring resolution against full_games.
        if not best_game or " @ " not in best_game:
            matches = [g for g in full_games if r.game in g]
            if len(matches) == 1:
                best_game = matches[0]
            else:
                best_game = r.game
        
        new_game = best_game if best_game else r.game
        new_kickoff = game_to_kickoff.get(new_game, r.kickoff_time)
        
        if new_game != r.game or new_kickoff != r.kickoff_time:
            normalized_records.append(replace(r, game=new_game, kickoff_time=new_kickoff))
        else:
            normalized_records.append(r)
            
    all_records = normalized_records

    # All distinct leagues present in the merged dataset
    all_leagues = sorted({r.league for r in all_records})

    # All distinct markets across all leagues / sources
    all_markets = sorted({r.market for r in all_records})

    return {
        "phase": "Phase 2: Multi-Source, Multi-League Odds Comparison",
        "leagues": all_leagues,
        "markets": all_markets,
        "records": [asdict(r) for r in all_records],
        "highlights": build_highlights(all_records),
        "sources": {
            "unabated": unabated_adapter.UNABATED_WNBA_PROPS_URL,
            "merkur":   merkur_adapter.MERKUR_SK_URL,
            "superbet": superbet_adapter.EVENTS_BY_DATE_URL,
        },
    }


class AppHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/props":
            payload = load_all_props()
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
