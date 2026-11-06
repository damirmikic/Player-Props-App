"""Opening / closing line history, stored in SQLite.

One row per (league, player, market, bookmaker, kickoff date). Every sighting
upserts the row: the first sighting fixes ``open_*``, every later sighting
overwrites ``close_*``. Games that have tipped off are dropped from the merged
feed before recording, so ``close_*`` freezes at the last sighting before
kickoff -- its quality depends on how often the collector polls.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import os
import sqlite3
import threading

DB_PATH = Path(os.environ.get("LINE_HISTORY_DB", Path(__file__).with_name("line_history.db")))
_init_lock = threading.Lock()
_initialised = False

_SCHEMA = """
CREATE TABLE IF NOT EXISTS prop_lines (
    league TEXT NOT NULL,
    player TEXT NOT NULL,
    market TEXT NOT NULL,
    bookmaker TEXT NOT NULL,
    game_date TEXT NOT NULL,
    game TEXT,
    team TEXT,
    kickoff_time TEXT,
    open_ts TEXT NOT NULL,
    open_line REAL,
    open_over REAL,
    open_under REAL,
    close_ts TEXT NOT NULL,
    close_line REAL,
    close_over REAL,
    close_under REAL,
    n_obs INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (league, player, market, bookmaker, game_date)
);
CREATE INDEX IF NOT EXISTS idx_prop_lines_kickoff ON prop_lines (kickoff_time);
"""

_UPSERT = """
INSERT INTO prop_lines (
    league, player, market, bookmaker, game_date, game, team, kickoff_time,
    open_ts, open_line, open_over, open_under,
    close_ts, close_line, close_over, close_under
) VALUES (?,?,?,?,?,?,?,?, ?,?,?,?, ?,?,?,?)
ON CONFLICT (league, player, market, bookmaker, game_date) DO UPDATE SET
    game = excluded.game,
    team = excluded.team,
    kickoff_time = excluded.kickoff_time,
    close_ts = excluded.close_ts,
    close_line = excluded.close_line,
    close_over = excluded.close_over,
    close_under = excluded.close_under,
    n_obs = n_obs + 1
"""


def _connect() -> sqlite3.Connection:
    global _initialised
    conn = sqlite3.connect(DB_PATH, timeout=30)
    if not _initialised:
        with _init_lock:
            if not _initialised:
                conn.execute("PRAGMA journal_mode=WAL")
                conn.executescript(_SCHEMA)
                _initialised = True
    return conn


def record_snapshot(records) -> int:
    """Upsert one sighting per record. Returns the number of rows written.

    Records without a kickoff time are skipped: without it there is no
    well-defined "closing" moment.
    """
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for r in records:
        if not r.kickoff_time:
            continue
        rows.append((
            r.league, r.player, r.market, r.bookmaker, r.kickoff_time[:10],
            r.game, r.team, r.kickoff_time,
            now, r.line, r.over_odds_decimal, r.under_odds_decimal,
            now, r.line, r.over_odds_decimal, r.under_odds_decimal,
        ))
    if not rows:
        return 0
    conn = _connect()
    try:
        with conn:
            conn.executemany(_UPSERT, rows)
    finally:
        conn.close()
    return len(rows)


def _diff(a, b):
    return None if a is None or b is None else round(a - b, 4)


def query_history(league=None, player=None, market=None, limit=500) -> list[dict]:
    where, args = [], []
    for col, val in (("league", league), ("player", player), ("market", market)):
        if val:
            where.append(f"{col} = ?")
            args.append(val)
    sql = "SELECT * FROM prop_lines"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY kickoff_time DESC LIMIT ?"
    args.append(max(1, min(limit, 5000)))
    conn = _connect()
    try:
        conn.row_factory = sqlite3.Row
        out = []
        for row in conn.execute(sql, args):
            d = dict(row)
            d["line_move"] = _diff(d["close_line"], d["open_line"])
            d["over_move"] = _diff(d["close_over"], d["open_over"])
            d["under_move"] = _diff(d["close_under"], d["open_under"])
            out.append(d)
        return out
    finally:
        conn.close()
