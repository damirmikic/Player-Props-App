from dataclasses import asdict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
import mimetypes
import urllib.parse

import unabated_adapter
import merkur_adapter
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

    all_records = unabated_records + merkur_records

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
