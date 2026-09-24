"""Cache hotových modelů podle normalizovaného podstatného jména.

„Penguins“, „the penguin“ i „Penguin“ vedou na stejný adresář `penguin/`, takže
druhý požadavek nesahá na kartu. Jméno, které po normalizaci není čisté slovo,
se odmítne dřív, než vznikne jakákoli cesta.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

CACHE_ROOT = Path(os.environ.get("GEN3D_CACHE_DIR", "D:/claude/_gen3d-cache"))
ARTICLES = {"a", "an", "the"}
WORD = re.compile(r"^[a-z]+(?: [a-z]+){0,3}$")
MAX_LENGTH = 40
WINDOWS_DEVICES = {"con", "prn", "aux", "nul"}  # com1/lpt1 odmítne už WORD (číslice)


class InvalidNoun(ValueError):
    pass


# Množná čísla, která pravidla níž rozbijí („zombies“ -> „zomby“, „knives“ -> „knive“).
IRREGULAR = {
    "zombies": "zombie",
    "cookies": "cookie",
    "movies": "movie",
    "pies": "pie",
    "ties": "tie",
    "brownies": "brownie",
    "hoodies": "hoodie",
    "goalies": "goalie",
    "shelves": "shelf",
    "wolves": "wolf",
    "knives": "knife",
    "leaves": "leaf",
    "lives": "life",
    "loaves": "loaf",
    "halves": "half",
    "thieves": "thief",
    "elves": "elf",
    "calves": "calf",
    "wives": "wife",
    "mice": "mouse",
    "geese": "goose",
    "teeth": "tooth",
    "feet": "foot",
    "children": "child",
    "people": "person",
    "sheep": "sheep",
    "fish": "fish",
}


def _singular(word: str) -> str:
    if word in IRREGULAR:
        return IRREGULAR[word]
    if word.endswith("men") and len(word) > 4:  # snowmen, firemen
        return word[:-3] + "man"
    if len(word) <= 3 or word.endswith(("ss", "us", "is")):
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    if word.endswith(("ches", "shes", "xes", "zes", "sses")):
        return word[:-2]
    if word.endswith("s"):
        return word[:-1]
    return word


def normalize(noun: str) -> str:
    """Malá písmena, bez členu, jednotné číslo posledního slova; jinak InvalidNoun."""
    words = noun.strip().lower().split()
    if words and words[0] in ARTICLES:
        words = words[1:]
    text = " ".join(words)
    if not text or len(text) > MAX_LENGTH or not WORD.match(text):
        raise InvalidNoun(f"not a plain noun: {noun!r}")
    words[-1] = _singular(words[-1])
    return " ".join(words)


def slug(noun: str) -> str:
    name = normalize(noun).replace(" ", "-")
    if name in WINDOWS_DEVICES:  # adresář `nul/` jde založit, ale nejde do něj psát
        raise InvalidNoun(f"reserved Windows name: {noun!r}")
    return name


def entry_dir(noun: str, root: Path | None = None) -> Path:
    root = (root or CACHE_ROOT).resolve()
    target = (root / slug(noun)).resolve()
    if target.parent != root:  # pojistka navíc k WORD – cesta nikdy mimo cache
        raise InvalidNoun(f"path escapes the cache: {noun!r}")
    return target


def lookup(noun: str, root: Path | None = None) -> dict | None:
    meta = entry_dir(noun, root) / "meta.json"
    if not meta.exists():
        return None
    return json.loads(meta.read_text(encoding="utf-8"))


def store(noun: str, result: dict, root: Path | None = None) -> dict:
    directory = entry_dir(noun, root)
    record = {"noun": normalize(noun), **result}
    (directory / "meta.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record
