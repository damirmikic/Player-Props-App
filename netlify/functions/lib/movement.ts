/**
 * Movement-delta tracking — ported from _prev_snapshot / _compute_deltas in
 * server.py. The in-memory dict + threading.Lock becomes a single Blobs key;
 * no lock is needed since each function invocation is single-threaded per
 * request (accept last-write-wins under concurrent requests, same looseness
 * as the original).
 */
import { getStore } from "@netlify/blobs";
import { snapshotKey, type PropRecord } from "./types.js";

const STORE_NAME = "movement-snapshot";
const SNAPSHOT_KEY = "snapshot";

interface SnapshotEntry {
  line: number;
  over_odds_decimal: number | null;
  under_odds_decimal: number | null;
}

export interface MovementDelta {
  line_delta: number | null;
  over_odds_delta: number | null;
  under_odds_delta: number | null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function computeDeltas(
  records: PropRecord[],
  prev: Record<string, SnapshotEntry>
): Record<string, MovementDelta> {
  const result: Record<string, MovementDelta> = {};

  for (const r of records) {
    const key = snapshotKey(r);
    const p = prev[key];
    if (!p) continue;

    const ld = round(r.line - p.line, 2);
    const od =
      r.over_odds_decimal !== null && p.over_odds_decimal !== null
        ? round(r.over_odds_decimal - p.over_odds_decimal, 3)
        : null;
    const ud =
      r.under_odds_decimal !== null && p.under_odds_decimal !== null
        ? round(r.under_odds_decimal - p.under_odds_decimal, 3)
        : null;

    const hasMovement =
      Math.abs(ld) > 0.001 || (od !== null && Math.abs(od) > 0.001) || (ud !== null && Math.abs(ud) > 0.001);
    if (!hasMovement) continue;

    result[key] = {
      line_delta: Math.abs(ld) > 0.001 ? ld : null,
      over_odds_delta: od !== null && Math.abs(od) > 0.001 ? od : null,
      under_odds_delta: ud !== null && Math.abs(ud) > 0.001 ? ud : null,
    };
  }

  return result;
}

export async function applyMovementDeltas(
  records: PropRecord[]
): Promise<Array<PropRecord & MovementDelta>> {
  const store = getStore(STORE_NAME);

  let prev: Record<string, SnapshotEntry> = {};
  try {
    prev = (await store.get(SNAPSHOT_KEY, { type: "json" })) ?? {};
  } catch (exc) {
    console.error("[movement] snapshot read failed:", exc);
  }

  const movements = computeDeltas(records, prev);

  const nextSnapshot: Record<string, SnapshotEntry> = {};
  for (const r of records) {
    nextSnapshot[snapshotKey(r)] = {
      line: r.line,
      over_odds_decimal: r.over_odds_decimal,
      under_odds_decimal: r.under_odds_decimal,
    };
  }

  try {
    await store.setJSON(SNAPSHOT_KEY, nextSnapshot);
  } catch (exc) {
    console.error("[movement] snapshot write failed:", exc);
  }

  return records.map((r) => {
    const mv = movements[snapshotKey(r)];
    return {
      ...r,
      line_delta: mv?.line_delta ?? null,
      over_odds_delta: mv?.over_odds_delta ?? null,
      under_odds_delta: mv?.under_odds_delta ?? null,
    };
  });
}
