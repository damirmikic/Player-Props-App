# Player Props Odds Comparison App

Lightweight WNBA player props comparison app focused on decimal odds and the first three markets:

- Points
- Assists
- Rebounds

## Current Development Phase

Phase 1: Ingestion MVP.

The app is scaffolded for the simplest deployment path: one Python process serves both the API and the static frontend. No database or external package is required for the first version.

## Run Locally

```powershell
python server.py
```

Then open:

```text
http://127.0.0.1:8000
```

## What Is Implemented

- WNBA-only MVP surface
- Decimal odds display
- Points, assists, rebounds filtering
- Normalized internal prop shape
- Best over and best under highlighting
- Live Unabated WNBA prop odds from `https://content.unabated.com/markets/v2/league/7/propodds.json`

## Current Data Mapping

The live adapter currently maps Unabated WNBA full-game pregame markets:

- `bt73`: points
- `bt70`: assists
- `bt77`: rebounds

The app displays real player names, team abbreviations, sportsbook names, lines, and decimal odds from Unabated's live content snapshot.
