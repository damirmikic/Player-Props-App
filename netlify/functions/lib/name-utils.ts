/**
 * Player-name and league-name normalisation, ported from name_utils.py.
 *
 * Canonical player format: "Last F."   e.g.  "Boston A.",  "Clark C.",  "Van Lith H."
 *
 * Unlike the Python version, alias files here are bundled at deploy time
 * (imported as static JSON) rather than hot-reloaded by mtime — each
 * function invocation is a fresh process anyway, so there is no persistent
 * state to go stale. Editing name-aliases.json / league-aliases.json
 * requires a redeploy.
 */
import nameAliasesRaw from "./name-aliases.json" with { type: "json" };
import leagueAliasesRaw from "./league-aliases.json" with { type: "json" };

// Matches Merkur's "Last F." format: one or more words, space, capital letter, period
const CANONICAL_RE = /^.+\s+[A-Z]\.$/;

// Matches Mozzart's "F.Last" format: capital letter, period, no space, surname
const INITIAL_DOT_LAST_RE = /^([A-Z])\.([A-Za-z\-']+)$/;

const DIACRITICS_MAP: Record<string, string> = {
  Đ: "Dj",
  đ: "dj",
  Ć: "C",
  ć: "c",
  Č: "C",
  č: "c",
  Š: "S",
  š: "s",
  Ž: "Z",
  ž: "z",
};

function transliterateDiacritics(text: string): string {
  return text.replace(/[ĐđĆćČčŠšŽž]/g, (char) => DIACRITICS_MAP[char] ?? char);
}

const NAME_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(nameAliasesRaw as Record<string, string>).filter(
    ([k]) => !k.startsWith("_")
  )
);

const LEAGUE_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(leagueAliasesRaw as Record<string, string>).filter(
    ([k]) => !k.startsWith("_")
  )
);

/**
 * Convert any player name string to the canonical "Last F." form.
 *
 * Priority order:
 *   1. Alias table — exact string match
 *   2. Transliterate Serbian/Balkan diacritics
 *   3. Alias table check on transliterated name
 *   4. Already canonical ("Boston A." pattern) — returned unchanged
 *   5. "F.Last" (Mozzart) — converted to "Last F."
 *   6. "First [Middle...] Last" (Unabated) — converted to "Last F."
 *   7. Fallback — returned as-is
 */
const APOSTROPHE_RE = /[`'’‘´ʼʻ]/g;

export function toCanonicalName(raw: string): string {
  let name = raw.trim().replace(/\s+/g, " ").replace(APOSTROPHE_RE, "'");

  if (!name || name === "Unknown Player") {
    return name;
  }

  let alias = NAME_ALIASES[name];
  if (alias) {
    return alias;
  }

  name = transliterateDiacritics(name);

  alias = NAME_ALIASES[name];
  if (alias) {
    return alias;
  }

  if (CANONICAL_RE.test(name)) {
    return name;
  }

  const m = INITIAL_DOT_LAST_RE.exec(name);
  if (m) {
    const [, initial, last] = m;
    return `${last} ${initial}.`;
  }

  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    const firstInitial = parts[0][0].toUpperCase();
    return `${last} ${firstInitial}.`;
  }

  return name;
}

/**
 * Map a source-specific league name to its canonical display label.
 * Names not present in the alias table are returned unchanged so no data
 * is ever silently dropped.
 */
export function toCanonicalLeague(raw: string): string {
  const name = raw.trim();
  if (!name) {
    return name;
  }
  return LEAGUE_ALIASES[name] ?? name;
}
