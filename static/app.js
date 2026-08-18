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
  detailKey: null,
  detailMarket: null,
};

// Which bookmaker sheet mode is currently open: "board" filters board cards,
// "alerts" filters which books' movements are allowed to generate alerts.
let _bookSheetMode = "board";

let _lastFetchedAt = null;
let _lastStatusPrefix = "Loading…";
let _pollTimer = null;
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

// ---------- helpers ----------

function titleCase(value) {
  return value.replace(/\b\w/g, (c) => c.toUpperCase());
}

function marketLabel(market) {
  return titleCase(market.replace(/_/g, " "));
}

function formatOdds(value) {
  return value === null || value === undefined ? "–" : Number(value).toFixed(2);
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
  return [...rows.values()].sort((a, b) => {
    const p = a.player.localeCompare(b.player);
    return p !== 0 ? p : a.market.localeCompare(b.market);
  });
}

function leagueBooks(league) {
  return uniqueSorted(state.records.filter((r) => r.league === league).map((r) => r.bookmaker));
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
    if (!query) return true;
    return `${r.player} ${r.team}`.toLowerCase().includes(query);
  });
}

function bookCellHtml(book, record, consensus) {
  if (!record) {
    return `
      <div class="book-cell">
        <div class="book-cell-head">${book}</div>
        <div class="pill-row"><span class="price-pill empty">–</span></div>
      </div>
    `;
  }

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
    <div class="book-cell${lineDiff ? " line-diff" : ""}">
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
  const books = [...state.activeBooks].filter((b) => row.books[b]).length
    ? [...state.activeBooks]
    : Object.keys(row.books);

  const consensus = consensusLine(row, books);
  const cells = books.map((book) => bookCellHtml(book, row.books[book], consensus)).join("");

  return `
    <article class="prop-card" data-player="${escapeAttr(row.player)}" data-market="${escapeAttr(row.market)}">
      <div class="prop-card-top">
        <div class="prop-card-meta">
          <p class="prop-name${moved ? " flash" : ""}">${row.player}</p>
          <p class="prop-subline">${row.team ? row.team + " &middot; " : ""}${marketLabel(row.market)}</p>
          <p class="prop-game">vs ${row.game}</p>
        </div>
        ${consensus != null ? `<span class="consensus-chip">Consensus ${consensus.toFixed(1)}</span>` : ""}
        <button type="button" class="star-toggle" data-active="${isStarred}" aria-label="Toggle watchlist">${STAR_OUTLINE}</button>
      </div>
      <div class="book-grid">${cells}</div>
    </article>
  `;
}

function escapeAttr(value) {
  return String(value).replace(/"/g, "&quot;");
}

function renderBoard() {
  const rows = buildGroups(filteredBoardRecords());
  booksChipCount.textContent = state.activeBooks.size;

  if (rows.length === 0) {
    boardList.innerHTML = `<div class="empty-state">No props match your filters.</div>`;
    return;
  }

  boardList.innerHTML = rows.map(propCardHtml).join("");
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
    const summary = `${marketLabel(e.market)} · Best O ${formatOdds(bestOver)} / U ${formatOdds(bestUnder)}`;

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
        <span>${a.player} &middot; ${marketLabel(a.market)}</span>
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
          detail: `Over ${formatOdds(prevOver)} → ${formatOdds(r.over_odds_decimal)} (${pct.toFixed(1)}%)`,
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
          detail: `Under ${formatOdds(prevUnder)} → ${formatOdds(r.under_odds_decimal)} (${pct.toFixed(1)}%)`,
          when: now,
        });
      }
    }
  }
}

// ---------- tabs / counts ----------

function renderCounts() {
  watchCountEl.textContent = state.watchlist.size ? `(${state.watchlist.size})` : "";
  const visibleAlerts = state.alerts.filter((a) => allowedForAlerts(a.book)).length;
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
  if (tab === "alerts") renderAlerts();
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

  const records = state.records.filter((r) => r.player === player && r.league === state.league);
  const markets = uniqueSorted(records.map((r) => r.market));
  if (!markets.includes(state.detailMarket) && markets.length > 0) {
    state.detailMarket = markets[0];
  }

  const marketRecords = records.filter((r) => r.market === state.detailMarket);
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
    .sort((a, b) => a.bookmaker.localeCompare(b.bookmaker))
    .map((r) => {
      const overBest = isBestOver(r) ? " best" : "";
      const underBest = isBestUnder(r) ? " best" : "";
      return `
        <div class="detail-row">
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

  if (mode === "alerts") {
    const books = allBooks();
    bookSheetTitle.textContent = "Alert Bookmakers";
    bookSheetList.innerHTML = books.map((book) => `
      <label class="sheet-check-row">
        <input type="checkbox" value="${escapeAttr(book)}" ${allowedForAlerts(book) ? "checked" : ""}>
        <span>${book}</span>
      </label>
    `).join("");
  } else {
    const books = leagueBooks(state.league);
    bookSheetTitle.textContent = "Bookmakers";
    bookSheetList.innerHTML = books.map((book) => `
      <label class="sheet-check-row">
        <input type="checkbox" value="${escapeAttr(book)}" ${state.activeBooks.has(book) ? "checked" : ""}>
        <span>${book}</span>
      </label>
    `).join("");
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
  clearTimeout(_pollTimer);
  try {
    const response = await fetch("/api/props");
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
    renderCounts();
    renderAlertBooksChip();
    if (state.tab === "watch") renderWatchlist();
    if (state.tab === "alerts") renderAlerts();
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
    _pollTimer = setTimeout(loadProps, 30_000);
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

booksChip.addEventListener("click", () => openBookSheet("board"));
alertBooksChip.addEventListener("click", () => openBookSheet("alerts"));
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

setInterval(updateStatusLine, 1000);
renderCounts();
loadProps();
