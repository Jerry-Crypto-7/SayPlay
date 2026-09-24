"""Dávka: podstatná jména, která katalog nemá, vygenerovat na kartě dopředu.

    uv run batch.py --derive                                   # přepíše evals/gen3d/batch-nouns.txt
    uv run batch.py --from ../../evals/gen3d/batch-nouns.txt --limit 30 --max-minutes 9

Předpoklad: ComfyUI běží na 127.0.0.1:8188 (README). Po každém slově se zapíše
`evals/gen3d/batch.json`, takže přerušená dávka pokračuje tam, kde skončila; slovo
v cache ani slovo už jednou zapsané (i neúspěšné) se znovu negeneruje. Hotový model
jde do karantény přes `scripts/assets/import-external.mjs` – do katalogu ho zařadí
až člověk po QA.
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import subprocess
import time
from collections.abc import Callable
from datetime import date
from pathlib import Path

import cache

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
NOUNS_FILE = ROOT / "evals/gen3d/batch-nouns.txt"
RECORD_FILE = ROOT / "evals/gen3d/batch.json"
SHEET_FILE = ROOT / "evals/gen3d/batch-sheet.png"
QUARANTINE_DIR = ROOT / "asset-quarantine"
LICENSE = "LicenseRef-Worldsmith-Generated"
OBJECT_SLOTS = {"role", "hero", "any"}  # „setting“ je prostředí, ne jeden model
# Spojky, slovesa, přídavná jména, žánry, místa a cizí značky – seznam s důvody v souboru.
NOT_NOUNS = {
    word
    for line in (HERE / "not-nouns.txt").read_text(encoding="utf-8").splitlines()
    if not line.startswith("#")
    for word in line.split()
}


def _tokens(text: str) -> list[str]:
    return re.findall(r"[a-z]+", text.lower())


def _singular(word: str) -> str:
    try:
        return cache.normalize(word)
    except cache.InvalidNoun:
        return word


def derive_nouns(
    demand: list[dict], fidelity: dict, catalog: dict
) -> list[tuple[str, int]]:
    """(slovo, v kolika větách padlo) pro věci, které katalog nemá jako tag; od nejčastějšího."""
    texts = list(dict.fromkeys(s["text"] for s in [*demand, *fidelity["sentences"]]))
    phrases = {
        _singular(item["item"])
        for sentence in fidelity["sentences"]
        for item in sentence["checklist"]
        if item["slot"] in OBJECT_SLOTS
    }
    settings = {
        _singular(item["item"])
        for sentence in fidelity["sentences"]
        for item in sentence["checklist"]
        if item["slot"] == "setting"
    }
    tags = {_singular(tag) for asset in catalog["assets"] for tag in asset["tags"]}

    counts: collections.Counter[str] = collections.Counter()
    for text in texts:
        words = [_singular(t) for t in _tokens(text)]
        found = {w for w in words if len(w) > 2 and w not in NOT_NOUNS}
        joined = f" {' '.join(words)} "
        multiword = {p for p in phrases if " " in p and f" {p} " in joined}
        found -= {w for p in multiword for w in p.split()}  # „space marine“, ne „space“
        counts.update(found | multiword)
    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return [(noun, n) for noun, n in ranked if noun not in tags | settings]


def write_nouns(counted: list[tuple[str, int]], path: Path = NOUNS_FILE) -> None:
    lines = [
        "# Věci z evals/play/demand a evals/play/fidelity, které src/assets/catalog.json nemá jako tag.",
        "# Pořadí podle počtu vět, ve kterých padly (číslo v komentáři). Generuje `batch.py --derive`.",
        *(f"{noun}  # {n}" for noun, n in counted),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def load_nouns(path: Path) -> list[str]:
    nouns = []
    for line in path.read_text(encoding="utf-8").splitlines():
        noun = line.split("#", 1)[0].strip()
        if noun:
            nouns.append(noun)
    return nouns


def _save(records: dict[str, dict], path: Path) -> None:
    body = {"measuredAt": date.today().isoformat(), "records": list(records.values())}
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(body, indent=2), encoding="utf-8")
    temporary.replace(path)  # přerušení uprostřed zápisu nesmí záznam rozbít


def run_batch(
    nouns: list[str],
    limit: int,
    generate: Callable[[str, Path], dict],
    record_path: Path = RECORD_FILE,
    cache_root: Path | None = None,
    quarantine: Callable[[str, dict], str] | None = None,
    deadline: float | None = None,
) -> list[dict]:
    """Projde prvních `limit` slov; vrátí jejich záznamy v pořadí seznamu."""
    records: dict[str, dict] = {}
    if record_path.exists():
        saved = json.loads(record_path.read_text(encoding="utf-8"))
        records = {r["noun"]: r for r in saved["records"]}

    selected = []
    for raw in nouns:
        try:
            noun = cache.normalize(raw)
        except cache.InvalidNoun:
            continue
        if noun not in selected:
            selected.append(noun)
        if len(selected) == limit:
            break

    for noun in selected:
        if noun in records:
            continue
        if deadline is not None and time.monotonic() > deadline:
            break
        hit = cache.lookup(noun, cache_root)
        started = time.perf_counter()
        record: dict = {"noun": noun}
        if hit and Path(hit["lod0"]).exists():
            result, record["cached"] = hit, True
        else:
            try:
                out_dir = cache.entry_dir(noun, cache_root)
                result = cache.store(noun, generate(noun, out_dir), cache_root)
            except Exception as error:  # noqa: BLE001 – slovo se zapíše jako failed a dávka jede dál
                result = None
                record["reason"] = f"{type(error).__name__}: {error}"[:500]
                preview = cache.entry_dir(noun, cache_root) / f"{cache.slug(noun)}.png"
                if preview.exists():
                    record["preview"] = str(preview)
        record["seconds"] = round(time.perf_counter() - started, 1)
        if result is not None:
            record.update(
                verdict="passed" if result["gate"]["passed"] else "failed",
                glb=result["lod0"],
                preview=result["preview"],
            )
            if quarantine is not None and result["gate"]["passed"]:
                record["quarantine"] = quarantine(noun, result)
        else:
            record["verdict"] = "failed"
        records[noun] = record
        _save(records, record_path)

    return [records[n] for n in selected if n in records]


def provenance(noun: str) -> str:
    import tomllib

    config = tomllib.loads((HERE / "config.toml").read_text(encoding="utf-8"))
    image = {
        "klein": "FLUX.2-klein-4B (Apache-2.0)",
        "zimage": "Z-Image-Turbo (Apache-2.0)",
    }[config["image_model"]]
    install = json.loads(
        (ROOT / "evals/gen3d/install.json").read_text(encoding="utf-8")
    )
    return (
        f"Generated locally on an RTX 3090 by ops/gen3d: {image} image from the prompt "
        f"{config['prompt'].format(noun=noun)!r} -> BiRefNet (MIT) background removal -> "
        f"TRELLIS.2-4B bf16 (MIT) with DINOv3 ViT-L image encoder (DINOv3 License) via "
        f"ComfyUI {install['comfy']['version']} (GPL-3.0, local tool, not distributed) -> "
        f"Blender 5.1 finishing -> gltfpack 1.2.0 (MIT)."
    )


def quarantine_package(noun: str, result: dict) -> str:
    """Předá model do karantény stejnou cestou jako CC0 modely; vrátí adresář balíku."""
    name = f"gen3d-{cache.slug(noun)}"
    target = QUARANTINE_DIR / name
    if target.exists():
        return str(target)
    folder = Path(result["lod0"]).parent
    source = provenance(noun)
    (folder / "license-evidence.txt").write_text(
        f"{LICENSE}: generated by the project's own pipeline, no third-party asset.\n"
        "Model licences: FLUX.2-klein-4B / Z-Image-Turbo Apache-2.0, TRELLIS.2-4B MIT, "
        "BiRefNet MIT, DINOv3 image encoder under the DINOv3 License (see disclosure.json).\n",
        encoding="utf-8",
    )
    (folder / "source-evidence.txt").write_text(source + "\n", encoding="utf-8")
    metadata = {
        "assetId": name,
        "label": noun,
        "tags": list(dict.fromkeys([noun, *noun.split()])),
        "style": "generated low-poly vertex colour",
        "author": "Worldsmith project – generated by ops/gen3d",
        "source": source,
        "license": LICENSE,
        "licenseEvidence": str(folder / "license-evidence.txt"),
        "sourceEvidence": str(folder / "source-evidence.txt"),
        "importedAt": date.today().isoformat(),
        "metersPerUnit": 1,
        "up": "+Y",
        "front": "+Z",
        "pivot": "bottom-center",
    }
    (folder / "metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/assets/import-external.mjs"),
            result["lod0"],
            str(folder / "metadata.json"),
            name,
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        timeout=120,
    )
    return str(target)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--derive", action="store_true")
    parser.add_argument("--from", dest="source", type=Path, default=NOUNS_FILE)
    parser.add_argument("--limit", type=int, default=30)
    parser.add_argument("--max-minutes", type=float, default=None)
    args = parser.parse_args()

    if args.derive:

        def read(relative: str):
            return json.loads((ROOT / relative).read_text(encoding="utf-8"))

        counted = derive_nouns(
            read("evals/play/demand/corpus.json"),
            read("evals/play/fidelity/corpus.json"),
            read("src/assets/catalog.json"),
        )
        write_nouns(counted)
        print(f"{len(counted)} nouns -> {NOUNS_FILE}")
        return

    from comfy_client import ComfyClient
    from server import generate

    comfy = ComfyClient()
    if not comfy.alive():
        raise SystemExit(
            "ComfyUI is not running on 127.0.0.1:8188 – start it first (README)"
        )
    deadline = time.monotonic() + args.max_minutes * 60 if args.max_minutes else None
    records = run_batch(
        load_nouns(args.source),
        args.limit,
        lambda noun, out_dir: generate(comfy, noun, out_dir),
        quarantine=quarantine_package,
        deadline=deadline,
    )
    subprocess.run(
        [
            "node",
            str(ROOT / "scripts/gen3d/contact-sheet.mjs"),
            str(RECORD_FILE),
            str(SHEET_FILE),
        ],
        cwd=ROOT,
        check=True,
    )
    passed = sum(r["verdict"] == "passed" for r in records)
    print(f"{len(records)}/{args.limit} done, {passed} passed -> {RECORD_FILE}")


if __name__ == "__main__":
    main()
