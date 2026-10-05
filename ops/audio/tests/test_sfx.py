"""Zvukové efekty (P29D T4): zazní hned, stejně hlasitě, krátce; katalog pokrývá všechny looky a události."""

import json

import numpy as np
from loop import rms_db
from music import LOOKS, ROOT
from sfx import CATALOG, EVENTS, MAX_BYTES, OUT_DIR, TARGET_DB, shape

RATE = 24_000


def late_quiet_blip(delay_s: float = 0.4, level: float = 0.02) -> np.ndarray:
    """Tichý zvuk, který začne až po `delay_s` ticha a trvá 3 s."""
    t = np.arange(int(3 * RATE)) / RATE
    tone = level * np.sin(2 * np.pi * 440 * t)
    return (
        np.concatenate([np.zeros(int(delay_s * RATE)), tone])
        .reshape(-1, 1)
        .astype(np.float32)
    )


def test_shape_starts_at_once_and_is_loud_enough():
    out = shape(late_quiet_blip(), RATE, "jump")
    first_loud = int(np.flatnonzero(np.abs(out[:, 0]) > 0.01)[0])
    assert first_loud < 0.02 * RATE
    assert abs(rms_db(out) - TARGET_DB) < 1.5


def test_shape_caps_length_and_fades_out():
    out = shape(late_quiet_blip(), RATE, "hit")
    assert out.shape[0] <= EVENTS["hit"][1] * RATE
    assert abs(float(out[-1, 0])) < 1e-3


def test_catalog_has_every_event_for_every_look_and_files_fit():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    assert list(catalog["sounds"]) == list(LOOKS)
    disclosed = {
        entry["name"]
        for entry in json.loads((ROOT / "disclosure.json").read_text(encoding="utf-8"))[
            "entries"
        ]
    }
    prefix = OUT_DIR.relative_to(ROOT).as_posix()
    for sounds in catalog["sounds"].values():
        assert set(sounds) == set(EVENTS)
        for url in sounds.values():
            name = url.rsplit("/", 1)[1]
            assert 0 < (OUT_DIR / name).stat().st_size <= MAX_BYTES
            assert f"{prefix}/{name}" in disclosed
    assert "MOSS-SoundEffect" in disclosed
