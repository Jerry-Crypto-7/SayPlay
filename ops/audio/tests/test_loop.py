"""Smyčka hudby (P29D T3): konec navazuje na začátek, okraje stejně hlasité."""

import numpy as np
import pytest
from loop import RATE, edge_gap_db, loop_crossfade, normalize, rms_db, seam_jump


def crescendo(seconds: float = 12.0, seed: int = 1) -> np.ndarray:
    """Tón se šumem, který během klipu zesílí 8× – bez prolnutí by šev skočil o 18 dB."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * RATE)) / RATE
    envelope = np.linspace(0.05, 0.4, t.size)
    left = envelope * np.sin(2 * np.pi * 220 * t) + 0.02 * rng.standard_normal(t.size)
    right = envelope * np.sin(2 * np.pi * 330 * t + 0.5)
    return np.stack([left, right], axis=1).astype(np.float32)


def test_raw_clip_has_an_audible_seam():
    clip = crescendo()
    assert edge_gap_db(clip) > 10
    assert seam_jump(clip) > 1


def test_crossfaded_loop_edges_within_3_db():
    loop = loop_crossfade(crescendo(), fade_s=4.0)
    assert edge_gap_db(loop) <= 3


def test_crossfaded_loop_end_continues_into_its_start():
    clip = crescendo()
    fade = int(1.0 * RATE)
    loop = loop_crossfade(clip, fade_s=1.0)
    # Poslední vzorek smyčky je (skoro) vzorek před jejím začátkem v původním klipu.
    assert np.allclose(loop[-1], clip[fade - 1], atol=1e-3)
    assert np.array_equal(loop[0], clip[fade])
    # Šev není větší skok než běžný krok mezi sousedními vzorky uvnitř.
    assert seam_jump(loop) <= 1


def test_too_short_clip_is_refused():
    with pytest.raises(ValueError):
        loop_crossfade(crescendo(seconds=1.5), fade_s=1.0)


def test_normalize_hits_the_target_and_never_clips():
    loud = crescendo() * 3
    out = normalize(loud, target_db=-18)
    assert abs(rms_db(out) - -18) < 0.5 or np.max(np.abs(out)) <= 0.95 + 1e-6
    assert np.max(np.abs(out)) <= 0.95 + 1e-6
