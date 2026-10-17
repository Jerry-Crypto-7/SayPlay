"""Slepá předkontrola obrázku před TRELLIS (P45E T2).

Obrázek, na kterém FLUX nakreslil sourozence (mole → bear) nebo věc podobného tvaru, by
kartu stál ~40 s sítě a soud čtyř pohledů by ho stejně shodil. Codex dostane jen obrázek
v prázdném adresáři (`scripts/p37d/judge-sheet.mjs --precheck`) a odpověď se porovná se
jménem stejně jako u soudu hotového modelu. Odpovědi leží mimo repo.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
OUT_DIR = Path("D:/caches/p45e/precheck")
ACCEPTED = {"top1", "top3"}


class PrecheckRejected(RuntimeError):
    pass


def check(
    noun: str, image: Path, out_dir: Path = OUT_DIR, judge: str = "codex"
) -> dict:
    """`{"verdict", …}` obrázku, který prošel; `PrecheckRejected`, když by ho soudce shodil.

    Bez odpovědi soudce (limit, pád) vrátí `unavailable` a karta pracuje dál – soud po 3D
    model stejně uvidí. `judge="claude"` (P46F) se ptá Opus 5.5 místo Codexu.
    """
    try:
        run = subprocess.run(
            [
                "node",
                str(ROOT / "scripts/p37d/judge-sheet.mjs"),
                "--precheck",
                str(image),
                "--noun",
                noun,
                "--out",
                str(out_dir),
                "--judge",
                judge,
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        return {"verdict": "unavailable", "error": "precheck timed out after 600 s"}
    lines = run.stdout.strip().splitlines()
    if run.returncode != 0 or not lines:
        return {
            "verdict": "unavailable",
            "error": f"judge exit {run.returncode}: {run.stderr[-300:]}",
        }
    result = json.loads(lines[-1])
    if result["verdict"] in ACCEPTED or result["verdict"] == "unavailable":
        return result
    raise PrecheckRejected(
        f"precheck: image looks like {result['answer']['name']!r} ({result['verdict']})"
    )
