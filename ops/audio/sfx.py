"""Zvukové efekty pro PLAY: 18 looků × jump/pickup/hit/win/lose přes MOSS-SoundEffect (8B) lokálně.

Spuštění (GPU je sdílená, proto pod zámkem):
    uv sync --project ops/audio --group sfx
    node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/audio python ops/audio/sfx.py

Model jde do VRAM kvantovaný (`--bits 8` ≈ 9 GB, `--bits 4` ≈ 5 GB), protože kartu sdílí i jiné
stopy. Každý zvuk: model → `trim_silence` → oříznutí na délku události + dozvuk → `normalize`
→ Ogg Vorbis mono ≤ 25 kB. Výstup `public/assets/worldstream/audio/sfx/<look>-<event>.ogg`
a `src/play/audio/sfx-catalog.json`.
"""

from __future__ import annotations

import argparse
import json
import time

import numpy as np
from loop import encode_ogg, normalize, trim_silence
from music import LOOKS, ROOT, register_disclosure

OUT_DIR = ROOT / "public" / "assets" / "worldstream" / "audio" / "sfx"
CATALOG = ROOT / "src" / "play" / "audio" / "sfx-catalog.json"
PUBLIC_PREFIX = "/assets/worldstream/audio/sfx/"
MODEL = "OpenMOSS-Team/MOSS-SoundEffect"
CODEC = "OpenMOSS-Team/MOSS-Audio-Tokenizer"

MOSS = {
    "name": "MOSS-SoundEffect",
    "kind": "model",
    "scope": "tool",
    "source": "https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect with codec https://huggingface.co/OpenMOSS-Team/MOSS-Audio-Tokenizer (code https://github.com/OpenMOSS/MOSS-TTS)",
    "authorOrProvider": "OpenMOSS team and MOSI.AI",
    "license": "Apache-2.0",
    "requiredNotices": [
        "copyright notice and license text if the weights are redistributed (they are not)"
    ],
    "attribution": "MOSS-SoundEffect © OpenMOSS team, MOSI.AI, Apache-2.0",
    "reviewNote": "Generates the per-look sound effects offline (8B, loaded 4-bit nf4 on the shared RTX 3090). Model cards of MOSS-SoundEffect and MOSS-Audio-Tokenizer read via HF API 2026-09-26: both apache-2.0. Only generated audio ships.",
}


def disclose() -> None:
    register_disclosure(
        OUT_DIR,
        "ops/audio/sfx.py",
        "Sound effect generated locally by ops/audio/sfx.py with MOSS-SoundEffect, trimmed and loudness-normalised.",
        MOSS,
    )


MAX_BYTES = 25_000
TARGET_DB = -16.0
FADE_OUT_S = 0.08

# Událost → (popis zvuku, nejdelší délka v s). Délka drží zvuk krátký, i když model přetáhne.
EVENTS: dict[str, tuple[str, float]] = {
    "jump": ("a short springy jump whoosh", 0.6),
    "pickup": ("a bright short collect chime for picking up an item", 0.8),
    "hit": ("a short punchy impact thud when getting hurt", 0.6),
    "win": ("a short triumphant victory jingle", 2.5),
    "lose": ("a short sad descending game over sound", 2.0),
}

# Look → materiál a prostředí, které zvuk zabarví.
FLAVOR: dict[str, str] = {
    "meadow": "grass and birdsong, soft wooden tone",
    "city": "urban street, car horn texture",
    "mall": "shopping mall, glassy electronic tone",
    "supermarket": "supermarket, cash register beep",
    "living_room": "cozy room, soft cushion and wood",
    "factory": "metallic factory machinery clank",
    "forest": "forest, wooden knock and rustling leaves",
    "jungle": "jungle, hollow bamboo and exotic birds",
    "desert": "dry desert sand and wind",
    "beach": "beach, splashy water and seagulls",
    "ocean": "ocean waves and ship bell",
    "underwater": "underwater bubbles, muffled",
    "snow": "snow crunch and icy sparkle",
    "volcano": "rumbling lava and rock",
    "cave": "echoing cave, stone drip",
    "space": "sci-fi synth laser, space",
    "castle": "medieval castle, sword metal and stone",
    "graveyard": "spooky graveyard, eerie ghostly",
}


def prompt(look: str, event: str) -> str:
    return f"{EVENTS[event][0]}, video game sound effect, {FLAVOR[look]}"


