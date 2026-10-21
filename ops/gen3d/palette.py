"""Barvy vrcholů: sjednotit do malé palety a vyhnout se fialové (odstín 250–320°).

Jen numpy, aby šel importovat i z Blenderu (`blender/finish_mesh.py`).
"""

from __future__ import annotations

import numpy as np

PURPLE_LO, PURPLE_HI = 250.0, 320.0
MIN_SATURATION = 0.12  # šedé tóny nemají odstín, nechávají se
# Slabě sytá nebo tmavá fialová se mění na čistou šedou, ne posunem odstínu: uložení do GLB
# (lineárně, 8 bitů) tmavou barvu zaokrouhlí na kanály typu 5/4/5 a odstín vrátí na 300°.
# Šedá má kanály shodné, takže ji zaokrouhlení nerozbije.
NEUTRAL_BELOW = 0.3


def rgb_to_hsv(rgb: np.ndarray) -> np.ndarray:
    rgb = np.clip(rgb, 0.0, 1.0)
    mx, mn = rgb.max(axis=1), rgb.min(axis=1)
    delta = mx - mn
    hue = np.zeros(len(rgb))
    nz = delta > 1e-8
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    rmax = nz & (mx == r)
    gmax = nz & (mx == g) & ~rmax
    bmax = nz & ~rmax & ~gmax
    hue[rmax] = ((g - b)[rmax] / delta[rmax]) % 6
    hue[gmax] = (b - r)[gmax] / delta[gmax] + 2
    hue[bmax] = (r - g)[bmax] / delta[bmax] + 4
    sat = np.where(mx > 1e-8, delta / np.maximum(mx, 1e-8), 0.0)
    return np.stack([hue * 60.0, sat, mx], axis=1)


def hsv_to_rgb(hsv: np.ndarray) -> np.ndarray:
    h, s, v = hsv[:, 0] / 60.0, hsv[:, 1], hsv[:, 2]
    i = np.floor(h).astype(int) % 6
    f = h - np.floor(h)
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    table = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]
    out = np.zeros((len(hsv), 3))
    for k, (r, g, b) in enumerate(table):
        m = i == k
        out[m] = np.stack([r[m], g[m], b[m]], axis=1)
    return out


def is_purple(rgb: np.ndarray) -> np.ndarray:
    hsv = rgb_to_hsv(rgb)
    return (
        (hsv[:, 0] >= PURPLE_LO)
        & (hsv[:, 0] <= PURPLE_HI)
        & (hsv[:, 1] >= MIN_SATURATION)
    )


def guard_purple(rgb: np.ndarray) -> np.ndarray:
    """Slabě sytou nebo tmavou fialovou udělá šedou, ostatní posune za okraj s rezervou
    (modrá 235° / červená 335°). Hlídá o 10° širší pásmo, než kontroluje brána."""
    hsv = rgb_to_hsv(rgb)
    mask = (
        (hsv[:, 0] >= PURPLE_LO - 10.0)
        & (hsv[:, 0] <= PURPLE_HI + 10.0)
        & (hsv[:, 1] > 0)
    )
    middle = (PURPLE_LO + PURPLE_HI) / 2
    hsv[mask, 0] = np.where(hsv[mask, 0] < middle, PURPLE_LO - 15.0, PURPLE_HI + 15.0)
    grey = (hsv[:, 1] < NEUTRAL_BELOW) | (hsv[:, 2] < NEUTRAL_BELOW)
    hsv[mask & grey, 1] = 0.0
    out = rgb.copy()
    out[mask] = hsv_to_rgb(hsv[mask])
    return out


def quantize(rgb: np.ndarray, k: int = 10, iterations: int = 12) -> np.ndarray:
    """Deterministický k-means: barvy vrcholů -> nejvýš k barev palety."""
    unique = np.unique(np.round(rgb, 3), axis=0)
    if len(unique) <= k:
        return rgb.copy()
    rng = np.random.default_rng(0)
    centers = [unique[rng.integers(len(unique))]]
    for _ in range(1, k):  # k-means++ výběr středů
        d = np.min(
            ((unique[:, None, :] - np.array(centers)[None]) ** 2).sum(-1), axis=1
        )
        centers.append(
            unique[rng.choice(len(unique), p=d / d.sum())] if d.sum() > 0 else unique[0]
        )
    centers = np.array(centers)
    for _ in range(iterations):
        labels = np.argmin(((rgb[:, None, :] - centers[None]) ** 2).sum(-1), axis=1)
        for j in range(k):
            members = rgb[labels == j]
            if len(members):
                centers[j] = members.mean(axis=0)
    labels = np.argmin(((rgb[:, None, :] - centers[None]) ** 2).sum(-1), axis=1)
    return centers[labels]


ACCENT_RADIUS = (
    0.12  # vrcholy do této vzdálenosti (sRGB) od nejsytější barvy patří k akcentu
)


def with_accent(rgb: np.ndarray, styled: np.ndarray) -> np.ndarray:
    """Profil hero: nejsytější barva modelu jako barva navíc. Drobný jasný detail (oko,
    zobák, knoflík) by k-means zprůměroval do velké okolní plochy."""
    hsv = rgb_to_hsv(rgb)
    seed = rgb[np.argmax(hsv[:, 1] * hsv[:, 2])]
    near = ((rgb - seed) ** 2).sum(axis=1) <= ACCENT_RADIUS**2
    out = styled.copy()
    out[near] = rgb[near].mean(axis=0)
    return out


def stylize(rgb: np.ndarray, k: int = 10, accent: bool = False) -> np.ndarray:
    styled = quantize(rgb, k)
    return guard_purple(with_accent(rgb, styled) if accent else styled)
