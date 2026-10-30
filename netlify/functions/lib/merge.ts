/**
 * Merge/normalize pipeline — ported from load_all_props() in server.py.
 * Movement-delta tracking (Blobs-backed) is handled separately in props.mts,
 * since it needs the Netlify Context for store access.
 */
import {
  toCanonicalName,
  toCanonicalLeague,
  toCanonicalGame,
  toCanonicalTeam,
  disambiguatePlayer,
  disambiguationCandidates,
} from "./name-utils.js";
import type { PropRecord } from "./types.js";

// Temporarily hidden markets — pull back out once ready to show them again.
const HIDDEN_MARKETS = new Set(["three_pointers", "tpra"]);

// Books whose "Away @ Home" is reconstructed by pairing teams on a kickoff
// slot, so the order is not a real home/away signal.
const UNORDERED_GAME_BOOKS = new Set(["MaxBet", "AdmiralBet"]);

function isUpcoming(r: PropRecord): boolean {
  if (!r.kickoff_time) return true;
  const kickoff = new Date(r.kickoff_time);
  if (Number.isNaN(kickoff.getTime())) return true;
  return kickoff.getTime() >= Date.now();
}

export interface MergedResult {
  records: PropRecord[];
  leagues: string[];
  markets: string[];
}

export function mergeAndNormalize(allRecordsIn: PropRecord[]): MergedResult {
  let allRecords = allRecordsIn.filter((r) => !HIDDEN_MARKETS.has(r.market));

  // Re-normalize player names against the current alias table so that alias
  // changes take effect immediately without flushing adapter caches.
  allRecords = allRecords.map((r) => ({ ...r, player: toCanonicalName(r.player) }));

  // Split canonical names shared by two different players (player-disambiguation.json),
  // using team/game. Must run before the per-(league, player) game resolution below,
  // otherwise both players get collapsed onto one game string.
  allRecords = allRecords.map((r) => ({
    ...r,
    player: disambiguatePlayer(r.player, r.team, r.game),
  }));

  // Re-normalize league names against league_aliases.json so that the same
  // competition appears under one canonical label regardless of which source
  // named it.
  allRecords = allRecords.map((r) => ({ ...r, league: toCanonicalLeague(r.league) }));

  // Records still carrying an ambiguous name (no team/game to split on, e.g.
  // Mozzart's bare "Mitchell D.") take the one variant actually present in
  // that league today, if exactly one is.
  const present = new Set(allRecords.map((r) => `${r.league}|${r.player}`));
  allRecords = allRecords.map((r) => {
    const hits = disambiguationCandidates(r.player).filter((c) => present.has(`${r.league}|${c}`));
    return hits.length === 1 ? { ...r, player: hits[0] } : r;
  });

  // Strip gender markers (e.g. "(W)", "(M)") from all game strings so that
  // W/M variants of the same fixture merge.
  allRecords = allRecords.map((r) => ({
    ...r,
    game: r.game.replace(/\s*\([WM]\)/g, "").trim(),
  }));

  // Canonicalize team names inside game strings via team-aliases.json, so
  // "Memphis @ Portland" (MaxBet) and "Memphis Grizzlies @ Portland Trail
  // Blazers" (Unabated) resolve to the same event.
  allRecords = allRecords.map((r) => ({ ...r, game: toCanonicalGame(r.game, r.league) }));

  // Collapse "A @ B" / "B @ A" into one fixture. MaxBet and AdmiralBet build
  // matchups by pairing two teams on the same kickoff slot, so their
  // home/away order is arbitrary; take the order from books that report it.
  const votes = new Map<string, Map<string, { books: Set<string>; weight: number }>>();
  for (const r of allRecords) {
    if (!r.game.includes(" @ ")) continue;
    const at = r.game.indexOf(" @ ");
    const sides = [r.game.slice(0, at), r.game.slice(at + 3)].sort().join("\u0000");
    const key = `${r.league}|${sides}`;
    if (!votes.has(key)) votes.set(key, new Map());
    const byGame = votes.get(key)!;
    if (!byGame.has(r.game)) byGame.set(r.game, { books: new Set(), weight: 0 });
    const entry = byGame.get(r.game)!;
    entry.books.add(r.bookmaker);
    if (!UNORDERED_GAME_BOOKS.has(r.bookmaker)) entry.weight++;
  }
  const oriented = new Map<string, string>();
  for (const [key, byGame] of votes) {
    if (byGame.size < 2) continue;
    const league = key.slice(0, key.indexOf("|"));
    const rank = (e: { books: Set<string>; weight: number }) => [e.weight > 0 ? 1 : 0, e.books.size, e.weight];
    let best = "";
    for (const [g, e] of byGame) {
      if (!best) { best = g; continue; }
      const a = rank(e), b = rank(byGame.get(best)!);
      if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] > b[2])))) best = g;
    }
    for (const g of byGame.keys()) oriented.set(`${league}|${g}`, best);
  }
  if (oriented.size) {
    allRecords = allRecords.map((r) => {
      const g = oriented.get(`${r.league}|${r.game}`);
      return g ? { ...r, game: g } : r;
    });
  }

  // Normalize event names and kickoff times across all sources.
  // 1. Collect full game strings that contain " @ "
  const fullGames = new Map<string, { league: string; game: string }>();
  for (const r of allRecords) {
    if (r.game.includes(" @ ")) fullGames.set(`${r.league}|${r.game}`, { league: r.league, game: r.game });
  }
  const gameToKickoff = new Map<string, string>();
  for (const r of allRecords) {
    if (r.kickoff_time) gameToKickoff.set(r.game, r.kickoff_time);
  }

  const parseTs = (ts: string | undefined): number | null => {
    if (!ts) return null;
    const t = Date.parse(ts);
    return Number.isNaN(t) ? null : t;
  };

  // Map a single-team label (e.g. "Crvena Zvezda") to the full "Away @ Home"
  // fixture in the same league that contains that team, preferring the one
  // whose kickoff is closest to this record's.
  const resolvePartialGame = (r: PropRecord): string | null => {
    // A blank label falls back to the record's own team field (MaxBet /
    // AdmiralBet players whose kickoff slot had no opponent to pair with).
    let team = r.game.replace(/^(vs\.?|@)\s+/i, "");
    if (!team && r.team) team = toCanonicalTeam(r.team, r.league);
    if (!team) return null;
    const candidates = [...fullGames.values()]
      .filter((g) => g.league === r.league && g.game.includes(team));
    if (candidates.length <= 1) return candidates[0]?.game ?? null;
    const ownTs = parseTs(r.kickoff_time);
    if (ownTs === null) return null;
    const timed: [number, string][] = [];
    for (const g of candidates) {
      const ts = parseTs(gameToKickoff.get(g.game));
      if (ts !== null && Math.abs(ts - ownTs) <= 6 * 3600 * 1000) timed.push([Math.abs(ts - ownTs), g.game]);
    }
    // Same kickoff → spelling variants of one fixture; prefer the longest,
    // matching the per-player "longest wins" rule below.
    timed.sort((a, b) => a[0] - b[0] || b[1].length - a[1].length);
    return timed.length ? timed[0][1] : null;
  };

  // Expand single-team labels before the per-player pass, so a player who
  // only has partial labels elsewhere (Merkur "Atlanta", BalkanBet
  // "vs Atlanta") still lends a full game to blank-labelled records (Mozzart).
  allRecords = allRecords.map((r) =>
    r.game.includes(" @ ") ? r : { ...r, game: resolvePartialGame(r) ?? r.game }
  );

  // 2. Map (league, player) -> best game string
  const playerToGame = new Map<string, string>();
  for (const r of allRecords) {
    const playerKey = `${r.league}|${r.player}`;
    const currentBest = playerToGame.get(playerKey) ?? "";
    const hasAtCurrent = currentBest.includes(" @ ");
    const hasAtNew = r.game.includes(" @ ");

    if (!hasAtCurrent && hasAtNew) {
      playerToGame.set(playerKey, r.game);
    } else if (hasAtCurrent === hasAtNew) {
      if (r.game.length > currentBest.length) {
        playerToGame.set(playerKey, r.game);
      }
    }
  }

  // 3. Apply normalized game strings and kickoff times to records
  allRecords = allRecords.map((r) => {
    const bestGame = playerToGame.get(`${r.league}|${r.player}`);
    const newGame = bestGame || r.game;
    const newKickoff = gameToKickoff.get(newGame) ?? r.kickoff_time;

    if (newGame !== r.game || newKickoff !== r.kickoff_time) {
      return { ...r, game: newGame, kickoff_time: newKickoff };
    }
    return r;
  });

  // Drop props for games that have already tipped off.
  allRecords = allRecords.filter(isUpcoming);

  const leagues = [...new Set(allRecords.map((r) => r.league))].sort();
  const markets = [...new Set(allRecords.map((r) => r.market))].sort();

  return { records: allRecords, leagues, markets };
}
