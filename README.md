# Player Props Odds Comparison App

A lightweight, zero-dependency Python app for comparing basketball player prop odds across multiple sportsbooks. Covers WNBA, ACB, Lega A, and Izrael leagues.

## Run Locally

```powershell
python server.py
```

Then open `http://127.0.0.1:8000`. No setup, no install — stdlib only.

## Markets

- Points
- Assists
- Rebounds
- Three-pointers
- PRA (Points + Rebounds + Assists)

## Data Sources

| Adapter | Leagues | Cache |
|---|---|---|
| [Unabated](unabated_adapter.py) | WNBA | No (live fetch) |
| [Merkur](merkur_adapter.py) | WNBA, ACB, Lega A, Izrael | 5-minute TTL |
| [Superbet](superbet_adapter.py) | WNBA, ACB, Lega A, Izrael | 5-minute TTL |
| [Stoiximan](stoiximan_adapter.py) | WNBA, ACB, Izrael | 5-minute TTL |
| [MaxBet](maxbet_adapter.py) | WNBA, ACB | 5-minute TTL |
| [Mozzart](mozzart_adapter.py) | Whichever leagues currently offer a "...Players" competition | No (live fetch) |

Cached adapters use stale-while-revalidate: they serve from disk while a background thread refreshes the data, so no request is ever blocked by a slow fetch.

## Features

- Filterable comparison table — cascade filters by League → Match → Player
- Bookmaker checkboxes dynamically generated from live data
- Best over / best under odds highlighted per player × market
- Line/odds movement since the previous poll highlighted per record
- Cross-source game and kickoff time normalization
- Player name normalization to `"Last F."` canonical format via `name_aliases.json`
- League name normalization to a canonical label via `league_aliases.json`

## Architecture

Single Python process (`server.py`) subclasses `SimpleHTTPRequestHandler`. API routes: `GET /api/props` returns a JSON array of merged prop records with highlight flags and movement deltas; `GET /api/mozzart-leagues` returns the "...Players" competitions Mozzart currently offers, for monitoring new markets. All other routes serve files from `static/`.

Frontend is a vanilla JS SPA (`static/app.js`) — no framework, no build step.

## Adding a New Data Source

1. Create `<source>_adapter.py` with a `get_props()`-style function returning `list[PropRecord]`
2. Import and call it in `load_all_props()` in `server.py` alongside the existing adapters
3. Normalize player names through `name_utils.to_canonical_name()`
