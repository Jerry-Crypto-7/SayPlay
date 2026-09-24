"""Měření: podstatné jméno -> obrázek -> TRELLIS.2 -> GLB na RTX 3090, pro oba obrazové modely.

Předpoklad: ComfyUI běží na 127.0.0.1:8188 (viz README). Každé slovo se zapíše,
i když selže; první volání po uvolnění modelů je studený start a do teplých
percentilů se nepočítá.

    uv run bench.py --nouns ../../evals/gen3d/bench-nouns.txt
"""

from __future__ import annotations

import argparse
import copy
import json
import math
import shutil
import subprocess
import threading
import time
import tomllib
import urllib.request
from collections.abc import Callable
from datetime import date
from pathlib import Path

import trimesh

from comfy_client import ComfyClient, outputs_of

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
WORKFLOWS = HERE / "workflows" / "text_to_glb.json"
REPORT = REPO_ROOT / "evals" / "gen3d" / "bench.json"
WORK_DIR = Path("D:/claude/_gen3d-bench")
IMAGE_MODELS = ("zimage", "klein")
STAGES = ("imageS", "meshS", "finishS", "totalS")
MAX_TRIS = 5000
PROMPT = tomllib.loads((HERE / "config.toml").read_text(encoding="utf-8"))["prompt"]


