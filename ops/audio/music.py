"""Knihovna hudebních smyček pro PLAY: 18 looků × klidná/napjatá přes ACE-Step 1.5 ve sdíleném ComfyUI.

Spuštění (GPU je sdílená, proto pod zámkem):
    node D:/claude/_shared/gpu-lock.mjs -- uv run --project ops/audio python ops/audio/music.py

Každá smyčka: ~16 s z modelu → `loop_crossfade` (2 s) → `normalize` → Ogg Vorbis ≤ 300 kB.
Výstup: `public/assets/worldstream/audio/music/<look>-<mood>.ogg` a `src/play/audio/music-catalog.json`.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops" / "gen3d"))

from comfy_client import ComfyClient, OutputFile
from loop import (
    decode,
    edge_gap_db,
    encode_ogg,
    loop_crossfade,
    normalize,
)

OUT_DIR = ROOT / "public" / "assets" / "worldstream" / "audio" / "music"
CATALOG = ROOT / "src" / "play" / "audio" / "music-catalog.json"
PUBLIC_PREFIX = "/assets/worldstream/audio/music/"

MAX_BYTES = 300_000
MAX_TOTAL = 12_000_000
CLIP_S = 16
FADE_S = 2.0
MAX_SEAM_DB = 3.0
SEAM_TRIES = 6

# Popis nálady pro každý look (tagy ACE-Step), tempo a tónina. Pořadí = `LOOK_IDS`.
LOOKS: dict[str, tuple[str, int, str]] = {
    "meadow": (
        "acoustic guitar, flute, pastoral, sunny, light percussion",
        104,
        "G major",
    ),
    "city": ("lo-fi hip hop, electric piano, urban, soft drums, bass", 92, "A minor"),
    "mall": ("bossa nova, muzak, vibraphone, upbeat lounge", 110, "F major"),
    "supermarket": ("cheerful retro jingle, xylophone, bouncy bass", 120, "C major"),
    "living_room": (
        "cozy jazz, upright bass, brushed drums, warm piano",
        88,
        "D major",
    ),
    "factory": (
        "industrial, metallic percussion, synth bass, mechanical rhythm",
        116,
        "E minor",
    ),
    "forest": ("folk, harp, woodwinds, strings, mysterious woodland", 96, "D minor"),
    "jungle": ("tribal drums, marimba, pan flute, tropical adventure", 112, "A minor"),
    "desert": ("middle eastern, oud, darbuka, hot wind", 100, "D minor"),
    "beach": ("surf rock, ukulele, steel drums, summer", 118, "E major"),
    "ocean": ("sea shanty, accordion, strings, waves, adventure", 108, "G minor"),
    "underwater": (
        "ambient, dreamy synth pads, bubbling arpeggio, calm",
        80,
        "F major",
    ),
    "snow": ("winter, celesta, sleigh bells, soft strings", 96, "B minor"),
    "volcano": ("epic orchestral, taiko drums, low brass, heat", 124, "C minor"),
    "cave": ("dark ambient, dripping echoes, low drones, mallets", 84, "E minor"),
    "space": ("synthwave, arpeggiator, cosmic pads, retro sci-fi", 110, "A minor"),
    "castle": ("medieval, lute, recorder, harpsichord, fanfare", 100, "D major"),
    "graveyard": (
        "spooky, pipe organ, theremin, pizzicato strings, halloween",
        90,
        "C minor",
    ),
}

MOODS: dict[str, tuple[str, int]] = {
    "calm": ("calm, relaxed, gentle, game background music, instrumental, loopable", 0),
    "tense": (
        "tense, energetic, driving, urgent, game action music, instrumental, loopable",
        24,
    ),
}


def workflow(tags: str, bpm: int, keyscale: str, seed: int) -> dict:
    """Workflow z blueprintu `Text to Audio (ACE-Step 1.5)` v API formátu ComfyUI."""
    return {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": "acestep_v1.5_turbo.safetensors",
                "weight_dtype": "default",
            },
        },
        "2": {
            "class_type": "ModelSamplingAuraFlow",
            "inputs": {"model": ["1", 0], "shift": 3},
        },
        "3": {
            "class_type": "DualCLIPLoader",
            "inputs": {
                "clip_name1": "qwen_0.6b_ace15.safetensors",
                "clip_name2": "qwen_1.7b_ace15.safetensors",
                "type": "ace",
            },
        },
        "4": {
            "class_type": "TextEncodeAceStepAudio1.5",
            "inputs": {
                "clip": ["3", 0],
                "tags": tags,
                "lyrics": "",
                "seed": seed,
                "bpm": bpm,
                "duration": CLIP_S,
                "timesignature": "4",
                "language": "en",
                "keyscale": keyscale,
                "generate_audio_codes": True,
                "cfg_scale": 2,
                "temperature": 0.85,
                "top_p": 0.9,
                "top_k": 0,
                "min_p": 0,
            },
        },
        "5": {
            "class_type": "ConditioningZeroOut",
            "inputs": {"conditioning": ["4", 0]},
        },
        "6": {
            "class_type": "EmptyAceStep1.5LatentAudio",
            "inputs": {"seconds": CLIP_S, "batch_size": 1},
        },
        "7": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["2", 0],
                "positive": ["4", 0],
                "negative": ["5", 0],
                "latent_image": ["6", 0],
                "seed": seed,
                "steps": 8,
                "cfg": 1,
                "sampler_name": "euler",
                "scheduler": "simple",
                "denoise": 1,
            },
        },
        "8": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": "ace_1.5_vae.safetensors"},
        },
        "9": {
            "class_type": "VAEDecodeAudio",
            "inputs": {"samples": ["7", 0], "vae": ["8", 0]},
        },
        "10": {
            "class_type": "SaveAudio",
            "inputs": {"audio": ["9", 0], "filename_prefix": "worldsmith_music/loop"},
        },
    }


def saved_audio(entry: dict) -> OutputFile:
    for item in entry.get("outputs", {}).get("10", {}).get("audio", []):
        return OutputFile(
            item["filename"], item.get("subfolder", ""), item.get("type", "output")
        )
    raise RuntimeError("SaveAudio returned no file")


def render(
    client: ComfyClient, look: str, mood: str, seed: int, scratch: Path
) -> tuple[bytes, float]:
    """Jedna smyčka: model → prolnutí → hlasitost → ogg (kvalita dolů, dokud se nevejde)."""
    tags, bpm, keyscale = LOOKS[look]
    mood_tags, bpm_boost = MOODS[mood]
    entry = client.run(
        workflow(f"{tags}, {mood_tags}", bpm + bpm_boost, keyscale, seed)
    )
    raw = client.download(saved_audio(entry), scratch / f"{look}-{mood}.flac")
    samples = normalize(loop_crossfade(decode(raw), fade_s=FADE_S))
    target = OUT_DIR / f"{look}-{mood}.ogg"
    for quality in (2.0, 1.0, 0.0, -1.0):
        size = encode_ogg(samples, target, quality=quality)
        if size <= MAX_BYTES:
            return target.read_bytes(), edge_gap_db(samples)
    raise RuntimeError(f"{target.name} stays over {MAX_BYTES} B")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="look id – regenerate just this look")
    parser.add_argument("--seed", type=int, default=2926)
    parser.add_argument(
        "--disclose-only", action="store_true", help="only rewrite disclosure.json"
    )
    args = parser.parse_args()
    if args.disclose_only:
        register_disclosure()
        return

    client = ComfyClient()
    if not client.alive():
        raise SystemExit("ComfyUI on :8188 is not running")
    catalog = (
        json.loads(CATALOG.read_text(encoding="utf-8"))
        if CATALOG.exists()
        else {"loops": {}}
    )
    looks = [args.only] if args.only else list(LOOKS)
    with tempfile.TemporaryDirectory() as tmp:
        for index, look in enumerate(looks):
            for mood in MOODS:
                started = time.monotonic()
                # Šev nad 3 dB je slyšet jako skok hlasitosti – zkusit další seed.
                for attempt in range(SEAM_TRIES):
                    seed = args.seed + index * 7 + len(mood) + attempt * 1000
                    data, gap = render(client, look, mood, seed, Path(tmp))
                    if gap <= MAX_SEAM_DB:
                        break
                else:
                    raise SystemExit(
                        f"{look}-{mood}: seam {gap:.2f} dB after {SEAM_TRIES} seeds"
                    )
                elapsed = time.monotonic() - started
                catalog["loops"].setdefault(look, {})[mood] = (
                    PUBLIC_PREFIX + f"{look}-{mood}.ogg"
                )
                print(
                    f"{look}-{mood}: {len(data)} B, seam {gap:.2f} dB, {elapsed:.1f} s",
                    flush=True,
                )

    total = sum(p.stat().st_size for p in OUT_DIR.glob("*.ogg"))
    if total > MAX_TOTAL:
        raise SystemExit(f"library is {total} B, over {MAX_TOTAL} B")
    catalog = {
        "model": "ACE-Step 1.5 turbo (Apache-2.0 code, MIT weights)",
        "loopSeconds": CLIP_S - FADE_S,
        "loops": {
            look: catalog["loops"][look] for look in LOOKS if look in catalog["loops"]
        },
    }
    CATALOG.write_text(
        json.dumps(catalog, indent=2, separators=(",", ": "), ensure_ascii=False)
        + "\n",
        encoding="utf-8",
        newline="\n",
    )
    print(f"total {total} B")
    register_disclosure()


def register_disclosure() -> None:
    """Každý soubor v `public/` a model ACE-Step do `disclosure.json` (hook `license-gate`)."""
    path = ROOT / "disclosure.json"
    disclosure = json.loads(path.read_text(encoding="utf-8"))
    public_dir = OUT_DIR.relative_to(ROOT).as_posix()
    records = [
        {
            "name": f"{public_dir}/{file.name}",
            "kind": "asset",
            "firstParty": True,
            "reason": "Music loop generated locally by ops/audio/music.py with ACE-Step 1.5, crossfaded into a seamless loop.",
            "source": "ops/audio/music.py",
            "authorOrProvider": "Worldsmith project – generated by ops/audio",
            "license": "LicenseRef-Worldsmith-Generated",
            "requiredNotices": [
                "No third-party asset notice; generated by the project's own pipeline."
            ],
            "attribution": "Worldsmith generated music, 2026-09-26.",
            "reviewNote": "First-party output of a local generation model whose licence is registered in disclosure.json (tool scope); no downloaded audio.",
            "scope": "prod",
        }
        for file in sorted(OUT_DIR.glob("*.ogg"))
    ]
    model = {
        "name": "ACE-Step 1.5",
        "kind": "model",
        "scope": "tool",
        "source": "https://huggingface.co/Comfy-Org/ace_step_1.5_ComfyUI_files (repack of https://huggingface.co/ACE-Step/Ace-Step1.5; code https://github.com/ace-step/ACE-Step-1.5)",
        "authorOrProvider": "ACE Studio and StepFun (ACE-Step), Comfy Org (repack)",
        "license": "MIT (weights), Apache-2.0 (code and repack)",
        "requiredNotices": [
            "copyright notice and license text if the weights are redistributed (they are not)"
        ],
        "attribution": "ACE-Step 1.5 © ACE Studio and StepFun",
        "reviewNote": "Generates the music loops offline through the local ComfyUI (turbo DiT, qwen 0.6b/1.7b encoders, ace_1.5 VAE). Model cards read via HF API 2026-09-26: Ace-Step1.5 MIT, Comfy-Org repack apache-2.0. Only generated audio ships.",
    }
    disclosure["entries"] = [
        entry
        for entry in disclosure["entries"]
        if entry["name"] != model["name"]
        and not (
            entry["kind"] == "asset" and entry["name"].startswith(f"{public_dir}/")
        )
    ] + [model, *records]
    path.write_text(
        json.dumps(disclosure, indent=2, separators=(",", ": "), ensure_ascii=False)
        + "\n",
        encoding="utf-8",
        newline="\n",
    )


if __name__ == "__main__":
    main()
