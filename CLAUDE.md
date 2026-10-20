# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

**Local (Python):**
```powershell
python server.py
```
Then open `http://127.0.0.1:8000`. No setup, no install — stdlib only.

**Netlify Functions (TypeScript) — parallel deploy target:**
```powershell
npm install
npm run dev        # netlify dev
```
No test suite or build/lint scripts exist in either language. `npx tsc --noEmit` typechecks the TS side (no emit — Netlify bundles functions at deploy time).

The server fetches live data on each `/api/props` request. Merkur, Superbet, Stoiximan, MaxBet, AdmiralBet, and BalkanBet data are cached with a 5-minute TTL (stale-while-revalidate); Unabated and Mozzart data are fetched fresh each time (no cache).

## Two parallel backends, one contract

This repo has **two independent implementations of the same `/api/props` and `/api/mozzart-leagues` API**, kept in sync by hand:

- **Python** (`server.py` + `*_adapter.py` + `name_utils.py`) — the primary/local-dev backend. `ThreadingHTTPServer` serving both the API and `static/`.
- **TypeScript** (`netlify/functions/`) — a from-scratch port for Netlify deployment, since Netlify Functions only support TypeScript/JavaScript/Go (not Python). See `netlify/functions/props.mts` (orchestrator, mirrors `load_all_props()`) and `netlify/functions/lib/*.ts` (one file per adapter, plus `merge.ts`, `movement.ts`, `cache.ts`, `name-utils.ts`).

**When adding or changing adapter logic, market mappings, or the merge/normalization pipeline, apply the change to both the Python file and its TypeScript counterpart** — they must keep returning the same JSON shape. Key differences forced by the runtime, not by choice:
- Python's in-memory movement-delta snapshot (`_prev_snapshot` in `server.py`) → TS uses a Netlify Blobs store (`netlify/functions/lib/movement.ts`), since functions don't persist a process between invocations.
- Python's disk-file + background-thread stale-while-revalidate cache (per-adapter `_CACHE_FILE` / `threading.Thread(daemon=True)`) → TS uses Blobs + `context.waitUntil()` for the background refresh (`netlify/functions/lib/cache.ts`).
- Python's alias JSON files hot-reload by mtime (no restart needed); TS bundles the same JSON at deploy time (edits require a redeploy).

The frontend (`static/`) is shared unchanged by both backends — it only depends on the JSON contract, not which backend served it.

## Architecture (Python backend)

**Backend entry point:** `server.py` — subclasses `SimpleHTTPRequestHandler`. Routes: `GET /api/props` returns merged prop records with highlight flags and movement deltas; `GET /api/mozzart-leagues` returns the current list of live Mozzart "...Players" competitions (monitoring endpoint). All other routes serve files from `static/`.

**Data flow (`load_all_props()` in `server.py`):**
1. Calls all eight adapters, each wrapped in its own try/except so one source failing doesn't take down the response
2. Each adapter fetches/parses its source into `PropRecord` dataclasses (defined in `unabated_adapter.py`)
3. Filters out temporarily hidden markets (`_HIDDEN_MARKETS` in `load_all_props()` — currently `three_pointers` and `tpra`; remove from that set to re-enable)
4. Re-normalizes player names (`to_canonical_name`) and league names (`to_canonical_league`) across the merged set, so alias fixes apply even to already-cached records
5. Strips gender markers (`(W)`/`(M)`) from game strings so W/M variants of the same fixture merge
6. Resolves each (league, player) to a single best game string/kickoff time across sources (prefers a full "Away @ Home" string, then longest string), so partial or inconsistent game labels from weaker sources get corrected
7. Drops props for games that have already tipped off
8. Computes highlight flags (best over/under per player×market, in `highlights: {"player|market": {best_over, best_under}}`, keyed by `recordKey` = `player|market|bookmaker|line`) and movement deltas (line/odds changes since the previous request, tracked in an in-memory snapshot keyed by `player|market|bookmaker`) and returns JSON

