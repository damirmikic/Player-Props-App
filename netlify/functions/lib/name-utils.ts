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

// Matches Merkur's "Last F." or "Last Abbr." format: one or more words, space, letter(s), period
const CANONICAL_RE = /^(.+)\s+([A-Za-z]+)\.$/;

// Matches Mozzart's "F.Last" or "Abbr.Last" format: letters, period, no space, surname
const INITIAL_DOT_LAST_RE = /^([A-Za-z]+)\.([A-Za-z\-']+)$/;

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

  // 4. Already in canonical form or "Last Abbr." (e.g. "Wright McK.")
  const mCanonical = CANONICAL_RE.exec(name);
  if (mCanonical) {
    const [, last, abbr] = mCanonical;
    if (!["JR", "SR", "II", "III", "IV"].includes(abbr.toUpperCase())) {
      const initial = abbr[0].toUpperCase();
      return `${last} ${initial}.`;
    }
  }

  // 5. "F.Last" or "Abbr.Last" (Mozzart) → "Last F."
  const m = INITIAL_DOT_LAST_RE.exec(name);
  if (m) {
    const [, abbr, last] = m;
    const initial = abbr[0].toUpperCase();
    return `${last} ${initial}.`;
  }

  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1].replace(/\.+$/, "").toUpperCase();
    if (["JR", "SR", "II", "III", "IV"].includes(lastPart)) {
      const suffix = parts[parts.length - 1].replace(/\.+$/, "");
      const main = parts.slice(0, -1);
      let last = "";
      let firstInitial = "";
      if (main.length >= 2) {
        last = main[main.length - 1];
        firstInitial = main[0][0].toUpperCase();
      } else {
        if (main[0].includes(".")) {
          const [initToken, l] = main[0].split(".");
          firstInitial = initToken[0].toUpperCase();
          last = l;
        } else {
          last = main[0];
        }
      }
      if (["II", "III", "IV"].includes(lastPart) || !firstInitial) {
        return firstInitial ? `${last} ${firstInitial}.` : last;
      }
      return `${last} ${firstInitial}. ${suffix}`;
    }
  }
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
  if (LEAGUE_ALIASES[name]) {
    return LEAGUE_ALIASES[name];
  }
  const nameLower = name.toLowerCase();
  for (const [k, v] of Object.entries(LEAGUE_ALIASES)) {
    if (k.toLowerCase() === nameLower) {
      return v;
    }
  }
  return name;
}
