import numpy as np
from seam import horizon_color, seam_blend


def noisy(h: int, w: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    # Hladký gradient zleva doprava + šum: levý a pravý okraj se liší o celý rozsah.
    ramp = np.linspace(0, 255, w)[None, :, None].repeat(h, 0).repeat(3, 2)
    return np.clip(ramp + rng.normal(0, 8, (h, w, 3)), 0, 255).astype(np.uint8)


def wrap_gap(img: np.ndarray) -> float:
    """Průměrný rozdíl posledního a prvního sloupce – šev při obtočení kolem koule."""
    return float(np.abs(img[:, -1].astype(float) - img[:, 0].astype(float)).mean())


def neighbour_gap(img: np.ndarray) -> float:
    """Typický rozdíl sousedních sloupců uvnitř obrazu – s tím se šev srovnává."""
    return float(np.abs(np.diff(img.astype(float), axis=1)).mean())


def test_raw_image_has_a_visible_seam():
    img = noisy(64, 320)
    assert wrap_gap(img) > 100


def test_seam_blend_closes_the_wrap_seam():
    img = noisy(64, 320)
    out = seam_blend(img, band=64)
    assert out.shape == (64, 256, 3)
    assert out.dtype == np.uint8
    assert wrap_gap(out) <= neighbour_gap(out) + 4


def test_seam_blend_keeps_the_middle_untouched():
    img = noisy(64, 320)
    out = seam_blend(img, band=64)
    np.testing.assert_array_equal(out[:, 64:], img[:, 64:256])


def test_seam_blend_on_real_gradient_is_within_four_levels():
    # Bez šumu: šev musí zmizet úplně (≤ 4/255 průměrně, AC T2).
    ramp = (
        np.linspace(0, 255, 320)[None, :, None]
        .repeat(32, 0)
        .repeat(3, 2)
        .astype(np.uint8)
    )
    out = seam_blend(ramp, band=64)
    assert wrap_gap(out) <= 4


def test_horizon_color_averages_the_band_at_the_horizon():
    img = np.zeros((100, 50, 3), np.uint8)
    img[:45] = (10, 20, 200)  # nebe
    img[45:55] = (100, 150, 50)  # horizont
    img[55:] = (5, 5, 5)  # zem
    assert horizon_color(img) == (100, 150, 50)