**Adapters** (`load_<source>_props()` entry point in each):
- `unabated_adapter.py` — Unabated API (NBA + WNBA, multi-bookmaker: DraftKings, FanDuel, BetOnline, Novig). American odds → decimal conversion. Filters out fantasy/DFS books and prediction markets.
- `merkur_adapter.py` — Merkur Xtip REST API (WNBA, ACB, Lega A, Izrael). Stale-while-revalidate cache with background refresh thread to avoid blocking on the slow endpoint.
- `superbet_adapter.py` — Superbet RS REST API (NBA, WNBA, ACB, Lega A, Izrael, Euroleague, Eurocup, Champions League). Two-step fetch: event list then per-event odds. Same stale-while-revalidate cache pattern as Merkur. Prices already in decimal format. Over/under determined from Serbian field values ("Više od" / "Manje od").
- `stoiximan_adapter.py` — Stoiximan REST API (ACB, WNBA, Izrael — Lega A not available). One fetch per league×market-type: `…/{league-path}/{market_type}/?req=la,s,stnf,c,mb,mbl`. Offers "N+" threshold bets only (e.g. "21+" = score ≥ 21). Converted to line = N−0.5; `under_odds_decimal` is always `None`. Per player×market, only the single threshold whose over odds are closest to 1.95 (within the 1.70–2.20 realistic range) is kept. Same stale-while-revalidate cache pattern.
- `maxbet_adapter.py` — MaxBet RS REST API (WNBA, ACB). Single endpoint `…/sport/SK/mob`. Each entry in `esMatches` represents one *player* (not a game): `home` = player full name, `away` = player's team, `params` = `{ouPlPoints, ouPlRebounds, ouPlAssists}` lines, `odds` = `{tipTypeId: decimal}`. Tip-type IDs: 51679/51681 = points over/under, 51682/51684 = assists over/under, 51685/51687 = rebounds over/under. Game strings reconstructed by pairing the two teams sharing the same (leagueId, kickOffTime). Same stale-while-revalidate cache pattern.
- `mozzart_adapter.py` — Mozzart (mozzartbet.ng). Mozzart does not expose player props as a subgame on regular matches — instead, each tournament offering them gets its own competition with `competitionOfferType == "PLAYER"` (e.g. "Eurobasket (q) - Players"), discovered by name-matching "player" via `/getRegularGroups`. Each "match" inside such a competition is actually a single player (no opponent/team data). Fetch is three-step: `/getRegularGroups` (discover competitions) → `/betOffer2` (paginated player entities per competition) → `/getBettingOdds` (odds per matchId, chunked at 50 ids — the endpoint silently returns nothing above that). Only "points" is mapped so far (`_SUBGAME_MARKETS`); alternate lines per player×market are collapsed to the one closest to 1.95 over odds, mirroring Stoiximan's selection logic. Not cached — offer set changes rarely and volume is low. `GET /api/mozzart-leagues` exposes `load_mozzart_player_prop_leagues()` directly for monitoring which "...Players" competitions currently exist.
- `admiralbet_adapter.py` — AdmiralBet RS REST API (`srboffer.admiralbet.rs`). Basketball player props live under dedicated `sportId == 123` ("Košarka igrači"). Two-step discovery/fetch: `/api/offer/webTree/...` (discovers competition names & regions) → `/api/offer/GetWebEvents` (all events + bets + outcomes). Each event is named `"Player Name - Team Name"`. Maps betTypeOutcomeIds (5688/5689=points, 5690/5691=assists, 5692/5693=rebounds, 1082/1083=three_pointers, 5700/5701=tpra). Collapses alternate lines to the standard line closest to 1.90 over odds. Reconstructs game matchups by pairing teams with the same kickoff slot. Same stale-while-revalidate cache pattern (`admiralbet_cache.json`).
- `balkanbet_adapter.py` — BalkanBet RS NSoft API (`sports-sm-distribution-api.de-2.nsoftcdn.com`). Basketball player props live under `sportId == 273`. Two endpoints: `/tournaments` (competition names) and `/events` (events with market groups and outcomes). Each event is named `"Player Name (Team Name)"`. Maps markets (2402=points, 2403=rebounds, 2406=assists). Selects primary balanced line via `favourite: true`. Stale-while-revalidate cache pattern (`balkanbet_cache.json`).

**Name normalization:** `name_utils.py` canonicalizes player names to `"Last F."` format via `to_canonical_name()`. Lookup order: `name_aliases.json` alias table (exact match) → Serbian/Balkan diacritic transliteration (Đ→Dj, Ć/Č→C, Š→S, Ž→Z) → alias table again on the transliterated name → regex pattern matching ("F.Last" or full-name forms) → direct conversion fallback. Add new aliases to `name_aliases.json` when names don't match across sources — the file is watched by mtime and hot-reloads automatically; no server restart needed. The server also re-runs `to_canonical_name()` on every merged record at request time, so alias fixes take effect on the next API call even without clearing adapter caches. Multi-word surnames (e.g. "Van Lith", "De Larrea") require explicit alias entries since the pattern-based fallback only uses the last token.

