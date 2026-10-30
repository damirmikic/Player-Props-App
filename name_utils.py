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
_TEAM_ALIAS_FILE   = Path(__file__).resolve().parent / "team_aliases.json"

# Matches Merkur's "Last F." or "Last Abbr." format: one or more words, space, letter(s), period
_CANONICAL_RE = re.compile(r'^(.+)\s+([A-Za-z]+)\.$')

# Matches Mozzart's "F.Last" or "Abbr.Last" format: letters, period, no space, surname
# (multiple initials allowed, e.g. "C.J.McCollum")
_INITIAL_DOT_LAST_RE = re.compile(r'^((?:[A-Za-z]+\.)+)([A-Za-z\-\']+)$')

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

_team_aliases: dict | None = None
_team_alias_mtime: float = 0.0


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


def _get_team_aliases() -> dict:
    """Return {league: {lowercased raw name: canonical}}, reloading if team_aliases.json changed."""
    global _team_aliases, _team_alias_mtime
    try:
        mtime = _TEAM_ALIAS_FILE.stat().st_mtime
        if _team_aliases is None or mtime != _team_alias_mtime:
            data = json.loads(_TEAM_ALIAS_FILE.read_text(encoding="utf-8"))
            _team_aliases = {
                league: {k.lower(): v for k, v in table.items()}
                for league, table in data.items()
                if not league.startswith("_") and isinstance(table, dict)
            }
            _team_alias_mtime = mtime
    except Exception:
        if _team_aliases is None:
            _team_aliases = {}
    return _team_aliases


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

    # 4. Already in canonical form or "Last Abbr." (e.g. "Wright McK.")
    m = _CANONICAL_RE.match(name)
    if m:
        last, abbr = m.groups()
        if abbr.upper() not in ("JR", "SR", "II", "III", "IV"):
            initial = abbr[0].upper()
            return f"{last} {initial}."

    # 5. "F.Last" or "Abbr.Last" (Mozzart) → "Last F."
    m = _INITIAL_DOT_LAST_RE.match(name)
    if m:
        abbr, last = m.groups()
        initial = abbr[0].upper()
        return f"{last} {initial}."

    # 6. Full name → "Last F." (handling suffixes like Jr, Sr, II, III, IV)
    parts = name.split()
    if len(parts) >= 2 and parts[-1].rstrip(".").upper() in ("JR", "SR", "II", "III", "IV"):
        suffix = parts[-1].rstrip(".").upper()
        main = parts[:-1]
        # Already "Last F." with a trailing suffix (MaxBet/AdmiralBet "Acuff D. JR"):
        # drop the suffix to match Unabated's suffix-less "Acuff D.".
        if len(main) == 2 and re.fullmatch(r"[A-Za-z]+\.", main[1]):
            return f"{main[0]} {main[1][0].upper()}."
        if len(main) >= 2:
            last = main[-1]
            first_initial = main[0][0].upper()
        else:
            if "." in main[0]:
                init_token, last = main[0].split(".", 1)
                first_initial = init_token[0].upper()
            else:
                last = main[0]
                first_initial = ""
        if suffix in ("II", "III", "IV") or not first_initial:
            return f"{last} {first_initial}." if first_initial else last
        return f"{last} {first_initial}. {suffix}"
    elif len(parts) >= 2:
        last = parts[-1]
        first_initial = parts[0][0].upper()
        return f"{last} {first_initial}."

    return name


_DISAMBIG_FILE = Path(__file__).resolve().parent / "player_disambiguation.json"
_disambig: dict | None = None
_disambig_mtime: float = 0.0


def _get_disambiguation() -> dict:
    """Return the disambiguation table, reloading if player_disambiguation.json changed."""
    global _disambig, _disambig_mtime
    try:
        mtime = _DISAMBIG_FILE.stat().st_mtime
        if _disambig is None or mtime != _disambig_mtime:
            data = json.loads(_DISAMBIG_FILE.read_text(encoding="utf-8"))
            _disambig = {k: v for k, v in data.items() if not k.startswith("_")}
            _disambig_mtime = mtime
    except Exception:
        if _disambig is None:
            _disambig = {}
    return _disambig


def disambiguation_candidates(player: str) -> list[str]:
    """Names an ambiguous canonical name can split into ([] if not ambiguous)."""
    return [rule["name"] for rule in _get_disambiguation().get(player) or [] if rule.get("name")]


def disambiguate_player(player: str, team: str, game: str) -> str:
    """
    Split a canonical name shared by two different players (e.g. Keyonte and
    Kyshawn George are both "George K.") using the record's team or game.

    The team field is checked first. The game string names both sides, so a
    game match only counts when exactly one rule matches it — otherwise the
    two players' teams are facing each other and the name is left unchanged.
    """
    rules = _get_disambiguation().get(player)
    if not rules:
        return player

    def matches(rule: dict, text: str) -> bool:
        text = text.lower()
        return any(term.lower() in text for term in rule.get("match", []))

    if team:
        for rule in rules:
            if matches(rule, team):
                return rule["name"]
    if game:
        hits = [rule for rule in rules if matches(rule, game)]
        if len(hits) == 1:
            return hits[0]["name"]
    return player


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

    # Fallback: if competition name ends with " - Players", " Players", " - Igrači", etc.
    base_match = re.sub(r'(?i)\s*(?:[-–—]\s*)?(?:players|igrači|igraci)$', '', name).strip()
    if base_match and base_match != name:
        if base_match in aliases:
            return aliases[base_match]
        base_lower = base_match.lower()
        for k, v in aliases.items():
            if k.lower() == base_lower:
                return v
        for v in aliases.values():
            if v.lower() == base_lower:
                return v

    return name


def to_canonical_team(raw: str, league: str) -> str:
    """
    Map a source-specific team name to its canonical form for `league`
    (a canonical league label), via team_aliases.json (hot-reloaded).

    A trailing " W" / " M" gender marker is stripped first. Unknown names are
    returned (marker-stripped) unchanged.

    >>> to_canonical_team("Maccabi T.A.", "Euroleague")
    'Maccabi Tel Aviv'
    >>> to_canonical_team("Atlanta W", "WNBA")
    'Atlanta Dream'
    """
    name = re.sub(r'\s+[WM]$', '', raw.strip())
    if not name:
        return name
    aliases = _get_team_aliases()
    key = name.lower()
    for table in (aliases.get(league, {}), aliases.get("*", {})):
        if key in table:
            return table[key]
    return name


def to_canonical_game(game: str, league: str) -> str:
    """
    Canonicalize each team in a game label: "Away @ Home" (both sides), or a
    single-team label with an optional "vs " / "@ " prefix (prefix kept).

    >>> to_canonical_game("Memphis @ Portland", "NBA")
    'Memphis Grizzlies @ Portland Trail Blazers'
    >>> to_canonical_game("vs Bayern", "Euroleague")
    'vs Bayern Munich'
    """
    if not game:
        return game
    if " @ " in game:
        return " @ ".join(to_canonical_team(side, league) for side in game.split(" @ ", 1))
    m = re.match(r'(?i)^((?:vs\.?|@)\s+)(.*)$', game)
    if m:
        return m.group(1) + to_canonical_team(m.group(2), league)
    return to_canonical_team(game, league)
