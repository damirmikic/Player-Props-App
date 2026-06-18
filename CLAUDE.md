# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```powershell
python server.py
```

Then open `http://127.0.0.1:8000`. No setup, no install — stdlib only.

The server fetches live data on each `/api/props` request. Merkur data is cached to disk (`merkur_cache.json`) with a 5-minute TTL; Unabated data is fetched fresh each time (no cache).

## Architecture

Single Python process serves both the REST API and static files.

**Backend entry point:** `server.py` — subclasses `SimpleHTTPRequestHandler`. One API route: `GET /api/props` returns a JSON array of merged prop records with highlight flags. All other routes serve files from `static/`.

**Data flow:**
1. `server.py` calls both adapters on each request
2. Each adapter fetches/parses its source into `PropRecord` dataclasses (defined in `unabated_adapter.py`)
3. Server merges the two lists, computes highlight flags (best over/under per player×market), and returns JSON

**Adapters:**
- `unabated_adapter.py` — Unabated API (WNBA only, multi-bookmaker). American odds → decimal conversion. Filters out fantasy/DFS books.
- `merkur_adapter.py` — Merkur Xtip REST API (WNBA, ACB, Lega A, Izrael). Stale-while-revalidate cache with background refresh thread to avoid blocking on the slow endpoint.

**Name normalization:** `name_utils.py` canonicalizes player names to `"Last F."` format. Three-tier lookup: `name_aliases.json` alias table → regex pattern matching → direct conversion. Add new aliases to `name_aliases.json` when names don't match across sources.

**Frontend:** `static/app.js` is a vanilla JS SPA (no framework, no build step). It fetches `/api/props` on load and renders a filterable comparison table. Filters cascade: League → Match → Player. Bookmaker checkboxes are dynamically generated from the data. Highlights (best odds) are signaled by `is_best_over` / `is_best_under` flags from the API.

## Adding a New Data Source

1. Create `<source>_adapter.py` with a `get_props()` function returning `list[PropRecord]`
2. Import and call it in `server.py` alongside the existing adapters
3. Normalize player names through `name_utils.normalize_name()` before constructing records

## Adding a New Market/Prop Type

- Unabated: add the bet type ID → market name mapping in `unabated_adapter.py`
- Merkur: add the odd ID → market name mapping in `merkur_adapter.py`
- Frontend prettification is automatic: underscores → title case in `app.js`

## Key Data Model

`PropRecord` (frozen dataclass in `unabated_adapter.py`):

```python
league: str              # "WNBA", "ACB", "Lega A", "Izrael"
game: str                # Matchup string
team: str                # Player's team
player: str              # Canonical "Last F." format
market: str              # "points", "assists", "rebounds", "three_pointers", "tpra"
line: float
over_odds_decimal: float | None
under_odds_decimal: float | None
bookmaker: str
updated_at: str          # ISO timestamp
```

The highlight flags (`is_best_over`, `is_best_under`) are added as plain dict keys in `server.py` before serialization — they are not on the dataclass.

## Cache Files

`merkur_cache.json` and `unabated_*.json` files in the root are runtime artifacts — they are gitignored. Delete them to force a cold fetch.
