"""Knihovna smyček (P29D T3): každý look má klidnou i napjatou smyčku, soubory drží rozpočet a každý je v disclosure."""

import json
import re

from music import CATALOG, LOOKS, MAX_BYTES, MAX_TOTAL, MOODS, OUT_DIR, ROOT


def look_ids() -> list[str]:
    source = (ROOT / "src/play/arcade/look/index.ts").read_text(encoding="utf-8")
    block = source.split("export const LOOK_IDS = [", 1)[1].split("]", 1)[0]
    return re.findall(r"'([a-z_]+)'", block)


def test_generator_covers_every_look():
    assert list(LOOKS) == look_ids()


def test_catalog_has_both_moods_for_every_look_and_files_fit():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    assert list(catalog["loops"]) == look_ids()
    total = 0
    for moods in catalog["loops"].values():
        assert set(moods) == set(MOODS)
        for url in moods.values():
            file = OUT_DIR / url.rsplit("/", 1)[1]
            assert 0 < file.stat().st_size <= MAX_BYTES
            total += file.stat().st_size
    assert total <= MAX_TOTAL


def test_every_loop_file_is_disclosed():
    names = {
        entry["name"]
        for entry in json.loads((ROOT / "disclosure.json").read_text(encoding="utf-8"))[
            "entries"
        ]
    }
    prefix = OUT_DIR.relative_to(ROOT).as_posix()
    assert {f"{prefix}/{f.name}" for f in OUT_DIR.glob("*.ogg")} <= names
    assert "ACE-Step 1.5" in names
