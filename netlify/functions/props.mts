import type { Context } from "@netlify/functions";
import {
  fetchUnabatedProps,
  parseUnabatedProps,
  buildHighlights,
  SUPPORTED_MARKETS,
  UNABATED_WNBA_PROPS_URL,
} from "./lib/unabated.js";
import { loadMerkurProps, MERKUR_SK_URL } from "./lib/merkur.js";
import { loadSuperbetProps, EVENTS_BY_DATE_URL } from "./lib/superbet.js";
import { loadStoiximanProps, BASE as STOIXIMAN_BASE } from "./lib/stoiximan.js";
import { loadMaxbetProps, BASE_URL as MAXBET_BASE_URL } from "./lib/maxbet.js";
import { loadMozzartProps, MOZZART_BASE_URL } from "./lib/mozzart.js";
import {
  loadAdmiralbetProps,
  ADMIRALBET_BASE_URL,
} from "./lib/admiralbet.js";
import {
  loadBalkanbetProps,
  BALKANBET_BASE_URL,
} from "./lib/balkanbet.js";
import { mergeAndNormalize } from "./lib/merge.js";
import { applyMovementDeltas } from "./lib/movement.js";
import type { PropRecord } from "./lib/types.js";

export default async (req: Request, context: Context) => {
  // --- Unabated (primary WNBA source — multiple books; not cached) ---
  let unabatedRecords: PropRecord[] = [];
  try {
    const raw = await fetchUnabatedProps();
    unabatedRecords = parseUnabatedProps(raw).filter((r) => SUPPORTED_MARKETS.has(r.market));
  } catch (exc) {
    console.error("[unabated] fetch failed —", exc);
  }

  // --- Merkur Xtip (multi-league, single book) ---
  let merkurRecords: PropRecord[] = [];
  try {
    merkurRecords = await loadMerkurProps(context);
  } catch (exc) {
    console.error("[merkur] fetch failed —", exc);
  }

  // --- Superbet RS (multi-league, single book) ---
  let superbetRecords: PropRecord[] = [];
  try {
    superbetRecords = await loadSuperbetProps(context);
  } catch (exc) {
    console.error("[superbet] fetch failed —", exc);
  }

  // --- Stoiximan (ACB, WNBA, Izrael — "N+" threshold bets, over only) ---
  let stoiximanRecords: PropRecord[] = [];
  try {
    stoiximanRecords = await loadStoiximanProps(context);
  } catch (exc) {
    console.error("[stoiximan] fetch failed —", exc);
  }

  // --- MaxBet RS (WNBA, ACB — full O/U player props) ---
  let maxbetRecords: PropRecord[] = [];
  try {
    maxbetRecords = await loadMaxbetProps(context);
  } catch (exc) {
    console.error("[maxbet] fetch failed —", exc);
  }

  // --- Mozzart (whichever "...Players" competitions are currently live) ---
  let mozzartRecords: PropRecord[] = [];
  try {
    mozzartRecords = await loadMozzartProps();
  } catch (exc) {
    console.error("[mozzart] fetch failed —", exc);
  }

  // --- AdmiralBet RS (multi-league, single book) ---
  let admiralbetRecords: PropRecord[] = [];
  try {
    admiralbetRecords = await loadAdmiralbetProps(context);
  } catch (exc) {
    console.error("[admiralbet] fetch failed —", exc);
  }

  // --- BalkanBet RS (multi-league, single book) ---
  let balkanbetRecords: PropRecord[] = [];
  try {
    balkanbetRecords = await loadBalkanbetProps(context);
  } catch (exc) {
    console.error("[balkanbet] fetch failed —", exc);
  }

  const allRecords = [
    ...unabatedRecords,
    ...merkurRecords,
    ...superbetRecords,
    ...stoiximanRecords,
    ...maxbetRecords,
    ...mozzartRecords,
    ...admiralbetRecords,
    ...balkanbetRecords,
  ];

  const { records, leagues, markets } = mergeAndNormalize(allRecords);
  const recordsWithDeltas = await applyMovementDeltas(records);

  const payload = {
    phase: "Phase 2: Multi-Source, Multi-League Odds Comparison",
    leagues,
    markets,
    records: recordsWithDeltas,
    highlights: buildHighlights(records),
    sources: {
      unabated: UNABATED_WNBA_PROPS_URL,
      merkur: MERKUR_SK_URL,
      superbet: EVENTS_BY_DATE_URL,
      stoiximan: STOIXIMAN_BASE,
      maxbet: MAXBET_BASE_URL,
      mozzart: MOZZART_BASE_URL,
      admiralbet: ADMIRALBET_BASE_URL,
      balkanbet: BALKANBET_BASE_URL,
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};

