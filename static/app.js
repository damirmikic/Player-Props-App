const state = {
  records: [],
  highlights: {},
  books: [],
  leagues: [],
};

const leagueFilter = document.querySelector("#leagueFilter");
const matchFilter = document.querySelector("#matchFilter");
const playerFilter = document.querySelector("#playerFilter");
const marketFilter = document.querySelector("#marketFilter");
const bookFilter = document.querySelector("#bookFilter");
const selectAllBooks = document.querySelector("#selectAllBooks");
const clearBooks = document.querySelector("#clearBooks");
const searchFilter = document.querySelector("#searchFilter");
const propsHead = document.querySelector("#propsHead");
const propsBody = document.querySelector("#propsBody");
const statusEl = document.querySelector("#status");
const refreshBtn = document.querySelector("#refreshBtn");

let _lastRowStatus = "";
let _lastFetchedAt = null;
let _refreshTimer = null;

function recordKey(record) {
  return `${record.player}|${record.market}|${record.bookmaker}|${record.line}`;
}

function groupKey(record) {
  return `${record.player}|${record.market}`;
}

function titleCase(value) {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatOdds(value) {
  return value === null || value === undefined ? "-" : Number(value).toFixed(2);
}

function oddsArrow(delta) {
  if (delta == null) return "";
  return delta > 0
    ? '<span class="move-up">↑</span>'
    : '<span class="move-down">↓</span>';
}

function lineArrow(delta) {
  if (delta == null) return "";
  return delta > 0
    ? '<span class="move-line">↑</span>'
    : '<span class="move-line">↓</span>';
}

function updateStatus() {
  if (!_lastFetchedAt) return;
  const ageSec = Math.floor((Date.now() - _lastFetchedAt) / 1000);
  const ageStr = ageSec < 60
    ? `${ageSec}s ago`
    : `${Math.floor(ageSec / 60)}m ${ageSec % 60}s ago`;
  statusEl.textContent = `${_lastRowStatus} · ${ageStr}`;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function clearSelect(selectEl, firstLabel) {
  selectEl.replaceChildren();
  const option = document.createElement("option");
  option.value = "all";
  option.textContent = firstLabel;
  selectEl.appendChild(option);
}

function addOptions(selectEl, values) {
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    selectEl.appendChild(option);
  }
}

function priceClass(record, side) {
  const highlight = state.highlights[groupKey(record)];
  if (!highlight) return "";

  if (side === "over" && highlight.best_over === recordKey(record)) {
    return "best-over";
  }

  if (side === "under" && highlight.best_under === recordKey(record)) {
    return "best-under";
  }

  return "";
}

function renderLeagues(leagues) {
  const current = leagueFilter.value;
  leagueFilter.replaceChildren();
  for (const league of leagues) {
    const option = document.createElement("option");
    option.value = league;
    option.textContent = league;
    leagueFilter.appendChild(option);
  }
  if (leagues.includes(current)) {
    leagueFilter.value = current;
  } else if (leagues.length > 0) {
    leagueFilter.value = leagues[0];
  }
}

function renderMarkets(markets) {
  const current = marketFilter.value;
  clearSelect(marketFilter, "All markets");
  for (const market of markets) {
    const option = document.createElement("option");
    option.value = market;
    option.textContent = titleCase(market.replace(/_/g, " "));
    marketFilter.appendChild(option);
  }
  if ([...marketFilter.options].some((o) => o.value === current)) {
    marketFilter.value = current;
  }
}

function renderSelectors() {
  const currentLeague = leagueFilter.value;
  const currentMatch = matchFilter.value;
  const currentPlayer = playerFilter.value;
  const leagueRecords = state.records.filter((r) => r.league === currentLeague);

  clearSelect(matchFilter, "All matches");
  clearSelect(playerFilter, "All players");
  addOptions(matchFilter, uniqueSorted(leagueRecords.map((r) => r.game)));
  addOptions(playerFilter, uniqueSorted(leagueRecords.map((r) => r.player)));

  if ([...matchFilter.options].some((o) => o.value === currentMatch)) matchFilter.value = currentMatch;
  if ([...playerFilter.options].some((o) => o.value === currentPlayer)) playerFilter.value = currentPlayer;
}

function selectedBooks() {
  return [...bookFilter.querySelectorAll("input[type='checkbox']:checked")].map(
    (input) => input.value
  );
}

function renderBookFilters() {
  const currentLeague = leagueFilter.value;
  const unchecked = new Set(
    [...bookFilter.querySelectorAll("input[type='checkbox']:not(:checked)")].map((i) => i.value)
  );
  const hadState = bookFilter.querySelector("input") !== null;

  const leagueBooks = uniqueSorted(
    state.records
      .filter((r) => r.league === currentLeague)
      .map((r) => r.bookmaker)
  );

  bookFilter.replaceChildren();
  for (const book of leagueBooks) {
    const label = document.createElement("label");
    label.className = "check-row";
    const checked = !hadState || !unchecked.has(book);
    label.innerHTML = `
      <input type="checkbox" value="${book}" ${checked ? "checked" : ""}>
      <span>${book}</span>
    `;
    bookFilter.appendChild(label);
  }
}

function filteredRecords() {
  const selectedLeague = leagueFilter.value;
  const selectedMatch = matchFilter.value;
  const selectedPlayer = playerFilter.value;
  const selectedMarket = marketFilter.value;
  const activeBooks = selectedBooks();
  const query = searchFilter.value.trim().toLowerCase();

  return state.records.filter((record) => {
    const leagueMatch = record.league === selectedLeague;
    const matchMatch = selectedMatch === "all" || record.game === selectedMatch;
    const playerMatch = selectedPlayer === "all" || record.player === selectedPlayer;
    const marketMatch = selectedMarket === "all" || record.market === selectedMarket;
    const bookMatch = activeBooks.includes(record.bookmaker);
    const haystack = `${record.player} ${record.team} ${record.game} ${record.bookmaker}`.toLowerCase();
    return leagueMatch && matchMatch && playerMatch && marketMatch && bookMatch && haystack.includes(query);
  });
}

function comparisonKey(record) {
  // Intentionally excludes game: different sources format game strings differently
  // (Unabated: "Away @ Home", Merkur: "Home team only"). Using player+market
  // as the key ensures they land in the same comparison row.
  return `${record.player}|${record.market}`;
}

function buildComparisonRows(records) {
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
    // Prefer the more descriptive game string (Unabated has full "Away @ Home")
    if (record.game && record.game.length > row.game.length) row.game = record.game;
    // Prefer non-empty team abbreviation (Merkur doesn't carry player team)
    if (!row.team && record.team) row.team = record.team;
    // Prefer non-empty kickoff time
    if (!row.kickoff_time && record.kickoff_time) row.kickoff_time = record.kickoff_time;
    row.books[record.bookmaker] = record;
  }

  return [...rows.values()].sort((a, b) => {
    const playerSort = a.player.localeCompare(b.player);
    if (playerSort !== 0) return playerSort;
    return a.market.localeCompare(b.market);
  });
}