def load_nouns(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


def percentile(values: list[float], p: float) -> float | None:
    """Nejbližší pořadí – vrací skutečně naměřenou hodnotu, ne interpolaci."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def bench_model(model: str, nouns: list[str], run: Callable[[str], dict]) -> list[dict]:
    records = []
    for index, noun in enumerate(nouns):
        record = {"imageModel": model, "noun": noun, "cold": index == 0}
        started = time.perf_counter()
        try:
            record.update(run(noun))
            record["ok"] = True
        except Exception as error:  # noqa: BLE001 – selhání je naměřená hodnota, ne pád měření
            record["ok"] = False
            record["error"] = f"{type(error).__name__}: {error}"
        record["totalS"] = round(time.perf_counter() - started, 2)
        records.append(record)
        print(json.dumps(record), flush=True)
    return records


def summarize(records: list[dict]) -> dict:
    summary = {}
    for model in dict.fromkeys(r["imageModel"] for r in records):
        runs = [r for r in records if r["imageModel"] == model]
        warm = [r for r in runs if r["ok"] and not r["cold"]]
        cold = next((r for r in runs if r["cold"]), None)
        summary[model] = {
            "runs": len(runs),
            "ok": sum(r["ok"] for r in runs),
            "failed": [r["noun"] for r in runs if not r["ok"]],
            "coldStart": cold,
            "warm": {
                stage: {
                    "n": len(warm),
                    "p50": percentile([r[stage] for r in warm], 50),
                    "p90": percentile([r[stage] for r in warm], 90),
                }
                for stage in STAGES
            },
            "vramPeakMiB": max((r.get("vramPeakMiB", 0) for r in runs), default=0),
            "trisP50": percentile([r["tris"] for r in runs if r["ok"]], 50),
            "glbBytesP50": percentile([r["glbBytes"] for r in runs if r["ok"]], 50),
        }
    return summary


def choose(summary: dict) -> dict:
    """Rychlejší model při srovnatelné úspěšnosti (nejvýš o jedno slovo horší)."""
    best_ok = max(s["ok"] for s in summary.values())
    eligible = {
        m: s
        for m, s in summary.items()
        if s["ok"] >= best_ok - 1 and s["warm"]["totalS"]["p50"]
    }
    model = min(eligible, key=lambda m: eligible[m]["warm"]["totalS"]["p50"])
    other = [m for m in summary if m != model]
    parts = [
        f"{model}: {summary[model]['ok']}/{summary[model]['runs']} ok, warm p50 {summary[model]['warm']['totalS']['p50']} s"
    ]
    parts += [
        f"{m}: {summary[m]['ok']}/{summary[m]['runs']} ok, warm p50 {summary[m]['warm']['totalS']['p50']} s"
        for m in other
    ]
    return {"imageModel": model, "reason": "; ".join(parts)}


class VramSampler:
    """Špička paměti karty přes nvidia-smi (celá karta, včetně cizích procesů)."""

    def __init__(self, interval_s: float = 0.5):
        self.interval_s = interval_s
        self.peak = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    @staticmethod
    def used_mib() -> int:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            check=True,
        )
        return int(out.stdout.split()[0])

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.peak = max(self.peak, self.used_mib())
            self._stop.wait(self.interval_s)

    def __enter__(self) -> VramSampler:
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join()


def free_models(client: ComfyClient) -> None:
    request = urllib.request.Request(
        client.base_url + "/free",
        data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(request, timeout=30).read()
    time.sleep(3)


def gltfpack_simplify(source: Path, target: Path, tris: int) -> None:
    # -sa: bez agresivního režimu gltfpack drží barevné švy a cíl mine o 15–60 %.
    ratio = min(1.0, 0.95 * MAX_TRIS / max(tris, 1))
    npx = shutil.which("npx") or "npx"
    subprocess.run(
        [
            npx,
            "-y",
            "gltfpack@1.2.0",
            "-i",
            str(source),
            "-o",
            str(target),
            "-si",
            f"{ratio:.4f}",
            "-sa",
            "-noq",
        ],
        check=True,
        capture_output=True,
    )


def triangle_count(path: Path) -> int:
    scene = trimesh.load(path, force="scene")
    return sum(len(g.faces) for g in scene.geometry.values())


def make_runner(
    client: ComfyClient, workflows: dict, model: str
) -> Callable[[str], dict]:
    def run(noun: str) -> dict:
        slug = noun.replace(" ", "_")
        with VramSampler() as vram:
            image_graph = copy.deepcopy(workflows[f"image_{model}"])
            image_graph["prompt"]["inputs"]["text"] = PROMPT.format(noun=noun)
            image_graph["save_image"]["inputs"]["filename_prefix"] = (
                f"gen3d-bench/{model}_{slug}"
            )
            started = time.perf_counter()
            entry = client.run(image_graph)
            image_s = time.perf_counter() - started
            image = outputs_of(entry, "save_image")[0]

            mesh_graph = copy.deepcopy(workflows["mesh"])
            mesh_graph["load_image"]["inputs"]["image"] = (
                f"{image.subfolder}/{image.filename} [output]"
            )
            mesh_graph["save_glb"]["inputs"]["filename_prefix"] = (
                f"gen3d-bench/{model}_{slug}"
            )
            started = time.perf_counter()
            entry = client.run(mesh_graph)
            mesh_s = time.perf_counter() - started

        started = time.perf_counter()
        raw = client.download(
            outputs_of(entry, "save_glb")[0], WORK_DIR / f"{model}_{slug}_raw.glb"
        )
        raw_tris = triangle_count(raw)
        final = WORK_DIR / f"{model}_{slug}.glb"
        gltfpack_simplify(raw, final, raw_tris)
        tris = triangle_count(final)
        finish_s = time.perf_counter() - started
        if tris == 0 or tris > MAX_TRIS * 1.05:
            raise ValueError(f"{tris} triangles after simplification (raw {raw_tris})")
        return {
            "imageS": round(image_s, 2),
            "meshS": round(mesh_s, 2),
            "finishS": round(finish_s, 2),
            "rawTris": raw_tris,
            "tris": tris,
            "glbBytes": final.stat().st_size,
            "vramPeakMiB": vram.peak,
        }

    return run


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--nouns", type=Path, default=REPO_ROOT / "evals" / "gen3d" / "bench-nouns.txt"
    )
    parser.add_argument("--models", nargs="+", default=list(IMAGE_MODELS))
    args = parser.parse_args()

    client = ComfyClient()
    if not client.alive():
        raise SystemExit(
            "ComfyUI is not running on 127.0.0.1:8188 – start it first (README)"
        )
    workflows = json.loads(WORKFLOWS.read_text(encoding="utf-8"))
    nouns = load_nouns(args.nouns)
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    free_models(client)
    baseline = VramSampler.used_mib()  # po uvolnění: jen cizí procesy na kartě

    records = []
    for model in args.models:
        free_models(client)  # první slovo každého modelu = studený start
        records += bench_model(model, nouns, make_runner(client, workflows, model))

    summary = summarize(records)
    report = {
        "measuredAt": date.today().isoformat(),
        "gpu": "NVIDIA GeForce RTX 3090 24 GB",
        "vramBaselineMiB": baseline,
        "note": (
            "Cold start = first noun after POST /free unloaded all models; weights may still sit in the OS file cache. "
            "vramPeakMiB is the whole card (nvidia-smi), including vramBaselineMiB used by other processes. "
            "finishS = download + gltfpack -si to <= 5000 triangles; the full finishing pipeline is T3."
        ),
        "prompt": PROMPT,
        "nouns": nouns,
        "models": summary,
        "chosen": choose(summary),
        "runs": records,
    }
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report["chosen"]))


if __name__ == "__main__":
    main()
