# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```powershell
python server.py
```

Then open `http://127.0.0.1:8000`. No setup, no install — stdlib only.

The server fetches live data on each `/api/props` request. Merkur, Superbet, Stoiximan, and MaxBet data are cached to disk with a 5-minute TTL (stale-while-revalidate); Unabated and Mozzart data are fetched fresh each time (no cache).

## Architecture

Single Python process serves both the REST API and static files.

**Backend entry point:** `server.py` — subclasses `SimpleHTTPRequestHandler`. Routes: `GET /api/props` returns a JSON array of merged prop records with highlight flags and movement deltas; `GET /api/mozzart-leagues` returns the current list of live Mozzart "...Players" competitions (monitoring endpoint). All other routes serve files from `static/`.

**Data flow (`load_all_props()` in `server.py`):**
1. Calls all six adapters, each wrapped in its own try/except so one source failing doesn't take down the response
2. Each adapter fetches/parses its source into `PropRecord` dataclasses (defined in `unabated_adapter.py`)
3. Re-normalizes player names (`to_canonical_name`) and league names (`to_canonical_league`) across the merged set, so alias fixes apply even to already-cached records
4. Strips gender markers (`(W)`/`(M)`) from game strings so W/M variants of the same fixture merge
5. Resolves each (league, player) to a single best game string/kickoff time across sources (prefers a full "Away @ Home" string, then longest string), so partial or inconsistent game labels from weaker sources get corrected
6. Computes highlight flags (best over/under per player×market) and movement deltas (line/odds changes since the previous request, tracked in an in-memory snapshot keyed by `player|market|bookmaker`) and returns JSON

**Adapters:**
- `unabated_adapter.py` — Unabated API (WNBA only, multi-bookmaker). American odds → decimal conversion. Filters out fantasy/DFS books.
- `merkur_adapter.py` — Merkur Xtip REST API (WNBA, ACB, Lega A, Izrael). Stale-while-revalidate cache with background refresh thread to avoid blocking on the slow endpoint.
- `superbet_adapter.py` — Superbet RS REST API (WNBA, ACB, Lega A, Izrael). Two-step fetch: event list then per-event odds. Same stale-while-revalidate cache pattern as Merkur. Prices already in decimal format. Over/under determined from Serbian field values ("Više od" / "Manje od").
- `stoiximan_adapter.py` — Stoiximan REST API (ACB, WNBA, Izrael — Lega A not available). One fetch per league×market-type: `…/{league-path}/{market_type}/?req=la,s,stnf,c,mb,mbl`. Offers "N+" threshold bets only (e.g. "21+" = score ≥ 21). Converted to line = N−0.5; `under_odds_decimal` is always `None`. Per player×market, only the single threshold whose over odds are closest to 1.95 (within the 1.70–2.20 realistic range) is kept. Same stale-while-revalidate cache pattern.
- `maxbet_adapter.py` — MaxBet RS REST API (WNBA, ACB). Single endpoint `…/sport/SK/mob`. Each entry in `esMatches` represents one *player* (not a game): `home` = player full name, `away` = player's team, `params` = `{ouPlPoints, ouPlRebounds, ouPlAssists}` lines, `odds` = `{tipTypeId: decimal}`. Tip-type IDs: 51679/51681 = points over/under, 51682/51684 = assists over/under, 51685/51687 = rebounds over/under. Game strings reconstructed by pairing the two teams sharing the same (leagueId, kickOffTime). Leagues filtered by ID: 204566 = WNBA, 203039 = ACB. Same stale-while-revalidate cache pattern.
- `mozzart_adapter.py` — Mozzart (mozzartbet.ng). Mozzart does not expose player props as a subgame on regular matches — instead, each tournament offering them gets its own competition with `competitionOfferType == "PLAYER"` (e.g. "Eurobasket (q) - Players"), discovered by name-matching "player" via `/getRegularGroups`. Each "match" inside such a competition is actually a single player (no opponent/team data). Fetch is three-step: `/getRegularGroups` (discover competitions) → `/betOffer2` (paginated player entities per competition) → `/getBettingOdds` (odds per matchId, chunked at 50 ids — the endpoint silently returns nothing above that). Only "points" is mapped so far (`_SUBGAME_MARKETS`); alternate lines per player×market are collapsed to the one closest to 1.95 over odds, mirroring Stoiximan's selection logic. Not cached — offer set changes rarely and volume is low. `GET /api/mozzart-leagues` exposes `load_mozzart_player_prop_leagues()` directly for monitoring which "...Players" competitions currently exist.