function renderHead() {
  const activeBooks = selectedBooks();

  const bookHeaders = activeBooks
    .map((book) => `<th class="book-head">${book}</th>`)
    .join("");

  propsHead.innerHTML = `
    <tr>
      <th class="sticky-main">Player</th>
      <th>Market</th>
      ${bookHeaders}
    </tr>
  `;
}

function consensusLine(row, activeBooks) {
  const counts = new Map();
  for (const book of activeBooks) {
    const line = row.books[book]?.line;
    if (line !== undefined) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  let best = null, bestCount = 0;
  for (const [line, count] of counts) {
    if (count > bestCount) { best = line; bestCount = count; }
  }
  return best;
}

function renderBookCells(row) {
  const activeBooks = selectedBooks();
  const consensus = consensusLine(row, activeBooks);

  return activeBooks
    .map((book) => {
      const record = row.books[book];
      if (!record) {
        return '<td class="empty book-cell">-</td>';
      }

      const diffClass = record.line !== consensus ? " line-diff" : "";

      return `
        <td class="book-cell">
          <div class="odds-stack">
            <div class="line-val${diffClass}"><span class="line-label">Line</span> ${record.line.toFixed(1)}${lineArrow(record.line_delta)}</div>
            <div class="odds-row">
              <span class="price ${priceClass(record, "over")}">O: ${formatOdds(record.over_odds_decimal)}${oddsArrow(record.over_odds_delta)}</span>
              <span class="price ${priceClass(record, "under")}">U: ${formatOdds(record.under_odds_decimal)}${oddsArrow(record.under_odds_delta)}</span>
            </div>
          </div>
        </td>
      `;
    })
    .join("");
}

function renderRows() {
  const rows = buildComparisonRows(filteredRecords());

  renderHead();
  propsBody.replaceChildren();

  for (const row of rows) {
    const tableRow = document.createElement("tr");
    tableRow.innerHTML = `
      <td class="sticky-main">
        <strong>${row.player}</strong>
        ${row.team ? `<div class="muted">${row.team}</div>` : ""}
        <div class="game-name">vs ${row.game}</div>
        ${row.kickoff_time ? `<div class="muted match-time" style="font-size: 0.8em; margin-top: 2px;">🕒 ${new Date(row.kickoff_time).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</div>` : ""}
      </td>
      <td>${titleCase(row.market.replace(/_/g, " "))}</td>
      ${renderBookCells(row)}
    `;
    propsBody.appendChild(tableRow);
  }

  const league = leagueFilter.value;
  const movedCount = rows.filter((row) =>
    Object.values(row.books).some(
      (r) => r.line_delta != null || r.over_odds_delta != null || r.under_odds_delta != null
    )
  ).length;
  _lastRowStatus =
    `${rows.length} comparisons · ${league}` +
    (movedCount ? ` · ${movedCount} moved` : "");
  updateStatus();
}

function onLeagueChange() {
  // Refresh selectors and book filters for the newly chosen league
  renderSelectors();
  renderBookFilters();
  renderRows();
}

async function loadProps() {
  refreshBtn.disabled = true;
  refreshBtn.classList.add("loading");
  clearTimeout(_refreshTimer);

  try {
    const response = await fetch("/api/props");
    if (!response.ok) throw new Error(`API returned ${response.status}`);

    const payload = await response.json();
    state.records = payload.records;
    state.highlights = payload.highlights;
    state.leagues = payload.leagues || ["WNBA"];
    _lastFetchedAt = Date.now();

    renderLeagues(state.leagues);
    renderMarkets(payload.markets);
    renderSelectors();
    renderBookFilters();
    renderHead();
    renderRows();
  } catch (error) {
    statusEl.textContent = `${_lastRowStatus || "Error"} · unable to refresh`;
    console.error(error);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove("loading");
    _refreshTimer = setTimeout(loadProps, 30_000);
  }
}

function setAllBooks(checked) {
  for (const input of bookFilter.querySelectorAll("input[type='checkbox']")) {
    input.checked = checked;
  }
  renderRows();
}

leagueFilter.addEventListener("change", onLeagueChange);
matchFilter.addEventListener("change", renderRows);
playerFilter.addEventListener("change", renderRows);
marketFilter.addEventListener("change", renderRows);
bookFilter.addEventListener("change", renderRows);
selectAllBooks.addEventListener("click", () => setAllBooks(true));
clearBooks.addEventListener("click", () => setAllBooks(false));
searchFilter.addEventListener("input", renderRows);
refreshBtn.addEventListener("click", loadProps);

setInterval(updateStatus, 1000);
loadProps();
