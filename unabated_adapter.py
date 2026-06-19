from __future__ import annotations

from dataclasses import asdict, dataclass
from name_utils import to_canonical_name
from decimal import Decimal, ROUND_HALF_UP
import gzip
import json
from urllib.request import Request, urlopen


UNABATED_WNBA_PROPS_URL = "https://content.unabated.com/markets/v2/league/7/propodds.json"
SUPPORTED_MARKETS = {"points", "assists", "rebounds"}
EXCLUDED_BOOKMAKERS = {
    "draftkings pick6",
    "fliff",
    "prizepicks",
    "sleeper",
    "splash sports",
    "underdog fantasy",
}
BET_TYPE_MARKETS = {
    73: "points",
    70: "assists",
    77: "rebounds",
}
SIDE_OVER = "si0"
SIDE_UNDER = "si1"
LEAGUE = "WNBA"


@dataclass(frozen=True)
class PropRecord:
    league: str
    game: str
    team: str
    player: str
    market: str
    line: float
    over_odds_decimal: float | None
    under_odds_decimal: float | None
    bookmaker: str
    kickoff_time: str
    updated_at: str


def american_to_decimal(odds):
    if odds is None:
        return None

    value = Decimal(str(odds))
    if value > 0:
        decimal = Decimal("1") + (value / Decimal("100"))
    else:
        decimal = Decimal("1") + (Decimal("100") / abs(value))

    return float(decimal.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def load_player_props():
    raw = fetch_unabated_props()
    records = parse_unabated_props(raw)
    filtered = [record for record in records if record.market in SUPPORTED_MARKETS]
    return {
        "phase": "Phase 1: Live Unabated WNBA Ingestion",
        "league": LEAGUE,
        "markets": sorted(SUPPORTED_MARKETS),
        "records": [asdict(record) for record in filtered],
        "highlights": build_highlights(filtered),
        "source": UNABATED_WNBA_PROPS_URL,
    }


def fetch_unabated_props():
    request = Request(
        UNABATED_WNBA_PROPS_URL,
        headers={
            "Accept": "application/json",
            "User-Agent": "PlayerPropsApp/0.1",
        },
    )
    with urlopen(request, timeout=15) as response:
        body = response.read()
        if response.headers.get("Content-Encoding") == "gzip" or body.startswith(b"\x1f\x8b"):
            body = gzip.decompress(body)
        return json.loads(body.decode("utf-8-sig"))


def parse_unabated_props(raw):
    people = raw.get("people", {})
    teams = raw.get("teams", {})
    sources = {str(source.get("id")): source for source in raw.get("marketSources", [])}
    records = []

    for odds_key, rows in raw.get("odds", {}).items():
        if not odds_key.startswith("lg7:"):
            continue

        for row in rows:
            market = BET_TYPE_MARKETS.get(row.get("betTypeId"))
            if not market or row.get("periodTypeId") != 1 or row.get("betSubType") is not None:
                continue

            player = player_name(people.get(str(row.get("personId")), {}))
            team = teams.get(str(row.get("teamId")), {})
            game = clean_event_name(row.get("eventName"), row.get("eventId"))
            book_prices = collect_book_prices(row.get("sides") or {}, sources)

            for book_id, price in book_prices.items():
                line = price.get("line")
                if line is None:
                    continue

                source = sources.get(book_id, {})
                bookmaker = source.get("name") or f"Book {book_id}"
                records.append(
                    PropRecord(
                        league=LEAGUE,
                        game=game,
                        team=team.get("abbreviation") or "",
                        player=player,
                        market=market,
                        line=float(line),
                        over_odds_decimal=american_to_decimal(price.get("over")),
                        under_odds_decimal=american_to_decimal(price.get("under")),
                        bookmaker=bookmaker,
                        kickoff_time=row.get("eventStart") or "",
                        updated_at=price.get("updated_at") or "",
                    )
                )

    return records


def collect_book_prices(sides, sources):
    book_prices = {}

    for side_key, books in sides.items():
        side = side_from_key(side_key)
        if not side:
            continue

        for source_key, line in books.items():
            if not is_visible_line(line):
                continue

            book_id = source_key[2:] if source_key.startswith("ms") else str(line.get("marketSourceId"))
            source = sources.get(book_id, {})
            bookmaker = source.get("name") or f"Book {book_id}"
            if bookmaker.lower() in EXCLUDED_BOOKMAKERS:
                continue
            if not source.get("isEnabledForProps", True):
                continue

            current = book_prices.setdefault(book_id, {"line": None, "over": None, "under": None, "updated_at": ""})
            current["line"] = first_number(current["line"], line.get("points"))
            current[side] = line.get("americanPrice")
            current["updated_at"] = max(current["updated_at"], line.get("modifiedOn") or "")

    return book_prices


def side_from_key(side_key):
    if side_key.startswith(f"{SIDE_OVER}:"):
        return "over"
    if side_key.startswith(f"{SIDE_UNDER}:"):
        return "under"
    return None


def is_visible_line(line):
    if line.get("isBlurred"):
        return False
    if line.get("statusId") != 1:
        return False
    if line.get("americanPrice") in (None, -100000, -10000):
        return False
    return True


def first_number(current, candidate):
    if current is not None:
        return current
    if candidate is None:
        return None
    return float(candidate)


def player_name(person):
    preferred = person.get("preferredName")
    first = preferred or person.get("firstName") or ""
    last = person.get("lastName") or ""
    full = f"{first} {last}".strip()
    if not full:
        return "Unknown Player"
    return to_canonical_name(full)


def clean_event_name(event_name, event_id):
    if not event_name:
        return f"Event {event_id}"
    return event_name.replace(" - @ ", " @ ").strip(" -")


def build_highlights(records):
    grouped = {}
    for record in records:
        key = f"{record.player}|{record.market}"
        grouped.setdefault(key, []).append(record)

    highlights = {}
    for key, group in grouped.items():
        over_group = [item for item in group if item.over_odds_decimal is not None]
        under_group = [item for item in group if item.under_odds_decimal is not None]
        highlights[key] = {
            "best_over": highlight_id(max(over_group, key=lambda item: (-item.line, item.over_odds_decimal))) if over_group else None,
            "best_under": highlight_id(max(under_group, key=lambda item: (item.line, item.under_odds_decimal))) if under_group else None,
        }

    return highlights


def highlight_id(record):
    return f"{record.player}|{record.market}|{record.bookmaker}|{record.line}"
