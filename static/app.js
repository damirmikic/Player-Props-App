const state = {
  records: [],
  highlights: {},
  leagues: [],
  markets: [],
  league: null,
  marketFilter: "all",
  matchFilter: "all",
  search: "",
  activeBooks: new Set(),
  tab: "board",
  watchlist: loadWatchlist(),
  alerts: loadAlerts(),
  alertThresholdPct: loadAlertThreshold(),
  alertBooks: loadAlertBooks(),
  compareBooks: loadCompareBooks(),
  compareThresholdPct: loadCompareThreshold(),
  bookGaps: [],
  detailKey: null,
  detailMarket: null,
  highlightedBook: loadHighlightedBook(),
  sortBy: localStorage.getItem("props_sort") || "kickoff",
};

// Which bookmaker sheet mode is currently open: "board" filters board cards,
// "alerts" filters which books' movements are allowed to generate alerts,
// "compare" picks the books whose lines/odds are compared against each other.
let _bookSheetMode = "board";

let _lastFetchedAt = null;
let _lastStatusPrefix = "Loading…";
let _pollTimer = null;
let _loadingProps = false;
let _hasLoadedOnce = false;

const STAR_OUTLINE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';

// ---------- persistence ----------

function loadWatchlist() {
  try {
    const raw = localStorage.getItem("props_watchlist");
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveWatchlist() {
  localStorage.setItem("props_watchlist", JSON.stringify([...state.watchlist]));
}

function loadAlerts() {
  try {
    const raw = sessionStorage.getItem("props_alerts");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveAlerts() {
  sessionStorage.setItem("props_alerts", JSON.stringify(state.alerts.slice(0, 30)));
}

function loadAlertThreshold() {
  const raw = localStorage.getItem("props_alert_threshold_pct");
  const value = raw != null ? Number(raw) : 3;
  return Number.isFinite(value) && value >= 0 ? value : 3;
}

function saveAlertThreshold() {
  localStorage.setItem("props_alert_threshold_pct", String(state.alertThresholdPct));
}

// null means "no restriction — alert on every book". Once the user narrows
// the selection via the sheet, it becomes a concrete Set of book names.
function loadAlertBooks() {
  try {
    const raw = localStorage.getItem("props_alert_books");
    if (raw == null) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : null;
  } catch {
    return null;
  }
}

function saveAlertBooks() {
  if (state.alertBooks == null) {
    localStorage.removeItem("props_alert_books");
  } else {
    localStorage.setItem("props_alert_books", JSON.stringify([...state.alertBooks]));
  }
}

function allowedForAlerts(bookmaker) {
  return state.alertBooks == null || state.alertBooks.has(bookmaker);
}

// Empty by default — book-gap comparison only runs once at least two books are picked.
function loadCompareBooks() {
  try {
    const raw = localStorage.getItem("props_compare_books");
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function saveCompareBooks() {
  localStorage.setItem("props_compare_books", JSON.stringify([...state.compareBooks]));
}

function loadCompareThreshold() {
  const raw = localStorage.getItem("props_compare_threshold_pct");
  const value = raw != null ? Number(raw) : 5;
  return Number.isFinite(value) && value >= 0 ? value : 5;
}

function saveCompareThreshold() {
  localStorage.setItem("props_compare_threshold_pct", String(state.compareThresholdPct));
}

function loadHighlightedBook() {
  return localStorage.getItem("props_highlighted_book") || "merkurxtip";
}

function saveHighlightedBook() {
  if (state.highlightedBook == null) {
    localStorage.removeItem("props_highlighted_book");
  } else {
    localStorage.setItem("props_highlighted_book", state.highlightedBook);
  }
}

// ---------- helpers ----------

function titleCase(value) {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Escape a string for safe insertion as HTML text content. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape a string for safe insertion into an HTML attribute value. */
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}


function marketLabel(market) {
  return titleCase((market || "").replace(/_/g, " "));
}

function marketTagHtml(market) {
  const m = market || "points";
  return `<span class="market-tag market-${escapeAttr(m)}">${marketLabel(m)}</span>`;
}

function formatOdds(value) {
  return value === null || value === undefined ? "–" : Number(value).toFixed(2);
}

function hasOdds(record) {
  if (!record) return false;
  const hasOver = record.over_odds_decimal != null && !isNaN(Number(record.over_odds_decimal)) && Number(record.over_odds_decimal) > 0;
  const hasUnder = record.under_odds_decimal != null && !isNaN(Number(record.under_odds_decimal)) && Number(record.under_odds_decimal) > 0;
  return hasOver || hasUnder;
}

function groupKey(record) {
  return `${record.player}|${record.market}`;
}

function watchKey(player, market) {
  return `${player}|${market}`;
}

function recordKey(record) {
  return `${record.player}|${record.market}|${record.bookmaker}|${record.line}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

/**
 * Format a kickoff ISO timestamp into a compact local-time string.
 * Returns null if timestamp is missing or unparseable.
 *
 * Today:     "Today 21:00"
 * Tomorrow:  "Tomorrow 14:30"
 * This week: "Mon 18:00"
 * Otherwise: "24 Aug 18:00"
 */
function formatKickoff(isoStr) {
  if (!isoStr) return null;
  const d = new Date(isoStr);
  if (isNaN(d)) return null;

  const now = new Date();
  const timeStr = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const kickoffDay   = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((kickoffDay - todayMidnight) / 86400000);

  if (dayDiff === 0) return `Today ${timeStr}`;
  if (dayDiff === 1) return `Tomorrow ${timeStr}`;
  if (dayDiff > 1 && dayDiff < 7) {
    const dayName = d.toLocaleDateString([], { weekday: "short" });
    return `${dayName} ${timeStr}`;
  }
  const dateStr = d.toLocaleDateString([], { day: "numeric", month: "short" });
  return `${dateStr} ${timeStr}`;
}

function isBestOver(record) {
  const h = state.highlights[groupKey(record)];
  return !!h && h.best_over === recordKey(record);
}

function isBestUnder(record) {
  const h = state.highlights[groupKey(record)];
  return !!h && h.best_under === recordKey(record);
}

function hasMovement(record) {
  return record.line_delta != null || record.over_odds_delta != null || record.under_odds_delta != null;
}

// ---------- DOM refs ----------

const statusEl = document.querySelector("#status");
const leagueRow = document.querySelector("#leagueRow");
const matchSelect = document.querySelector("#matchSelect");
const marketRow = document.querySelector("#marketRow");
const booksChip = document.querySelector("#booksChip");
const booksChipCount = document.querySelector("#booksChipCount");
const searchInput = document.querySelector("#searchInput");
const boardList = document.querySelector("#boardList");
const watchList = document.querySelector("#watchList");
const alertsList = document.querySelector("#alertsList");
const alertThresholdInput = document.querySelector("#alertThreshold");
const alertBooksChip = document.querySelector("#alertBooksChip");
const alertBooksChipCount = document.querySelector("#alertBooksChipCount");
const compareList = document.querySelector("#compareList");
const compareThresholdInput = document.querySelector("#compareThreshold");
const compareBooksChip = document.querySelector("#compareBooksChip");
const compareBooksChipCount = document.querySelector("#compareBooksChipCount");
const watchCountEl = document.querySelector("#watchCount");
const alertCountEl = document.querySelector("#alertCount");

const screenBoard = document.querySelector("#screen-board");
const screenDetail = document.querySelector("#screen-detail");
const panelBoard = document.querySelector("#panel-board");
const panelWatch = document.querySelector("#panel-watch");
const panelAlerts = document.querySelector("#panel-alerts");

const backBtn = document.querySelector("#backBtn");
const detailPlayer = document.querySelector("#detailPlayer");
const detailSubtitle = document.querySelector("#detailSubtitle");
const detailStar = document.querySelector("#detailStar");
const detailMarketRow = document.querySelector("#detailMarketRow");
const detailList = document.querySelector("#detailList");

const scrim = document.querySelector("#scrim");
const bookSheet = document.querySelector("#bookSheet");
const bookSheetTitle = document.querySelector("#bookSheetTitle");
const bookSheetList = document.querySelector("#bookSheetList");
const booksAllBtn = document.querySelector("#booksAllBtn");
const booksNoneBtn = document.querySelector("#booksNoneBtn");
const booksDoneBtn = document.querySelector("#booksDoneBtn");

const tickerInner = document.querySelector("#tickerInner");

// ---------- data grouping ----------

function comparisonKey(record) {
  return `${record.player}|${record.market}`;
}

function buildGroups(records) {
  const rows = new Map();
  for (const record of records) {
    const key = comparisonKey(record);
    if (!rows.has(key)) {
      rows.set(key, {
        game: record.game,
        team: record.team,
        player: record.player,
        market: record.market,
        kickoff_time: record.kickoff_time || "",
        books: {},
      });
    }
    const row = rows.get(key);
    if (record.game && record.game.length > row.game.length) row.game = record.game;
    if (!row.team && record.team) row.team = record.team;
    if (!row.kickoff_time && record.kickoff_time) row.kickoff_time = record.kickoff_time;
    row.books[record.bookmaker] = record;
  }

  const sorted = [...rows.values()];

  if (state.sortBy === "name") {
    sorted.sort((a, b) => {
      const p = a.player.localeCompare(b.player);
      return p !== 0 ? p : a.market.localeCompare(b.market);
    });
  } else {
    // Default: sort by kickoff ascending; rows without a kickoff float to bottom
    sorted.sort((a, b) => {
      const aHas = !!a.kickoff_time;
      const bHas = !!b.kickoff_time;
      if (aHas && bHas) {
        const timeDiff = a.kickoff_time.localeCompare(b.kickoff_time);
        if (timeDiff !== 0) return timeDiff;
      } else if (aHas) return -1;
      else if (bHas) return 1;
      // Secondary: name within same kickoff bucket
      const p = a.player.localeCompare(b.player);
      return p !== 0 ? p : a.market.localeCompare(b.market);
    });
  }

  return sorted;
}

function setSortBy(value) {
  state.sortBy = value;
  localStorage.setItem("props_sort", value);
  // Update toggle button states
  document.querySelectorAll(".sort-btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.sort === value));
  });
  renderBoard();
}

function leagueBooks(league) {
  return uniqueSorted(state.records.filter((r) => r.league === league && hasOdds(r)).map((r) => r.bookmaker));
}

function allBooks() {
  return uniqueSorted(state.records.map((r) => r.bookmaker));
}

// ---------- board rendering ----------

function renderLeagueRow() {
  leagueRow.replaceChildren();
  for (const league of state.leagues) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "league-chip";
    btn.textContent = league;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(league === state.league));
    btn.addEventListener("click", () => selectLeague(league));
    leagueRow.appendChild(btn);
  }
}

function selectLeague(league) {
  if (league === state.league) return;
  state.league = league;
  state.marketFilter = "all";
  state.matchFilter = "all";
  state.activeBooks = new Set(leagueBooks(league));
  renderLeagueRow();
  renderMatchSelect();
  renderMarketRow();
  renderBoard();
}

function leagueMatches(league) {
  return uniqueSorted(state.records.filter((r) => r.league === league && r.game).map((r) => r.game));
}

function renderMatchSelect() {
  const matches = leagueMatches(state.league);
  const current = state.matchFilter;

  matchSelect.replaceChildren();
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All matches";
  matchSelect.appendChild(allOption);

  for (const match of matches) {
    const option = document.createElement("option");
    option.value = match;
    option.textContent = match;
    matchSelect.appendChild(option);
  }

  matchSelect.value = matches.includes(current) ? current : "all";
  state.matchFilter = matchSelect.value;
}

function renderMarketRow() {
  const markets = uniqueSorted(
    state.records.filter((r) => r.league === state.league).map((r) => r.market)
  );
  marketRow.replaceChildren();

  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "market-chip";
  allChip.textContent = "All markets";
  allChip.setAttribute("aria-selected", String(state.marketFilter === "all"));
  allChip.addEventListener("click", () => {
    state.marketFilter = "all";
    renderMarketRow();
    renderBoard();
  });
  marketRow.appendChild(allChip);

  for (const market of markets) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "market-chip";
    chip.setAttribute("data-market", market);
    chip.textContent = marketLabel(market);
    chip.setAttribute("aria-selected", String(state.marketFilter === market));
    chip.addEventListener("click", () => {
      state.marketFilter = market;
      renderMarketRow();
      renderBoard();
    });
    marketRow.appendChild(chip);
  }

  booksChipCount.textContent = state.activeBooks.size;
}

function filteredBoardRecords() {
  const query = state.search.trim().toLowerCase();
  return state.records.filter((r) => {
    if (r.league !== state.league) return false;
    if (state.matchFilter !== "all" && r.game !== state.matchFilter) return false;
    if (state.marketFilter !== "all" && r.market !== state.marketFilter) return false;
    if (!state.activeBooks.has(r.bookmaker)) return false;
    if (!hasOdds(r)) return false;
    if (!query) return true;
    return `${r.player} ${r.team}`.toLowerCase().includes(query);
  });
}

function bookCellHtml(book, record, consensus) {
  if (!hasOdds(record)) return "";

  const isGolden = state.highlightedBook === book;
  const goldenClass = isGolden ? " golden" : "";

  const overBest = isBestOver(record) ? " best" : "";
  const underBest = isBestUnder(record) ? " best" : "";
  const overDelta = record.over_odds_delta != null
    ? `<span class="delta ${record.over_odds_delta > 0 ? "up" : "down"}">${record.over_odds_delta > 0 ? "↑" : "↓"}</span>`
    : "";
  const underDelta = record.under_odds_delta != null
    ? `<span class="delta ${record.under_odds_delta > 0 ? "up" : "down"}">${record.under_odds_delta > 0 ? "↑" : "↓"}</span>`
    : "";
  const lineDelta = record.line_delta != null
    ? `<span class="line-delta ${record.line_delta > 0 ? "delta up" : "delta down"}">${record.line_delta > 0 ? "+" : ""}${record.line_delta} → ${record.line.toFixed(1)}</span>`
    : "";
  const lineDiff = consensus != null && record.line !== consensus;

  return `
    <div class="book-cell${lineDiff ? " line-diff" : ""}${goldenClass}">
      <div class="book-cell-head"><span>${book} &middot; ${record.line.toFixed(1)}</span>${lineDelta}</div>
      <div class="pill-row">
        <span class="price-pill${overBest}">O ${formatOdds(record.over_odds_decimal)}${overDelta}</span>
        <span class="price-pill${underBest}">U ${formatOdds(record.under_odds_decimal)}${underDelta}</span>
      </div>
    </div>
  `;
}

function consensusLine(row, books) {
  const counts = new Map();
  for (const book of books) {
    const line = row.books[book]?.line;
    if (line !== undefined) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [line, count] of counts) {
    if (count > bestCount) { best = line; bestCount = count; }
  }
  return best;
}

function propCardHtml(row) {
  const moved = Object.values(row.books).some(hasMovement);
  const key = watchKey(row.player, row.market);
  const isStarred = state.watchlist.has(key);
  const candidateBooks = state.activeBooks.size > 0
    ? [...state.activeBooks]
    : Object.keys(row.books);
  const books = candidateBooks.filter((book) => hasOdds(row.books[book]));

  if (books.length === 0) return "";

  const consensus = consensusLine(row, books);
  const cells = books.map((book) => bookCellHtml(book, row.books[book], consensus)).filter(Boolean).join("");
  if (!cells) return "";

  const kickoff = formatKickoff(row.kickoff_time);

  return `
    <article class="prop-card" data-player="${escapeAttr(row.player)}" data-market="${escapeAttr(row.market)}">
      <div class="prop-card-top">
        <div class="prop-card-meta">
          <p class="prop-name${moved ? " flash" : ""}">${row.player}</p>
          <p class="prop-subline">${row.team ? `<span class="prop-team">${escapeAttr(row.team)}</span> &middot; ` : ""}${marketTagHtml(row.market)}</p>
          <p class="prop-game">${row.game ? `vs ${escapeHtml(row.game)}` : ""}&nbsp;${kickoff ? `<span class="kickoff-badge">🕐 ${escapeHtml(kickoff)}</span>` : ""}</p>
        </div>
        ${consensus != null ? `<span class="consensus-chip">Consensus ${consensus.toFixed(1)}</span>` : ""}
        <button type="button" class="star-toggle" data-active="${isStarred}" aria-label="Toggle watchlist">${STAR_OUTLINE}</button>
      </div>
      <div class="book-grid">${cells}</div>
    </article>
  `;
}

function renderBoard() {
  const rows = buildGroups(filteredBoardRecords());
  booksChipCount.textContent = state.activeBooks.size;

  const cardsHtml = rows.map(propCardHtml).filter(Boolean).join("");
  if (!cardsHtml) {
    boardList.innerHTML = `<div class="empty-state">No props match your filters.</div>`;
    return;
  }

  boardList.innerHTML = cardsHtml;
}

// ---------- watchlist panel ----------

function renderWatchlist() {
  const entries = [...state.watchlist].map((key) => {
    const [player, market] = key.split("|");
    const records = state.records.filter((r) => r.player === player && r.market === market);
    return { key, player, market, records };
  }).filter((e) => e.records.length > 0 || state.watchlist.has(e.key));

  entries.sort((a, b) => a.player.localeCompare(b.player));

  if (entries.length === 0) {
    watchList.innerHTML = `<div class="empty-state">Tap the star on any prop to track it here.</div>`;
    return;
  }

  watchList.innerHTML = entries.map((e) => {
    const overs = e.records.map((r) => r.over_odds_decimal).filter((v) => v != null);
    const unders = e.records.map((r) => r.under_odds_decimal).filter((v) => v != null);
    const bestOver = overs.length ? Math.max(...overs) : null;
    const bestUnder = unders.length ? Math.max(...unders) : null;
    const summary = `${marketTagHtml(e.market)} · Best O ${formatOdds(bestOver)} / U ${formatOdds(bestUnder)}`;

    return `
      <article class="watch-row" data-player="${escapeAttr(e.player)}" data-market="${escapeAttr(e.market)}">
        <div class="watch-row-meta">
          <p class="watch-row-name">${e.player}</p>
          <p class="watch-row-detail">${summary}</p>
        </div>
        <button type="button" class="star-toggle" data-active="true" aria-label="Remove from watchlist">${STAR_OUTLINE}</button>
      </article>
    `;
  }).join("");
}

// ---------- alerts panel ----------

function renderAlerts() {
  const visible = state.alerts.filter((a) => allowedForAlerts(a.book));

  if (visible.length === 0) {
    alertsList.innerHTML = state.alerts.length === 0
      ? `<div class="empty-state">No line or odds movement yet&hellip;</div>`
      : `<div class="empty-state">No movement yet from the selected bookmakers.</div>`;
    return;
  }

  alertsList.innerHTML = visible.map((a) => `
    <article class="alert-card" data-player="${escapeAttr(a.player)}" data-market="${escapeAttr(a.market)}">
      <div class="alert-top">
        <span>${a.player} &middot; ${marketTagHtml(a.market)}</span>
        <span class="alert-time">${relativeTime(a.when)}</span>
      </div>
      <p class="alert-detail">${a.book} — ${a.detail}</p>
    </article>
  `).join("");
}

function pushAlert(entry) {
  state.alerts.unshift(entry);
  state.alerts = state.alerts.slice(0, 30);
  saveAlerts();
}

function pctMove(delta, previousValue) {
  if (delta == null || !previousValue) return null;
  return Math.abs(delta / previousValue) * 100;
}

function collectMovementAlerts(records) {
  const now = Date.now();
  const threshold = state.alertThresholdPct;

  for (const r of records) {
    if (!allowedForAlerts(r.bookmaker)) continue;
    if (r.line_delta != null) {
      const prevLine = r.line - r.line_delta;
      const pct = pctMove(r.line_delta, prevLine);
      if (pct != null && pct >= threshold) {
        pushAlert({
          player: r.player,
          market: r.market,
          book: r.bookmaker,
          detail: `Line ${prevLine.toFixed(1)} → ${r.line.toFixed(1)} (${pct.toFixed(1)}%)`,
          when: now,
        });
      }
    }
    if (r.over_odds_delta != null) {
      const prevOver = r.over_odds_decimal - r.over_odds_delta;
      const pct = pctMove(r.over_odds_delta, prevOver);
      if (pct != null && pct >= threshold) {
        pushAlert({
          player: r.player,
          market: r.market,
          book: r.bookmaker,
          detail: `Line ${r.line.toFixed(1)} · Over ${formatOdds(prevOver)} → ${formatOdds(r.over_odds_decimal)} (${pct.toFixed(1)}%)`,
          when: now,
        });
      }
    }
    if (r.under_odds_delta != null) {
      const prevUnder = r.under_odds_decimal - r.under_odds_delta;
      const pct = pctMove(r.under_odds_delta, prevUnder);
      if (pct != null && pct >= threshold) {
        pushAlert({
          player: r.player,
          market: r.market,
          book: r.bookmaker,
          detail: `Line ${r.line.toFixed(1)} · Under ${formatOdds(prevUnder)} → ${formatOdds(r.under_odds_decimal)} (${pct.toFixed(1)}%)`,
          when: now,
        });
      }
    }
  }
}

// ---------- book gaps (cross-book comparison) ----------

function gapPct(low, high) {
  if (!low || low <= 0) return null;
  return ((high - low) / low) * 100;
}

// Compares the selected books against each other per league×player×market:
// a line gap when their lines differ, and an odds gap when books quoting the
// same line differ on over or under price. Odds on different lines aren't
// comparable, so they're only checked within a single line.
function computeBookGaps() {
  if (state.compareBooks.size < 2) return [];
  const threshold = state.compareThresholdPct;

  const groups = new Map();
  for (const r of state.records) {
    if (!state.compareBooks.has(r.bookmaker) || !hasOdds(r)) continue;
    const key = `${r.league}|${r.player}|${r.market}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const gaps = [];
  for (const records of groups.values()) {
    if (new Set(records.map((r) => r.bookmaker)).size < 2) continue;
    const { league, player, market } = records[0];

    const byLine = [...records].sort((a, b) => a.line - b.line);
    const low = byLine[0];
    const high = byLine[byLine.length - 1];
    const linePct = gapPct(low.line, high.line);
    if (linePct && linePct >= threshold) {
      gaps.push({
        league, player, market, pct: linePct,
        detail: `Line ${low.bookmaker} ${low.line.toFixed(1)} vs ${high.bookmaker} ${high.line.toFixed(1)} (${linePct.toFixed(1)}%)`,
      });
    }

    const lines = new Map();
    for (const r of records) {
      if (!lines.has(r.line)) lines.set(r.line, []);
      lines.get(r.line).push(r);
    }
    for (const [line, sameLine] of lines) {
      for (const [side, field] of [["Over", "over_odds_decimal"], ["Under", "under_odds_decimal"]]) {
        const priced = sameLine.filter((r) => r[field] != null && r[field] > 0)
          .sort((a, b) => a[field] - b[field]);
        if (priced.length < 2) continue;
        const lo = priced[0];
        const hi = priced[priced.length - 1];
        const pct = gapPct(lo[field], hi[field]);
        if (pct && pct >= threshold) {
          gaps.push({
            league, player, market, pct,
            detail: `Line ${line.toFixed(1)} · ${side} ${lo.bookmaker} ${formatOdds(lo[field])} vs ${hi.bookmaker} ${formatOdds(hi[field])} (${pct.toFixed(1)}%)`,
          });
        }
      }
    }
  }

  return gaps.sort((a, b) => b.pct - a.pct);
}

function refreshBookGaps() {
  state.bookGaps = computeBookGaps();
}

function renderCompare() {
  if (state.compareBooks.size < 2) {
    compareList.innerHTML = `<div class="empty-state">Pick at least two bookmakers to compare.</div>`;
    return;
  }
  if (state.bookGaps.length === 0) {
    compareList.innerHTML = `<div class="empty-state">No gaps at or above ${state.compareThresholdPct}% between the selected books.</div>`;
    return;
  }

  compareList.innerHTML = state.bookGaps.map((g) => `
    <article class="alert-card" data-player="${escapeAttr(g.player)}" data-market="${escapeAttr(g.market)}">
      <div class="alert-top">
        <span>${g.player} &middot; ${marketTagHtml(g.market)}</span>
        <span class="alert-time">${g.league}</span>
      </div>
      <p class="alert-detail">${g.detail}</p>
    </article>
  `).join("");
}

function renderCompareBooksChip() {
  compareBooksChipCount.textContent = `${state.compareBooks.size}/${allBooks().length}`;
}

// ---------- tabs / counts ----------

function renderCounts() {
  watchCountEl.textContent = state.watchlist.size ? `(${state.watchlist.size})` : "";
  const visibleAlerts = state.alerts.filter((a) => allowedForAlerts(a.book)).length + state.bookGaps.length;
  alertCountEl.textContent = visibleAlerts ? `(${visibleAlerts})` : "";
}

function setTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll(".seg-btn")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
  }
  panelBoard.hidden = tab !== "board";
  panelWatch.hidden = tab !== "watch";
  panelAlerts.hidden = tab !== "alerts";

  if (tab === "watch") renderWatchlist();
  if (tab === "alerts") {
    renderCompare();
    renderAlerts();
  }
}

// ---------- detail screen ----------

function openDetail(player, market) {
  state.detailKey = player;
  state.detailMarket = market;
  screenBoard.hidden = true;
  screenDetail.hidden = false;
  renderDetail();
}

function closeDetail() {
  screenDetail.hidden = true;
  screenBoard.hidden = false;
}

function renderDetail() {
  const player = state.detailKey;
  const playerRecords = state.records.filter(
    (r) => r.player === player && r.league === state.league
  );
  if (playerRecords.length === 0) {
    // fall back to any league match if the player isn't in the current league view
    const anyLeagueRecords = state.records.filter((r) => r.player === player);
    if (anyLeagueRecords.length > 0) {
      state.league = anyLeagueRecords[0].league;
    }
  }

  const records = state.records.filter((r) => r.player === player && r.league === state.league && hasOdds(r));
  const markets = uniqueSorted(records.map((r) => r.market));
  if (!markets.includes(state.detailMarket) && markets.length > 0) {
    state.detailMarket = markets[0];
  }

  const marketRecords = records.filter((r) => r.market === state.detailMarket && hasOdds(r));
  const game = marketRecords[0]?.game || "";
  const team = marketRecords[0]?.team || "";

  detailPlayer.textContent = player;
  detailSubtitle.textContent = [team, game].filter(Boolean).join(" · ");

  const isStarred = state.watchlist.has(watchKey(player, state.detailMarket));
  detailStar.setAttribute("data-active", String(isStarred));

  detailMarketRow.innerHTML = markets.map((m) => `
    <button type="button" class="market-chip" data-market="${escapeAttr(m)}" aria-selected="${m === state.detailMarket}">${marketLabel(m)}</button>
  `).join("");

  if (marketRecords.length === 0) {
    detailList.innerHTML = `<div class="empty-state">No books currently cover this market.</div>`;
    return;
  }

  detailList.innerHTML = marketRecords
    .sort((a, b) => {
      // Pinned (golden) book always sorts first
      const aGolden = state.highlightedBook === a.bookmaker ? 0 : 1;
      const bGolden = state.highlightedBook === b.bookmaker ? 0 : 1;
      if (aGolden !== bGolden) return aGolden - bGolden;
      return a.bookmaker.localeCompare(b.bookmaker);
    })
    .map((r) => {
      const overBest = isBestOver(r) ? " best" : "";
      const underBest = isBestUnder(r) ? " best" : "";
      const isGolden = state.highlightedBook === r.bookmaker;
      return `
        <div class="detail-row${isGolden ? " golden" : ""}">
          <div class="detail-row-top">
            <span class="detail-row-book">${r.bookmaker}</span>
            <span class="detail-row-line">Line ${r.line.toFixed(1)}</span>
          </div>
          <div class="pill-row">
            <span class="price-pill${overBest}">O ${formatOdds(r.over_odds_decimal)}</span>
            <span class="price-pill${underBest}">U ${formatOdds(r.under_odds_decimal)}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

// ---------- bookmaker sheet ----------

function openBookSheet(mode) {
  _bookSheetMode = mode;

  if (mode === "alerts" || mode === "compare") {
    const books = allBooks();
    const isChecked = mode === "alerts" ? allowedForAlerts : (book) => state.compareBooks.has(book);
    bookSheetTitle.textContent = mode === "alerts" ? "Alert Bookmakers" : "Compare Bookmakers";
    bookSheetList.innerHTML = books.map((book) => `
      <label class="sheet-check-row">
        <input type="checkbox" value="${escapeAttr(book)}" ${isChecked(book) ? "checked" : ""}>
        <span>${book}</span>
      </label>
    `).join("");
  } else {
    const books = leagueBooks(state.league);
    bookSheetTitle.textContent = "Bookmakers";
    bookSheetList.innerHTML = books.map((book) => {
      const isGolden = state.highlightedBook === book;
      return `
        <label class="sheet-check-row">
          <input type="checkbox" value="${escapeAttr(book)}" ${state.activeBooks.has(book) ? "checked" : ""}>
          <span>${book}</span>
          <button type="button" class="golden-star-btn${isGolden ? " active" : ""}" data-book="${escapeAttr(book)}" title="Highlight this bookmaker in gold" aria-label="Highlight ${escapeAttr(book)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="${isGolden ? "#f5a623" : "none"}" stroke="${isGolden ? "#f5a623" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
          </button>
        </label>
      `;
    }).join("");
  }

  scrim.hidden = false;
  bookSheet.hidden = false;
}

function closeBookSheet() {
  const checked = new Set(
    [...bookSheetList.querySelectorAll("input:checked")].map((i) => i.value)
  );
  const total = bookSheetList.querySelectorAll("input").length;

  if (_bookSheetMode === "alerts") {
    // Treat "every book checked" the same as "no restriction" so newly
    // added bookmakers are covered automatically instead of silently excluded.
    state.alertBooks = checked.size === total ? null : checked;
    saveAlertBooks();
    renderAlertBooksChip();
    renderCounts();
    renderAlerts();
  } else if (_bookSheetMode === "compare") {
    state.compareBooks = checked;
    saveCompareBooks();
    refreshBookGaps();
    renderCompareBooksChip();
    renderCounts();
    renderCompare();
  } else {
    state.activeBooks = checked;
    renderMarketRow();
    renderBoard();
  }

  scrim.hidden = true;
  bookSheet.hidden = true;
}

function renderAlertBooksChip() {
  const total = allBooks().length;
  const count = state.alertBooks == null ? total : state.alertBooks.size;
  alertBooksChipCount.textContent = `${count}/${total}`;
}

// ---------- polling ----------

function updateStatusLine() {
  if (!_lastFetchedAt) return;
  const ageSec = Math.floor((Date.now() - _lastFetchedAt) / 1000);
  const ageStr = ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`;
  statusEl.textContent = `${_lastStatusPrefix} · updated ${ageStr}`;
}

async function loadProps() {
  if (_loadingProps) return;
  _loadingProps = true;
  clearTimeout(_pollTimer);
  try {
    const response = await fetch("/api/props", { cache: "no-store" });
    if (!response.ok) throw new Error(`API returned ${response.status}`);
    const payload = await response.json();

    state.records = payload.records || [];
    state.highlights = payload.highlights || {};
    state.leagues = payload.leagues || [];
    state.markets = payload.markets || [];

    if (!state.league || !state.leagues.includes(state.league)) {
      state.league = state.leagues[0] || null;
      state.activeBooks = new Set(leagueBooks(state.league));
    } else if (state.activeBooks.size === 0) {
      state.activeBooks = new Set(leagueBooks(state.league));
    }

    _lastFetchedAt = Date.now();
    const leagueRecords = state.records.filter((r) => r.league === state.league);
    _lastStatusPrefix = `${leagueRecords.length} records · ${state.league || "–"}`;

    renderLeagueRow();
    renderMatchSelect();
    renderMarketRow();
    renderBoard();
    refreshBookGaps();
    renderCounts();
    renderAlertBooksChip();
    renderCompareBooksChip();
    if (state.tab === "watch") renderWatchlist();
    if (state.tab === "alerts") {
      renderCompare();
      renderAlerts();
    }
    if (!screenDetail.hidden) renderDetail();

    if (_hasLoadedOnce) {
      collectMovementAlerts(state.records);
      renderCounts();
      if (state.tab === "alerts") renderAlerts();
    }
    _hasLoadedOnce = true;
    updateStatusLine();
  } catch (error) {
    statusEl.textContent = "Unable to refresh";
    console.error(error);
  } finally {
    _loadingProps = false;
    _pollTimer = setTimeout(loadProps, 30_000);
  }
}

// Background tabs throttle/suspend timers (especially on phones), so odds go
// stale while the tab is hidden. Refetch as soon as the page is visible again.
const STALE_AFTER_MS = 15_000;
function refreshIfStale() {
  if (document.hidden) return;
  if (!_lastFetchedAt || Date.now() - _lastFetchedAt > STALE_AFTER_MS) loadProps();
}
document.addEventListener("visibilitychange", refreshIfStale);
window.addEventListener("focus", refreshIfStale);
window.addEventListener("online", refreshIfStale);
// Page restored from the back/forward cache keeps old JS state.
window.addEventListener("pageshow", (e) => { if (e.persisted) loadProps(); });

// ---------- news ticker ----------

/**
 * Build the displayed text for one ticker item, wrapping detected player
 * names in clickable chips. Uses a simple split-and-replace approach so
 * we never accidentally escape HTML entities inside player names.
 */
function buildTickerItemHTML(text, players) {
  if (!players || players.length === 0) return escapeHtml(text);

  // For each player build a regex that matches the last-name part anywhere in text.
  // Canonical format is "Last F." or "Van Lith H."
  // We extract the last name (everything before the final " X." initial).
  const sorted = players.slice().sort((a, b) => b.length - a.length); // longest first to avoid partial overlaps

  let html = escapeHtml(text);

  for (const canonical of sorted) {
    // Extract last name from canonical "Last F."
    const parts = canonical.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const lastName = parts.slice(0, -1).join(" ");
    if (lastName.length < 4) continue;

    // Build escaped versions for HTML replacement
    const escapedLast = escapeHtml(lastName);
    const escapedCanonical = escapeAttr(canonical);
    const displayName = escapeHtml(lastName);

    // Replace within already-escaped HTML — safe because last names are ASCII-safe
    const re = new RegExp(`\\b${escapedLast.replace(/[-]/g, '\\-')}\\b`, 'gi');
    html = html.replace(re, (match) =>
      `<span class="ticker-player-chip" data-player="${escapedCanonical}" tabindex="0" role="button" aria-label="View props for ${displayName}">${match}</span>`
    );
  }

  return html;
}

/**
 * Truncate plain text to ~120 chars at a word boundary.
 */
function truncateTickerText(text, maxLen = 120) {
  if (!text) return "";
  // Strip the trailing "— @handle Date" attribution added by the RSS app
  const cleaned = text.replace(/—\s*@\S+\s+\w+\s+\d+,\s*\d+\s*$/, "").trim();
  if (cleaned.length <= maxLen) return cleaned;
  const cut = cleaned.lastIndexOf(" ", maxLen);
  return (cut > 60 ? cleaned.slice(0, cut) : cleaned.slice(0, maxLen)) + "…";
}

/**
 * Extract source handle from tweet text ("— @handle Date") or return null.
 */
function extractSource(text) {
  const m = (text || "").match(/—\s*(@\S+)/);
  return m ? m[1] : null;
}

let _newsRefreshTimer = null;

/**
 * Render news items into the ticker strip.
 * Items are duplicated for a seamless CSS loop animation.
 */
function renderTicker(items) {
  if (!items || items.length === 0) {
    tickerInner.innerHTML = '<span class="ticker-loading">No news available</span>';
    return;
  }

  // Build HTML for one set of items
  const buildSet = () => items.map((item) => {
    const text = truncateTickerText(item.text);
    const source = extractSource(item.text);
    const contentHTML = buildTickerItemHTML(text, item.players);
    const sourceHTML = source
      ? `<span class="ticker-item-source">${escapeHtml(source)}</span>`
      : "";
    return `<span class="ticker-item"><span class="ticker-item-bullet"></span>${contentHTML}${sourceHTML}</span>`;
  }).join("");

  // Duplicate for seamless loop
  const setHTML = buildSet();
  tickerInner.innerHTML = setHTML + setHTML;

  // Adjust animation duration based on content length (~80px/s)
  const totalChars = items.reduce((acc, i) => acc + (i.text || "").length, 0);
  const duration = Math.max(30, Math.min(150, Math.round(totalChars * 0.28)));
  tickerInner.style.setProperty("--ticker-duration", `${duration}s`);
}

/**
 * Extract the last-name portion from a canonical "Last F." player string.
 * Examples: "Jokic N." → "Jokic", "Van Lith H." → "Van Lith"
 */
function _playerLastName(canonical) {
  const parts = canonical.trim().split(/\s+/);
  return parts.length < 2 ? canonical.trim() : parts.slice(0, -1).join(" ");
}

/**
 * Given a news-item text and the list of known canonical player names,
 * return the subset of players found in the text (word-boundary match,
 * case-insensitive), ordered by first appearance.
 */
function _matchPlayersInText(text, knownPlayers) {
  if (!text || !knownPlayers.length) return [];

  const found = [];
  const seen = new Set();

  for (const canonical of knownPlayers) {
    if (seen.has(canonical)) continue;
    const lastName = _playerLastName(canonical);
    if (lastName.length < 4) continue; // too ambiguous

    const re = new RegExp(
      `\\b${lastName.replace(/[-]/g, "\\-")}\\b`,
      "i"
    );
    const m = re.exec(text);
    if (m) {
      found.push({ pos: m.index, canonical });
      seen.add(canonical);
    }
  }

  found.sort((a, b) => a.pos - b.pos);
  return found.map((f) => f.canonical);
}

async function loadNews() {
  clearTimeout(_newsRefreshTimer);
  try {
    const res = await fetch("/api/news");
    if (!res.ok) throw new Error(`news API ${res.status}`);
    const data = await res.json();

    // Build the deduplicated list of canonical player names from the props
    // already loaded into state.records. This mirrors what server.py does with
    // _prev_snapshot, but works client-side without shared Netlify state.
    const knownPlayers = [
      ...new Map(
        state.records.map((r) => [r.player, r.player])
      ).values(),
    ];

    // Annotate each item with matched players (client-side, stateless-safe)
    const items = (data.items || []).map((item) => ({
      ...item,
      players: _matchPlayersInText(item.text || "", knownPlayers),
    }));

    // Only show items where at least one active player was found,
    // matching the server.py filter: result = {"items": [i for i in items_out if i["players"]]}
    renderTicker(items.filter((i) => i.players.length > 0));
  } catch (err) {
    console.warn("[ticker] news load failed:", err);
    // Keep existing ticker content; don't blank it on error
  } finally {
    // Refresh every 5 minutes
    _newsRefreshTimer = setTimeout(loadNews, 5 * 60_000);
  }
}

// ---------- event wiring ----------

document.querySelectorAll(".seg-btn").forEach((btn) => {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
});

searchInput.addEventListener("input", (e) => {
  state.search = e.target.value;
  renderBoard();
});

// Sort toggle — initialize aria-pressed from persisted state, then wire clicks
document.querySelectorAll(".sort-btn").forEach((btn) => {
  btn.setAttribute("aria-pressed", String(btn.dataset.sort === state.sortBy));
  btn.addEventListener("click", () => setSortBy(btn.dataset.sort));
});


matchSelect.addEventListener("change", (e) => {
  state.matchFilter = e.target.value;
  renderBoard();
});

boardList.addEventListener("click", (e) => {
  const starBtn = e.target.closest(".star-toggle");
  const card = e.target.closest(".prop-card");
  if (!card) return;
  const player = card.dataset.player;
  const market = card.dataset.market;

  if (starBtn) {
    e.stopPropagation();
    const key = watchKey(player, market);
    if (state.watchlist.has(key)) state.watchlist.delete(key);
    else state.watchlist.add(key);
    saveWatchlist();
    renderCounts();
    renderBoard();
    return;
  }

  openDetail(player, market);
});

watchList.addEventListener("click", (e) => {
  const row = e.target.closest(".watch-row");
  if (!row) return;
  const player = row.dataset.player;
  const market = row.dataset.market;
  const starBtn = e.target.closest(".star-toggle");

  if (starBtn) {
    e.stopPropagation();
    state.watchlist.delete(watchKey(player, market));
    saveWatchlist();
    renderCounts();
    renderWatchlist();
    return;
  }

  openDetail(player, market);
});

alertsList.addEventListener("click", (e) => {
  const card = e.target.closest(".alert-card");
  if (!card) return;
  openDetail(card.dataset.player, card.dataset.market);
});

compareList.addEventListener("click", (e) => {
  const card = e.target.closest(".alert-card");
  if (!card) return;
  openDetail(card.dataset.player, card.dataset.market);
});

backBtn.addEventListener("click", closeDetail);

detailStar.addEventListener("click", () => {
  const key = watchKey(state.detailKey, state.detailMarket);
  if (state.watchlist.has(key)) state.watchlist.delete(key);
  else state.watchlist.add(key);
  saveWatchlist();
  renderCounts();
  detailStar.setAttribute("data-active", String(state.watchlist.has(key)));
});

detailMarketRow.addEventListener("click", (e) => {
  const chip = e.target.closest(".market-chip");
  if (!chip) return;
  state.detailMarket = chip.dataset.market;
  renderDetail();
});

bookSheetList.addEventListener("click", (e) => {
  const goldenBtn = e.target.closest(".golden-star-btn");
  if (!goldenBtn) return;
  e.preventDefault();
  const book = goldenBtn.dataset.book;
  state.highlightedBook = state.highlightedBook === book ? null : book;
  saveHighlightedBook();
  // Refresh the sheet rows to reflect the new golden state
  openBookSheet("board");
});

booksChip.addEventListener("click", () => openBookSheet("board"));
alertBooksChip.addEventListener("click", () => openBookSheet("alerts"));
compareBooksChip.addEventListener("click", () => openBookSheet("compare"));
scrim.addEventListener("click", closeBookSheet);
booksDoneBtn.addEventListener("click", closeBookSheet);

booksAllBtn.addEventListener("click", () => {
  bookSheetList.querySelectorAll("input").forEach((i) => (i.checked = true));
});
booksNoneBtn.addEventListener("click", () => {
  bookSheetList.querySelectorAll("input").forEach((i) => (i.checked = false));
});

alertThresholdInput.value = state.alertThresholdPct;
alertThresholdInput.addEventListener("change", () => {
  const value = Number(alertThresholdInput.value);
  state.alertThresholdPct = Number.isFinite(value) && value >= 0 ? value : 0;
  alertThresholdInput.value = state.alertThresholdPct;
  saveAlertThreshold();
});

compareThresholdInput.value = state.compareThresholdPct;
compareThresholdInput.addEventListener("change", () => {
  const value = Number(compareThresholdInput.value);
  state.compareThresholdPct = Number.isFinite(value) && value >= 0 ? value : 0;
  compareThresholdInput.value = state.compareThresholdPct;
  saveCompareThreshold();
  refreshBookGaps();
  renderCounts();
  renderCompare();
});

setInterval(updateStatusLine, 1000);
renderCounts();
loadProps();
loadNews();

// ---------- ticker click handling ----------

tickerInner.addEventListener("click", (e) => {
  const chip = e.target.closest(".ticker-player-chip");
  if (!chip) return;
  const player = chip.dataset.player;
  if (!player) return;
  const first = state.records.find((r) => r.player === player);
  if (!first) return;
  // Switch to board screen if we're elsewhere
  if (!screenBoard.getAttribute("data-active")) {
    closeDetail();
  }
  openDetail(player, first.market);
});

tickerInner.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const chip = e.target.closest(".ticker-player-chip");
  if (!chip) return;
  e.preventDefault();
  chip.click();
});
