# Player Props Odds Comparison App

A lightweight, high-performance app for comparing basketball player prop odds across multiple sportsbooks. Covers **WNBA**, **Euroleague** (including Supercup), **ACB**, **BBL (Germany)**, **Lega A**, **Izrael**, **Club Friendlies**, and international tournaments.

## Run Locally

### Python Backend (Primary / Dev)
```powershell
python server.py
```
Then open `http://127.0.0.1:8000`. Zero setup, stdlib only.

### Netlify Functions (TypeScript — Serverless Deploy Target)
```powershell
npm install
npm run dev        # netlify dev
```
Typecheck TypeScript without emit:
```powershell
npx tsc --noEmit
```

## Markets

- **Points**
- **Assists**
- **Rebounds**
- **Three-pointers** (adapter-supported; temporarily hidden from UI via `_HIDDEN_MARKETS`)
- **PRA / TPRA** (Points + Rebounds + Assists; temporarily hidden)

## Data Sources

| Adapter | Leagues Covered | Cache / Fetch Strategy | Notes |
|---|---|---|---|
| [Unabated](unabated_adapter.py) / [TS](netlify/functions/lib/unabated.ts) | WNBA | Live fetch (no cache) | Multi-book US odds. Automatically filters out DFS/fantasy books and prediction markets (Underdog, PrizePicks, Sleeper, TheScore US, Kalshi, etc.). |
| [Superbet](superbet_adapter.py) / [TS](netlify/functions/lib/superbet.ts) | WNBA, ACB, Lega A, Izrael, BBL, Euroleague, Club Friendlies | 5-minute TTL (stale-while-revalidate) | Serbian market prices ("Više od" / "Manje od"). Category & tournament ID resolution. |
| [Stoiximan](stoiximan_adapter.py) / [TS](netlify/functions/lib/stoiximan.ts) | WNBA, ACB, Euroleague, BBL, Izrael, Club Friendlies | 5-minute TTL (stale-while-revalidate) | Greek bookmaker. Offers "N+" threshold bets converted to Over (line = N − 0.5) with target odds closest to 1.95. |
| [MaxBet](maxbet_adapter.py) / [TS](netlify/functions/lib/maxbet.ts) | WNBA, ACB, BBL, Euroleague, Club Friendlies | 5-minute TTL (stale-while-revalidate) | Serbian bookmaker. Reconstructs game matchups by matching kickoff time slots. |
| [AdmiralBet](admiralbet_adapter.py) / [TS](netlify/functions/lib/admiralbet.ts) | WNBA, Euroleague, Prijateljske / Friendlies | 5-minute TTL (stale-while-revalidate) | Dedicated `sportId == 123` ("Košarka igrači"). Matches standard lines closest to 1.90. |
| [BalkanBet](balkanbet_adapter.py) / [TS](netlify/functions/lib/balkanbet.ts) | WNBA, Euroleague, BBL, Club Friendlies | 5-minute TTL (stale-while-revalidate) | NSoft sports distribution API (`sportId == 273`). Standard lines matched via `favourite: true`. |
| [Merkur](merkur_adapter.py) / [TS](netlify/functions/lib/merkur.ts) | WNBA, ACB, Lega A, Izrael, BBL, Euroleague | 5-minute TTL (stale-while-revalidate) | Merkur Xtip REST API. Strips Serbian "Igrači" suffixes automatically. |
| [Mozzart](mozzart_adapter.py) / [TS](netlify/functions/lib/mozzart.ts) | Active "...Players" competitions | Live fetch (no cache) | Three-step discovery via Mozzart API. Monitoring endpoint exposed at `GET /api/mozzart-leagues`. |

Cached adapters use **stale-while-revalidate**:
- In Python: Serves cached data from disk while a background thread refreshes the cache.
- In TypeScript / Netlify: Serves cached data from Netlify Blobs while `context.waitUntil()` executes the background refresh.

## Key Features

- **Multi-book comparison cards**: Side-by-side odds across books for the same player, market, and line.
- **Consensus line calculation**: Determines the most common line across active sportsbooks.
- **Best-price highlighting**: Automatically flags best Over and best Under odds per player × market.
- **Movement detection & tracking**: Real-time line and odds delta tracking (`line_delta`, `over_odds_delta`, `under_odds_delta`) across polls.
- **Player name canonicalization** (`name_utils.py` / `name-utils.ts`):
  - Normalizes player names to standard `"Last F."` format (e.g. `"Baldwin W."`, `"Vezenkov S."`).
  - Correctly handles generational suffixes (`Jr.`, `Sr.`, `II`, `III`, `IV`) without mistaking the suffix for a surname.
  - Automatically transliterates Balkan/Serbian diacritics (`Đ` → `Dj`, `Ć`/`Č` → `C`, `Š` → `S`, `Ž` → `Z`).
  - Hot-reloaded alias dictionary via [`name_aliases.json`](name_aliases.json).
- **League normalization** (`league_aliases.json` / `league-aliases.json`):
  - Collapses bookmaker-specific variations into unified canonical league tabs (e.g. `"Nemacka 1"`, `"GERMANY"`, `"Cat 157"` → `"BBL"`; `"EuroLeague Super Cup"` → `"Euroleague Supercup"`).
  - Case-insensitive fallback ensures consistent categorization regardless of casing differences.
- **Cross-source fixture alignment**: Normalizes "Away @ Home" matchups and kickoff timestamps across European (Home vs Away) and US bookmaker conventions.
- **Mobile-first UI**: Tabbed interface with **Board**, **Watchlist** (starred props), and **Alerts** (line movement notifications).

## Architecture

```
├── server.py                        # Python backend (ThreadingHTTPServer, local dev)
├── unabated_adapter.py              # Unabated API adapter (PropRecord model definition)
├── superbet_adapter.py              # Superbet RS adapter
├── stoiximan_adapter.py             # Stoiximan REST adapter
├── maxbet_adapter.py                # MaxBet RS adapter
├── admiralbet_adapter.py            # AdmiralBet RS adapter
├── merkur_adapter.py                # Merkur Xtip adapter
├── mozzart_adapter.py               # Mozzart adapter
├── name_utils.py                    # Player & league canonicalization utilities
├── name_aliases.json                # Custom player name alias mappings
├── league_aliases.json              # Custom league name alias mappings
├── static/                          # Vanilla JS Single Page Application
│   ├── index.html                   # HTML shell
│   ├── app.js                       # Frontend SPA logic (Board, Watchlist, Alerts)
│   └── styles.css                   # Custom CSS styling
└── netlify/functions/               # Serverless TypeScript backend (Netlify deploy target)
    ├── props.mts                    # /api/props orchestrator function
    ├── mozzart-leagues.mts          # /api/mozzart-leagues monitoring function
    └── lib/                         # TS ports of all adapters, merge, cache & utilities
```

## Adding a New Data Source

1. **Python**: Create `<source>_adapter.py` with `load_<source>_props() -> list[PropRecord]`; register it in `load_all_props()` in [`server.py`](server.py).
2. **TypeScript**: Create `netlify/functions/lib/<source>.ts` mirroring the Python logic; register it in [`netlify/functions/props.mts`](netlify/functions/props.mts).
3. Normalize all player names through `to_canonical_name()` and leagues through `to_canonical_league()`.
