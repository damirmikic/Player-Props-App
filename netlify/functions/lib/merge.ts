/**
 * Merge/normalize pipeline — ported from load_all_props() in server.py.
 * Movement-delta tracking (Blobs-backed) is handled separately in props.mts,
 * since it needs the Netlify Context for store access.
 */
import { toCanonicalName, toCanonicalLeague, disambiguatePlayer } from "./name-utils.js";
import type { PropRecord } from "./types.js";

// Temporarily hidden markets — pull back out once ready to show them again.
const HIDDEN_MARKETS = new Set(["three_pointers", "tpra"]);

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

  // Strip gender markers (e.g. "(W)", "(M)") from all game strings so that
  // W/M variants of the same fixture merge.
  allRecords = allRecords.map((r) => ({
    ...r,
    game: r.game.replace(/\s*\([WM]\)/g, "").trim(),
  }));

  // Normalize event names and kickoff times across all sources.
  // 1. Collect full game strings that contain " @ "
  const fullGames = new Set(allRecords.filter((r) => r.game.includes(" @ ")).map((r) => r.game));
  const gameToKickoff = new Map<string, string>();
  for (const r of allRecords) {
    if (r.kickoff_time) gameToKickoff.set(r.game, r.kickoff_time);
  }

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
    let bestGame = playerToGame.get(`${r.league}|${r.player}`);

    if (!bestGame || !bestGame.includes(" @ ")) {
      const matches = [...fullGames].filter((g) => g.includes(r.game));
      bestGame = matches.length === 1 ? matches[0] : r.game;
    }

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
