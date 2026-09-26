"""Šev panoramatu a barva horizontu.

Panorama se generuje o `band` pixelů širší, než má být. Pravý přesah se
prolne přes levý okraj a odřízne: poslední ponechaný sloupec pak přirozeně
navazuje na první, protože první je teď tentýž obsah, který v původním obraze
stál hned za ním.
"""

import numpy as np


def seam_blend(img: np.ndarray, band: int) -> np.ndarray:
    """Obraz šířky W + band → obraz šířky W, jehož okraje navazují dokola."""
    h, w, c = img.shape
    width = w - band
    out = img[:, :width].astype(np.float32)
    # t = 0 u levého okraje (plně pravý přesah), 1 na konci pásu (plně originál).
    t = (np.arange(band, dtype=np.float32) / band)[None, :, None]
    out[:, :band] = img[:, :band] * t + img[:, width:] * (1 - t)
    return np.clip(np.rint(out), 0, 255).astype(np.uint8)


def horizon_color(img: np.ndarray, band: float = 0.1) -> tuple[int, int, int]:
    """Průměrná barva pásu kolem horizontu (prostřední `band` výšky)."""
    h = img.shape[0]
    top = int(round(h * (0.5 - band / 2)))
    bottom = int(round(h * (0.5 + band / 2)))
    mean = img[top:bottom].reshape(-1, img.shape[2])[:, :3].astype(np.float64).mean(0)
    r, g, b = (int(round(v)) for v in mean)
    return r, g, b