**Name normalization:** `name_utils.py` canonicalizes player names to `"Last F."` format via `to_canonical_name()`. Three-tier lookup: `name_aliases.json` alias table → regex pattern matching → direct conversion. Add new aliases to `name_aliases.json` when names don't match across sources — the file is watched by mtime and hot-reloads automatically; no server restart needed. The server also re-runs `to_canonical_name()` on every merged record at request time, so alias fixes take effect on the next API call even without clearing adapter caches. Multi-word surnames (e.g. "Van Lith", "De Larrea") require explicit alias entries since the pattern-based fallback only uses the last token.

**League normalization:** `name_utils.py` also exposes `to_canonical_league()`, backed by `league_aliases.json` (same hot-reload-by-mtime behavior as name aliases). Used to collapse differently-named competitions from different sources into one label (e.g. "Kvalifikacije SP" and "World Ch. Qual." → "FIBA Qualifiers").

**Frontend:** `static/app.js` is a vanilla JS SPA (no framework, no build step). It fetches `/api/props` on load and renders a filterable comparison table. Filters cascade: League → Match → Player. Bookmaker checkboxes are dynamically generated from the data. Highlights (best odds) are signaled by `is_best_over` / `is_best_under` flags from the API; line/odds movement since the previous poll is signaled by `line_delta` / `over_odds_delta` / `under_odds_delta`.

## Adding a New Data Source

1. Create `<source>_adapter.py` with a `get_props()`-style function returning `list[PropRecord]`
2. Import and call it in `load_all_props()` in `server.py` alongside the existing adapters, wrapped in its own try/except so a fetch failure degrades gracefully instead of breaking the whole response
3. Normalize player names through `name_utils.to_canonical_name()` before constructing records

## Adding a New Market/Prop Type

- Unabated: add the bet type ID → market name mapping in `unabated_adapter.py`
- Merkur: add the odd ID → market name mapping in `merkur_adapter.py`
- Superbet: add the `marketId` → market name mapping in `superbet_adapter.py` (`PLAYER_PROP_MARKETS` dict; note WNBA and non-WNBA feeds use different IDs for the same market)
- Stoiximan: not applicable — Stoiximan determines market by URL path segment (`playerspoints`, `playersrebounds`, `playersassists`), not a market ID
- MaxBet: add the tip-type ID pair to `_ODDS_MAP` and the param key to `_PARAM_MARKET` in `maxbet_adapter.py`
- Mozzart: add the subgame `gameId` → market name mapping to `_SUBGAME_MARKETS` in `mozzart_adapter.py` (the over/under request subgame ids are derived automatically from this dict)
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

The highlight flags (`is_best_over`, `is_best_under`) and movement deltas (`line_delta`, `over_odds_delta`, `under_odds_delta`) are added as plain dict keys in `server.py` before serialization — they are not on the dataclass.

## Cache Files

`merkur_cache.json`, `superbet_cache.json`, `stoiximan_cache.json`, `maxbet_cache.json`, and `unabated_*.json` files in the root are runtime artifacts — they are gitignored. Delete them to force a cold fetch. Mozzart is never cached to disk. The cross-request movement-detection snapshot in `server.py` lives only in memory and resets on server restart.