**League normalization:** `name_utils.py` also exposes `to_canonical_league()`, backed by `league_aliases.json` (same hot-reload-by-mtime behavior as name aliases). Used to collapse differently-named competitions from different sources into one label (e.g. "Kvalifikacije SP" and "World Ch. Qual." → "FIBA Qualifiers").

## Frontend

`static/app.js` is a vanilla JS SPA (no framework, no build step) — a mobile-first tabbed app shell (Board / Watchlist / Alerts), not a desktop table. It fetches `/api/props` on load and polls every 30s.

- **Board tab:** League chips → Market chips → per-book comparison cards. A match selector (`#matchSelect`) exists to narrow the board to a single game, but is currently hidden via CSS (`display: none` on `.match-row` in `styles.css`) — the underlying filter logic (`state.matchFilter`) stays wired up; remove that one rule to re-enable it in the UI.
- **Watchlist tab:** starred player×market pairs, persisted to `localStorage`.
- **Alerts tab:** line/odds movement events, computed client-side by diffing `line_delta`/`over_odds_delta`/`under_odds_delta` across polls, filterable by a percentage-move threshold and by which bookmakers are allowed to trigger an alert (both persisted to `localStorage`); the alert log itself lives in `sessionStorage`.
- **Highlights:** best-price cells are computed by looking up `state.highlights[groupKey(record)]` (`groupKey` = `player|market`) and comparing against `recordKey(record)` (`player|market|bookmaker|line`) — the API does not put boolean flags on individual records.
- A "highlighted bookmaker" preference (`state.highlightedBook`, `localStorage` key `props_highlighted_book`, defaults to `merkurxtip`) visually pins one book's cell regardless of odds ranking.
- Player detail is a full-screen overlay (`#screen-detail`), not a separate route.

## Adding a New Data Source

1. Python: create `<source>_adapter.py` with a `load_<source>_props()` function returning `list[PropRecord]`; import and call it in `load_all_props()` in `server.py`, wrapped in its own try/except.
2. TypeScript: create `netlify/functions/lib/<source>.ts` mirroring the Python adapter's logic; wire it into `netlify/functions/props.mts` the same way (own try/catch, added to the merged records array).
3. Normalize player names through `to_canonical_name()` (`name_utils.py` / `name-utils.ts`) before constructing records, in both versions.

## Adding a New Market/Prop Type

Apply to both the Python adapter and its TypeScript counterpart:
- Unabated: bet type ID → market name mapping (`unabated_adapter.py` / `unabated.ts`)
- Merkur: odd ID → market name mapping
- Superbet: `marketId` → market name mapping (`PLAYER_PROP_MARKETS` dict; WNBA and non-WNBA feeds use different IDs for the same market)
- Stoiximan: not applicable — market is determined by URL path segment (`playerspoints`, `playersrebounds`, `playersassists`), not a market ID
- MaxBet: tip-type ID pair → `_ODDS_MAP`, param key → `_PARAM_MARKET`
- Mozzart: subgame `gameId` → `_SUBGAME_MARKETS` (the over/under request subgame ids are derived automatically from this dict)
- AdmiralBet: outcome IDs → `_OUTCOMES_MAP`
- If the new market should be hidden from the UI for now, add it to `_HIDDEN_MARKETS` in `server.py`'s `load_all_props()` (and the equivalent set in `merge.ts`)
- Frontend prettification is automatic: underscores → title case in `app.js`

## Key Data Model

`PropRecord` (frozen dataclass in `unabated_adapter.py`; mirrored as a TS interface in `netlify/functions/lib/types.ts`):

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

Movement deltas (`line_delta`, `over_odds_delta`, `under_odds_delta`) are added as plain dict keys in `server.py`/`movement.ts` before serialization — they are not on the dataclass/interface itself. Highlight flags are not per-record at all; they live in a separate top-level `highlights` map (see Frontend section above).

## Cache Files

`merkur_cache.json`, `superbet_cache.json`, `stoiximan_cache.json`, `maxbet_cache.json`, `admiralbet_cache.json`, and `unabated_*.json` files in the root are runtime artifacts for the Python backend — they are gitignored. Delete them to force a cold fetch. Mozzart is never cached to disk. The cross-request movement-detection snapshot in `server.py` lives only in memory and resets on server restart.

The TypeScript/Netlify backend uses Netlify Blobs instead (one store per cached adapter, plus a `movement-snapshot` store) — there are no local cache files to delete for that path; state persists across function invocations/deploys until explicitly cleared in Netlify.
