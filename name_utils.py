"""
Shared player-name and league-name normalisation utilities.

Canonical player format: "Last F."   e.g.  "Boston A.",  "Clark C.",  "Van Lith H."

Both adapters call `to_canonical_name()` so that every PropRecord ends up with
the same player key regardless of source format:

  Unabated:  "Aliyah Boston"  → "Boston A."
  Merkur:    "Boston A."      → "Boston A."  (already canonical, no change)

Edge cases for player names that the pattern-based logic cannot handle are
covered by the alias table in name_aliases.json.

League names vary across sources (e.g. Merkur calls it "Kvalifikacije SP"
while MaxBet calls the same competition "World Ch. Qual."). Map them to a
single canonical label via league_aliases.json.  Both files are reloaded on
every API request — no server restart required.
"""
from __future__ import annotations

import re
import json
from pathlib import Path

_ALIAS_FILE        = Path(__file__).resolve().parent / "name_aliases.json"
_LEAGUE_ALIAS_FILE = Path(__file__).resolve().parent / "league_aliases.json"

# Matches Merkur's "Last F." format: one or more words, space, capital letter, period
_CANONICAL_RE = re.compile(r'^.+\s+[A-Z]\.$')

# Matches Mozzart's "F.Last" or "Abbr.Last" format: letters, period, no space, surname
_INITIAL_DOT_LAST_RE = re.compile(r'^([A-Za-z]+)\.([A-Za-z\-\']+)$')

_DIACRITICS_TABLE = {
    'Đ': 'Dj', 'đ': 'dj',
    'Ć': 'C', 'ć': 'c',
    'Č': 'C', 'č': 'c',
    'Š': 'S', 'š': 's',
    'Ž': 'Z', 'ž': 'z',
}


def _transliterate_diacritics(text: str) -> str:
    for k, v in _DIACRITICS_TABLE.items():
        text = text.replace(k, v)
    return text

_aliases: dict | None = None
_alias_mtime: float = 0.0

_league_aliases: dict | None = None
_league_alias_mtime: float = 0.0


def load_aliases() -> dict:
    """Read name_aliases.json from disk. Returns {} on any error."""
    global _aliases, _alias_mtime
    try:
        if _ALIAS_FILE.exists():
            _aliases = json.loads(_ALIAS_FILE.read_text(encoding="utf-8"))
            _alias_mtime = _ALIAS_FILE.stat().st_mtime
        else:
            _aliases = {}
    except Exception as exc:
        print(f"[name_utils] alias load failed: {exc}")
        _aliases = {}
    return _aliases


def _get_aliases() -> dict:
    global _aliases, _alias_mtime
    try:
        mtime = _ALIAS_FILE.stat().st_mtime
        if _aliases is None or mtime != _alias_mtime:
            load_aliases()
    except Exception:
        if _aliases is None:
            _aliases = {}
    return _aliases


def _get_league_aliases() -> dict:
    """Return the league alias table, reloading from disk if league_aliases.json changed."""
    global _league_aliases, _league_alias_mtime
    try:
        mtime = _LEAGUE_ALIAS_FILE.stat().st_mtime
        if _league_aliases is None or mtime != _league_alias_mtime:
            data = json.loads(_LEAGUE_ALIAS_FILE.read_text(encoding="utf-8"))
            # Strip comment keys so the JSON can carry _comment fields
            _league_aliases = {k: v for k, v in data.items() if not k.startswith("_")}
            _league_alias_mtime = mtime
    except Exception:
        if _league_aliases is None:
            _league_aliases = {}
    return _league_aliases


_APOSTROPHE_RE = re.compile(r"[`'’‘´ʼʻ]")


def to_canonical_name(raw: str) -> str:
    """
    Convert any player name string to the canonical "Last F." form.

    Priority order
    --------------
    1. Alias table (name_aliases.json) — exact string match
    2. Transliterate Serbian/Balkan diacritics (e.g. Jokić -> Jokic, Đurišić -> Djurisic)
    3. Alias table check on transliterated name
    4. Already canonical ("Boston A." pattern) — returned unchanged
    5. "F.Last" (Mozzart) — converted to "Last F."
    6. "First [Middle...] Last" (Unabated) — converted to "Last F."
    7. Fallback — returned as-is
    """
    name = _APOSTROPHE_RE.sub("'", re.sub(r"\s+", " ", raw.strip()))

    if not name or name == "Unknown Player":
        return name

    # 1. Alias table wins
    alias = _get_aliases().get(name)
    if alias:
        return alias

    # 2. Transliterate Serbian/Balkan diacritics
    name = _transliterate_diacritics(name)

    # 3. Check alias table on transliterated name
    alias = _get_aliases().get(name)
    if alias:
        return alias

    # 4. Already in canonical form
    if _CANONICAL_RE.match(name):
        return name

    # 5. "F.Last" or "Abbr.Last" (Mozzart) → "Last F."
    m = _INITIAL_DOT_LAST_RE.match(name)
    if m:
        abbr, last = m.groups()
        initial = abbr[0].upper()
        return f"{last} {initial}."

    # 6. Full name → "Last F." (handling suffixes like Jr, Sr, II, III, IV)
    parts = name.split()
    if len(parts) >= 3 and parts[-1].rstrip(".").upper() in ("JR", "SR", "II", "III", "IV"):
        last = parts[-2]
        first_initial = parts[0][0].upper()
        suffix = parts[-1].rstrip(".")
        return f"{last} {first_initial}. {suffix}"
    elif len(parts) >= 2:
        last = parts[-1]
        first_initial = parts[0][0].upper()
        return f"{last} {first_initial}."

    return name


def to_canonical_league(raw: str) -> str:
    """
    Map a source-specific league name to its canonical display label.

    Reads league_aliases.json (hot-reloaded on every change, no restart needed).
    If the name is not in the alias table it is returned unchanged so no data
    is ever silently dropped.

    Examples
    --------
    >>> to_canonical_league("Kvalifikacije SP")
    'FIBA Qualifiers'
    >>> to_canonical_league("World Ch. Qual.")
    'FIBA Qualifiers'
    >>> to_canonical_league("WNBA")
    'WNBA'
    """
    name = raw.strip()
    if not name:
        return name
    aliases = _get_league_aliases()
    if name in aliases:
        return aliases[name]
    name_lower = name.lower()
    for k, v in aliases.items():
        if k.lower() == name_lower:
            return v
    return name
