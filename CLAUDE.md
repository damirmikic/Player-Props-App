# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```powershell
python server.py
```

Then open `http://127.0.0.1:8000`. No setup, no install — stdlib only.

The server fetches live data on each `/api/props` request. Merkur and Superbet data are cached to disk with a 5-minute TTL (stale-while-revalidate); Unabated data is fetched fresh each time (no cache).

## Architecture

Single Python process serves both the REST API and static files.

**Backend entry point:** `server.py` — subclasses `SimpleHTTPRequestHandler`. One API route: `GET /api/props` returns a JSON array of merged prop records with highlight flags. All other routes serve files from `static/`.

**Data flow:**
1. `server.py` calls all three adapters on each request
2. Each adapter fetches/parses its source into `PropRecord` dataclasses (defined in `unabated_adapter.py`)
3. Server merges all records, normalizes game strings and kickoff times across sources (player→best game string resolution), computes highlight flags (best over/under per player×market), and returns JSON

**Adapters:**
- `unabated_adapter.py` — Unabated API (WNBA only, multi-bookmaker). American odds → decimal conversion. Filters out fantasy/DFS books.
- `merkur_adapter.py` — Merkur Xtip REST API (WNBA, ACB, Lega A, Izrael). Stale-while-revalidate cache with background refresh thread to avoid blocking on the slow endpoint.
- `superbet_adapter.py` — Superbet RS REST API (WNBA, ACB, Lega A, Izrael). Two-step fetch: event list then per-event odds. Same stale-while-revalidate cache pattern as Merkur. Prices already in decimal format. Over/under determined from Serbian field values ("Više od" / "Manje od").
- `stoiximan_adapter.py` — Stoiximan REST API (ACB, WNBA, Izrael — Lega A not available). One fetch per league×market-type: `…/{league-path}/{market_type}/?req=la,s,stnf,c,mb,mbl`. Offers "N+" threshold bets only (e.g. "21+" = score ≥ 21). Converted to line = N−0.5; `under_odds_decimal` is always `None`. Per player×market, only the single threshold whose over odds are closest to 1.95 (within the 1.70–2.20 realistic range) is kept. Same stale-while-revalidate cache pattern.

**Name normalization:** `name_utils.py` canonicalizes player names to `"Last F."` format. Three-tier lookup: `name_aliases.json` alias table → regex pattern matching → direct conversion. Add new aliases to `name_aliases.json` when names don't match across sources.

**Frontend:** `static/app.js` is a vanilla JS SPA (no framework, no build step). It fetches `/api/props` on load and renders a filterable comparison table. Filters cascade: League → Match → Player. Bookmaker checkboxes are dynamically generated from the data. Highlights (best odds) are signaled by `is_best_over` / `is_best_under` flags from the API.

## Adding a New Data Source

1. Create `<source>_adapter.py` with a `get_props()` function returning `list[PropRecord]`
2. Import and call it in `server.py` alongside the existing adapters
3. Normalize player names through `name_utils.normalize_name()` before constructing records

## Adding a New Market/Prop Type

- Unabated: add the bet type ID → market name mapping in `unabated_adapter.py`
- Merkur: add the odd ID → market name mapping in `merkur_adapter.py`
- Superbet: add the `marketId` → market name mapping in `superbet_adapter.py` (`PLAYER_PROP_MARKETS` dict; note WNBA and non-WNBA feeds use different IDs for the same market)
- Stoiximan: not applicable — Stoiximan determines market by URL path segment (`playerspoints`, `playersrebounds`, `playersassists`), not a market ID
- Frontend prettification is automatic: underscores → title case in `app.js`

## Key Data Model

`PropRecord` (frozen dataclass in `unabated_adapter.py`):

```python
league: str              # "WNBA", "ACB", "Lega A", "Izrael"
game: str                # Matchup string e.g. "Away @ Home"
team: str                # Player's team
player: str              # Canonical "Last F." format
market: str              # "points", "assists", "rebounds", "three_pointers", "tpra"
line: float
over_odds_decimal: float | None
under_odds_decimal: float | None
bookmaker: str
kickoff_time: str        # ISO timestamp of game start (used for cross-source normalization)
updated_at: str          # ISO timestamp of data fetch
```

The highlight flags (`is_best_over`, `is_best_under`) are added as plain dict keys in `server.py` before serialization — they are not on the dataclass.

## Cache Files

`merkur_cache.json`, `superbet_cache.json`, `stoiximan_cache.json`, and `unabated_*.json` files in the root are runtime artifacts — they are gitignored. Delete them to force a cold fetch.
