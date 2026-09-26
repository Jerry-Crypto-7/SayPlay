"""Hlas vypravěče (P29D T11): cíl hry přečtený lokálním Kokoro-82M.

Text → Kokoro (anglicky, hlas `af_heart`, 24 kHz) → `normalize` → Ogg Vorbis
mono. Cache je podle textu: týž cíl se generuje jednou, id je hash textu, takže
Next zná adresu nahrávky i bez odpovědi služby.

Model se načítá líně až v první úloze – testy ani `/health` kartu nepotřebují.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
from loop import encode_ogg, normalize

HERE = Path(__file__).resolve().parent
CACHE_ROOT = HERE / ".voice-cache"
RATE = 24_000
VOICE = "af_heart"
MAX_CHARS = 240
STALE_LOCK_SEC = 3 * 3600
GPU_LOCK = Path("D:/claude/_shared/gpu.lock")

Synthesize = Callable[[str], np.ndarray]


class InvalidText(ValueError):
    pass


def narration(text: str) -> str:
    """Věta k přečtení: bez řídicích znaků, jedna mezera, nejvýš `MAX_CHARS`."""
    clean = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", " ", text)).strip()
    if not clean:
        raise InvalidText("text is empty")
    if len(clean) > MAX_CHARS:
        raise InvalidText(f"text is longer than {MAX_CHARS} characters")
    return clean


def voice_id(text: str) -> str:
    """Id nahrávky = hash hlasu a textu (32 hex); `src/app/api/play/_voice.ts` ho počítá stejně."""
    return hashlib.sha256(f"{VOICE}\n{text}".encode()).hexdigest()[:32]


def cached(voice: str, cache_root: Path = CACHE_ROOT) -> Path | None:
    path = cache_root / f"{voice}.ogg"
    return path if path.exists() else None


def render(text: str, synthesize: Synthesize, cache_root: Path = CACHE_ROOT) -> Path:
    """Vygeneruje a uloží nahrávku; zápis přes dočasný soubor, ať se nikdy nečte napůl."""
    samples = np.asarray(synthesize(text), dtype=np.float32).reshape(-1, 1)
    if samples.size == 0 or float(np.max(np.abs(samples))) < 1e-4:
        raise RuntimeError("the voice model returned silence")
    target = cache_root / f"{voice_id(text)}.ogg"
    partial = target.with_suffix(".part.ogg")
    encode_ogg(normalize(samples, -18.0), partial, rate=RATE, quality=3.0)
    partial.replace(target)
    return target


class GpuLock:
    """Týž zámek jako `D:/claude/_shared/gpu-lock.mjs`: adresář (mkdir je atomický) s `owner.json`."""

    def __init__(
        self, path: Path = GPU_LOCK, poll: float = 5.0, wait_max: float = 900.0
    ):
        self.path, self.poll, self.wait_max = path, poll, wait_max

    def _stale(self) -> bool:
        try:
            owner = json.loads((self.path / "owner.json").read_text(encoding="utf-8"))
            age = time.time() - self.path.stat().st_mtime
            return not _alive(int(owner["pid"])) or age > STALE_LOCK_SEC
        except (OSError, ValueError, KeyError):
            try:
                return time.time() - self.path.stat().st_mtime > 60
            except OSError:
                return False

    def __enter__(self) -> GpuLock:
        started = time.monotonic()
        while True:
            try:
                self.path.mkdir(parents=True)
                (self.path / "owner.json").write_text(
                    json.dumps(
                        {"pid": os.getpid(), "cmd": "ops/audio/server.py voice"}
                    ),
                    encoding="utf-8",
                )
                return self
            except FileExistsError:
                if self._stale():
                    _remove(self.path)
                    continue
                if time.monotonic() - started > self.wait_max:
                    raise TimeoutError("the GPU is busy") from None
                time.sleep(self.poll)

    def __exit__(self, *_: object) -> None:
        _remove(self.path)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _remove(path: Path) -> None:
    for child in path.glob("*"):
        child.unlink(missing_ok=True)
    try:
        path.rmdir()
    except FileNotFoundError:
        pass


def kokoro() -> Synthesize:
    """Skutečný model (skupina `voice`: `uv sync --project ops/audio --group voice`)."""
    from kokoro import (
        KPipeline,
    )

    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M")

    def synthesize(text: str) -> np.ndarray:
        parts = [
            np.asarray(audio, dtype=np.float32)
            for _, _, audio in pipeline(text, voice=VOICE)
        ]
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    return synthesize
