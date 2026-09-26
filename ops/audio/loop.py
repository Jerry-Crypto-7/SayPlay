"""Zvukové úpravy bez GPU: smyčka s prolnutím, hlasitost, ořez ticha, kódování přes ffmpeg.

Vzorky jsou `numpy` pole float32 tvaru (n, kanály) v rozsahu -1..1.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np

RATE = 44_100


def rms_db(samples: np.ndarray) -> float:
    """Hlasitost úseku v dBFS (RMS přes všechny kanály); ticho = -120."""
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    return 20 * np.log10(max(rms, 1e-6))


def loop_crossfade(
    samples: np.ndarray, rate: int = RATE, fade_s: float = 1.0
) -> np.ndarray:
    """Smyčka bez lupnutí: posledních `fade_s` se prolne se začátkem.

    Výstup začíná vzorkem `fade`, končí prolnutím konce do začátku – po
    posledním vzorku přehrávač skočí na první a pokračuje tam, kde prolnutí
    skončilo. Rovnovýkonové prolnutí drží hlasitost i uprostřed přechodu.
    """
    fade = int(fade_s * rate)
    if samples.shape[0] <= 2 * fade:
        raise ValueError("clip is too short for the crossfade")
    t = np.linspace(0.0, np.pi / 2, fade, dtype=np.float64)[:, None]
    head = samples[:fade].astype(np.float64)
    tail = samples[-fade:].astype(np.float64)
    blended = tail * np.cos(t) + head * np.sin(t)
    out = np.concatenate([samples[fade:-fade].astype(np.float64), blended])
    return out.astype(np.float32)


def edge_gap_db(samples: np.ndarray, rate: int = RATE, window_s: float = 0.25) -> float:
    """Rozdíl hlasitosti konce a začátku smyčky v dB – skok, který by ucho slyšelo na švu."""
    window = int(window_s * rate)
    return abs(rms_db(samples[-window:]) - rms_db(samples[:window]))


def seam_jump(samples: np.ndarray) -> float:
    """Skok na švu (poslední → první vzorek) vůči největšímu skoku mezi sousedy uvnitř."""
    inner = float(np.max(np.abs(np.diff(samples, axis=0))))
    return float(np.max(np.abs(samples[0] - samples[-1]))) / max(inner, 1e-9)


def normalize(
    samples: np.ndarray, target_db: float = -18.0, peak: float = 0.95
) -> np.ndarray:
    """RMS na `target_db`, špičky nejvýš `peak` – všechny smyčky a zvuky stejně hlasité."""
    gain = 10 ** ((target_db - rms_db(samples)) / 20)
    out = samples * gain
    top = float(np.max(np.abs(out)))
    if top > peak:
        out = out * (peak / top)
    return out.astype(np.float32)


def trim_silence(
    samples: np.ndarray,
    rate: int = RATE,
    threshold_db: float = -45.0,
    keep_s: float = 0.01,
) -> np.ndarray:
    """Ořízne ticho na začátku a konci (zvuk má zaznít hned po události)."""
    level = np.max(np.abs(samples), axis=1)
    loud = np.flatnonzero(level > 10 ** (threshold_db / 20))
    if loud.size == 0:
        return samples[:0]
    keep = int(keep_s * rate)
    start = max(0, int(loud[0]) - keep)
    end = min(samples.shape[0], int(loud[-1]) + keep + 1)
    return samples[start:end]


def decode(path: Path, rate: int = RATE, channels: int = 2) -> np.ndarray:
    """Libovolný zvukový soubor → float32 (n, kanály) přes ffmpeg."""
    raw = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "f32le",
            "-ac",
            str(channels),
            "-ar",
            str(rate),
            "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).copy()


def encode_ogg(
    samples: np.ndarray, path: Path, rate: int = RATE, quality: float = 2.0
) -> int:
    """Uloží Ogg Vorbis (`-q:a` 0–10); vrátí velikost v bajtech."""
    path.parent.mkdir(parents=True, exist_ok=True)
    channels = samples.shape[1]
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "f32le",
            "-ac",
            str(channels),
            "-ar",
            str(rate),
            "-i",
            "-",
            "-c:a",
            "libvorbis",
            "-q:a",
            str(quality),
            str(path),
        ],
        input=np.ascontiguousarray(samples, dtype=np.float32).tobytes(),
        check=True,
    )
    return path.stat().st_size
