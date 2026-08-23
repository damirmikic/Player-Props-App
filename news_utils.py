"""
news_utils.py — Prepoznavanje igrača u tekstovima vesti.

Ulaz:  text (str)          – sirovi tekst news itema
       known_players (list) – kanonska lista igrača u "Last F." formatu,
                              npr. ["Jokic N.", "Wembanyama V.", "Clark C."]

Izlaz: lista kanonskih igrača koji su prepoznati u tekstu (bez duplikata,
       sortirana po poziciji prvog pojavljivanja u tekstu).

Algoritam
---------
Za svaki kanonski igrač "Last F.":
  1. Iz kanonskog oblika se ekstraktuje prezime: "Jokic N." → "Jokic"
  2. Case-insensitive pretraga prezimena u tekstu
  3. Provjera da je pronađena reč zaista sama (word boundary) kako bi
     se izbjegla lažna podudaranja (npr. "Clark" ne bi smjelo matchovati
     "Clarksburg")
  4. Za prezimena kraća od 4 karaktera (npr. "Lee", "Kim") — skip,
     previše ambigvitetna bez daljeg konteksta.

Svi igrači koji imaju props u sistemu su kandidati za matching.
"""
from __future__ import annotations

import re


# Prezimena kraća od ove granice su previše ambigvitetna da bi se
# koristila samo za matching u slobodnom tekstu.
_MIN_LAST_NAME_LEN = 4


def _extract_last_name(canonical: str) -> str:
    """
    Iz kanonskog oblika "Last F." (ili "Van Lith H.", "Gilgeous-Alexander S.")
    vrati prezime (sve osim posljednjeg tokena koji je inicijal).

    Primjeri:
      "Jokic N."           → "Jokic"
      "Van Lith H."        → "Van Lith"
      "Gilgeous-Alexander S." → "Gilgeous-Alexander"
    """
    parts = canonical.strip().split()
    if len(parts) < 2:
        return canonical.strip()
    # Zadnji token je inicijal (npr. "N." ili "H.")
    return " ".join(parts[:-1])


def extract_players_from_text(text: str, known_players: list[str]) -> list[str]:
    """
    Vrati listu kanonskih igrača iz `known_players` koji su pronađeni
    u `text`-u, sortiranu po prvom pojavljivanju u tekstu.

    Parameters
    ----------
    text : str
        Sirovi tekst news itema (naslov + content_text).
    known_players : list[str]
        Kanonski igrači u "Last F." formatu.

    Returns
    -------
    list[str]
        Prepoznati igrači bez duplikata, sortovani po prvom pojavljivanju.
    """
    if not text or not known_players:
        return []

    # (pozicija_prvog_pojavljivanja, canonical_name)
    found: list[tuple[int, str]] = []
    seen: set[str] = set()

    for canonical in known_players:
        if canonical in seen:
            continue

        last_name = _extract_last_name(canonical)

        # Preskoči ambigvitetna kratka prezimena
        if len(last_name) < _MIN_LAST_NAME_LEN:
            continue

        # Escape specijalnih regex znakova (npr. crtice u "Gilgeous-Alexander")
        pattern = re.compile(
            r'\b' + re.escape(last_name) + r'\b',
            re.IGNORECASE,
        )

        m = pattern.search(text)
        if m:
            found.append((m.start(), canonical))
            seen.add(canonical)

    # Sortiraj po poziciji prvog pojavljivanja u tekstu
    found.sort(key=lambda x: x[0])
    return [canonical for _, canonical in found]
