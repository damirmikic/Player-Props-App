export interface PropRecord {
  league: string;
  game: string;
  team: string;
  player: string;
  market: string;
  line: number;
  over_odds_decimal: number | null;
  under_odds_decimal: number | null;
  bookmaker: string;
  kickoff_time: string;
  updated_at: string;
}

export function groupKey(r: Pick<PropRecord, "player" | "market">): string {
  return `${r.player}|${r.market}`;
}

export function recordKey(
  r: Pick<PropRecord, "player" | "market" | "bookmaker" | "line">
): string {
  return `${r.player}|${r.market}|${r.bookmaker}|${r.line}`;
}

export function snapshotKey(
  r: Pick<PropRecord, "player" | "market" | "bookmaker">
): string {
  return `${r.player}|${r.market}|${r.bookmaker}`;
}
