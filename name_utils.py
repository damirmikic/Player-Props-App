"""
Shared player-name normalisation utilities.

Canonical format: "Last F."   e.g.  "Boston A.",  "Clark C.",  "Van Lith H."

Both adapters call `to_canonical_name()` so that every PropRecord ends up with
the same player key regardless of source format:

  Unabated:  "Aliyah Boston"  → "Boston A."
  Merkur:    "Boston A."      → "Boston A."  (already canonical, no change)

Edge cases that the pattern-based logic cannot handle are covered by the alias
table in name_aliases.json.  Add entries there whenever a mismatch is spotted
in the UI; the file is reloaded on every server restart.
"""

import re
import json
from pathlib import Path

_ALIAS_FILE = Path(__file__).resolve().parent / "name_aliases.json"

# Matches Merkur's "Last F." format: one or more words, space, capital letter, period
_CANONICAL_RE = re.compile(r'^.+\s+[A-Z]\.$')

_aliases: dict | None = None


def load_aliases() -> dict:
    """Read name_aliases.json from disk. Returns {} on any error."""
    global _aliases
    try:
        if _ALIAS_FILE.exists():
            _aliases = json.loads(_ALIAS_FILE.read_text(encoding="utf-8"))
        else:
            _aliases = {}
    except Exception as exc:
        print(f"[name_utils] alias load failed: {exc}")
        _aliases = {}
    return _aliases


def _get_aliases() -> dict:
    global _aliases
    if _aliases is None:
        load_aliases()
    return _aliases


def to_canonical_name(raw: str) -> str:
    """
    Convert any player name string to the canonical "Last F." form.

    Priority order
    --------------
    1. Alias table (name_aliases.json) — exact string match
    2. Already canonical ("Boston A." pattern) — returned unchanged
    3. "First [Middle...] Last" (Unabated) — converted to "Last F."
    4. Fallback — returned as-is

    Examples
    --------
    >>> to_canonical_name("Aliyah Boston")
    'Boston A.'
    >>> to_canonical_name("Boston A.")
    'Boston A.'
    >>> to_canonical_name("Haley Van Lith")
    'Lith H.'          # ← add "Haley Van Lith" → "Van Lith H." to alias file
    >>> to_canonical_name("Unknown Player")
    'Unknown Player'
    """
    name = raw.strip()

    if not name or name == "Unknown Player":
        return name

    # 1. Alias table wins
    alias = _get_aliases().get(name)
    if alias:
        return alias

    # 2. Already in canonical form
    if _CANONICAL_RE.match(name):
        return name

    # 3. Full name → "Last F."
    parts = name.split()
    if len(parts) >= 2:
        last = parts[-1]
        first_initial = parts[0][0].upper()
        return f"{last} {first_initial}."

    return name
