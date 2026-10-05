"""Věta prostředí → bezešvé panorama 2:1 na lokální GPU (FLUX.2 klein 4B, Apache-2.0).

Spouštěj přes sdílený zámek:
  node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/env python ops/env/panorama.py \
      --prompt "snowy pine forest" --out <adresář>

Výstup: `<slug>.webp` 2048×1024 (≤ 350 kB), `<slug>-low.webp` 512×256 (≤ 30 kB) a
`<slug>.json` s promptem, seedem, horizontem a časem.
"""

import argparse
import io
import json
import os
import re
import time
from pathlib import Path

import numpy as np
from PIL import Image
from seam import horizon_color, seam_blend

os.environ.setdefault("HF_HOME", "D:/caches/huggingface")

MODEL = "black-forest-labs/FLUX.2-klein-4B"
LICENSE = "generated, FLUX.2 klein 4B, Apache-2.0"
WIDTH, HEIGHT, BAND = 2048, 1024, 256
LOW = (512, 256)
MAX_BYTES, MAX_LOW_BYTES = 350_000, 30_000

# Obraz je obloha kolem hry: horizont uprostřed, žádné postavy ani text.
TEMPLATE = (
    "360 degree equirectangular panorama of {prompt}, wide landscape wrapping around the viewer, "
    "horizon line exactly at the vertical center, open sky in the upper half, "
    "ground in the lower half, soft even daylight, stylized game environment art, "
    "no people, no text, no frame, no border"
)

_pipe = None


def pipeline():
    global _pipe
    if _pipe is None:
        import torch
        from diffusers import Flux2KleinPipeline

        _pipe = Flux2KleinPipeline.from_pretrained(MODEL, torch_dtype=torch.bfloat16)
        # GPU je sdílená: po částech na kartu, zbytek v RAM.
        _pipe.enable_model_cpu_offload()
    return _pipe


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "env"


def encode(img: Image.Image, limit: int) -> bytes:
    """Nejvyšší kvalita WebP, která se vejde do limitu."""
    for quality in range(88, 20, -6):
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=quality, method=6)
        if buf.tell() <= limit:
            return buf.getvalue()
    raise ValueError(f"cannot fit {img.size} into {limit} bytes")


def generate(prompt: str, seed: int = 0) -> np.ndarray:
    import torch

    image = pipeline()(
        prompt=TEMPLATE.format(prompt=prompt),
        width=WIDTH + BAND,
        height=HEIGHT,
        num_inference_steps=4,
        guidance_scale=1.0,
        generator=torch.Generator("cpu").manual_seed(seed),
    ).images[0]
    return seam_blend(np.asarray(image.convert("RGB")), BAND)


def write(
    pixels: np.ndarray,
    out: Path,
    slug: str,
    limit: int = MAX_BYTES,
    low_limit: int = MAX_LOW_BYTES,
) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    img = Image.fromarray(pixels)
    full = encode(img, limit)
    low = encode(img.resize(LOW, Image.Resampling.LANCZOS), low_limit)
    (out / f"{slug}.webp").write_bytes(full)
    (out / f"{slug}-low.webp").write_bytes(low)
    return {
        "bytes": len(full),
        "lowBytes": len(low),
        "horizon": "#%02x%02x%02x" % horizon_color(pixels),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt", required=True)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--slug")
    args = ap.parse_args()

    slug = args.slug or slugify(args.prompt)
    started = time.perf_counter()
    pixels = generate(args.prompt, args.seed)
    seconds = round(time.perf_counter() - started, 1)
    meta = {
        "prompt": args.prompt,
        "seed": args.seed,
        "model": MODEL,
        "license": LICENSE,
        "seconds": seconds,
    }
    meta |= write(pixels, args.out, slug)
    (args.out / f"{slug}.json").write_text(
        json.dumps(meta, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