def shape(samples: np.ndarray, rate: int, event: str) -> np.ndarray:
    """Ticho pryč, zkrátit na délku události se zeslabením na konci, stejná hlasitost."""
    out = trim_silence(samples, rate=rate)
    if out.shape[0] == 0:
        raise ValueError("model returned silence")
    out = out[: int(EVENTS[event][1] * rate)].copy()
    fade = min(int(FADE_OUT_S * rate), out.shape[0])
    out[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)[:, None]
    return normalize(out, target_db=TARGET_DB)


def load(bits: int, codec_device: str):
    import torch
    from transformers import AutoModel, AutoProcessor, BitsAndBytesConfig

    torch.backends.cuda.enable_cudnn_sdp(False)
    from huggingface_hub import snapshot_download

    # Procesor skládá cesty přes os.path – s id repa na Windows vznikne „Team\Model“; proto lokální složky.
    local = snapshot_download(MODEL)
    processor = AutoProcessor.from_pretrained(
        local, trust_remote_code=True, codec_path=snapshot_download(CODEC)
    )
    processor.audio_tokenizer = processor.audio_tokenizer.to(
        codec_device, dtype=torch.float32 if codec_device == "cpu" else torch.bfloat16
    )
    quant = (
        BitsAndBytesConfig(load_in_8bit=True)
        if bits == 8
        else BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
        )
    )
    model = AutoModel.from_pretrained(
        local,
        trust_remote_code=True,
        attn_implementation="sdpa",
        dtype=torch.bfloat16,
        quantization_config=quant,
        device_map="cuda:0",
    )
    model.eval()
    return processor, model


def generate(processor, model, text: str, seconds: float) -> tuple[np.ndarray, int]:
    import torch

    message = processor.build_user_message(
        ambient_sound=text, tokens=max(8, round(seconds * 12.5))
    )
    batch = processor([[message]], mode="generation")
    with torch.no_grad():
        outputs = model.generate(
            input_ids=batch["input_ids"].to(model.device),
            attention_mask=batch["attention_mask"].to(model.device),
            max_new_tokens=int(seconds * 12.5) + 64,
        )
    audio = processor.decode(outputs)[0].audio_codes_list[0]
    samples = audio.detach().float().cpu().numpy().reshape(-1, 1)
    return samples.astype(np.float32), int(processor.model_config.sampling_rate)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="look id – regenerate just this look")
    parser.add_argument("--bits", type=int, choices=(4, 8), default=8)
    parser.add_argument("--codec-device", default="cuda:0")
    parser.add_argument("--seed", type=int, default=2926)
    parser.add_argument(
        "--disclose-only", action="store_true", help="only rewrite disclosure.json"
    )
    args = parser.parse_args()
    if args.disclose_only:
        disclose()
        return

    import torch

    processor, model = load(args.bits, args.codec_device)
    catalog = (
        json.loads(CATALOG.read_text(encoding="utf-8"))
        if CATALOG.exists()
        else {"sounds": {}}
    )
    for look in [args.only] if args.only else list(LOOKS):
        for event, (_, seconds) in EVENTS.items():
            torch.manual_seed(args.seed)
            started = time.monotonic()
            raw, rate = generate(processor, model, prompt(look, event), seconds + 0.5)
            samples = shape(raw, rate, event)
            target = OUT_DIR / f"{look}-{event}.ogg"
            for quality in (3.0, 2.0, 1.0, 0.0, -1.0):
                size = encode_ogg(samples, target, rate=rate, quality=quality)
                if size <= MAX_BYTES:
                    break
            else:
                raise SystemExit(f"{target.name} stays over {MAX_BYTES} B")
            catalog["sounds"].setdefault(look, {})[event] = PUBLIC_PREFIX + target.name
            print(
                f"{look}-{event}: {size} B, {samples.shape[0] / rate:.2f} s, "
                f"{time.monotonic() - started:.1f} s",
                flush=True,
            )

    catalog = {
        "model": "MOSS-SoundEffect (Apache-2.0)",
        "events": list(EVENTS),
        "sounds": {
            look: catalog["sounds"][look] for look in LOOKS if look in catalog["sounds"]
        },
    }
    CATALOG.write_text(
        json.dumps(catalog, indent=2, separators=(",", ": "), ensure_ascii=False)
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    disclose()


if __name__ == "__main__":
    main()
