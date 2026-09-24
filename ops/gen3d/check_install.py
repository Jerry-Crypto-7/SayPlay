"""Ověří instalaci generování: ComfyUI s TRELLIS.2, váhy, licence, žádný nvdiffrast.

Vypíše OK / REVIEW / FAIL pro každou položku, zapíše velikosti do
evals/gen3d/install.json a skončí 1, když cokoliv selhalo. REVIEW znamená
vlastní licenci modelu, kterou dovoluje komerční použití, ale `RULES.md` §4
ji chce projít ručně – instalaci neshazuje, jde do disclosure.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

from weights import COMFY_DIR, REPOS, snapshot_dir

REPO_ROOT = Path(__file__).resolve().parents[2]
REPORT = REPO_ROOT / "evals" / "gen3d" / "install.json"
MIN_COMFY = (0, 34, 0)

# nvdiffrast a nvdiffrec jsou pod NVIDIA Source Code License (jen nekomerčně).
FORBIDDEN = re.compile(r"^(nvdiffrast\S*|nvdiffrec\S*)$", re.IGNORECASE)
PERMISSIVE = {
    "mit",
    "apache-2.0",
    "bsd-2-clause",
    "bsd-3-clause",
    "isc",
    "cc0-1.0",
    "unlicense",
    "zlib",
}
# Vlastní licence modelů, které dovolují komerční použití; §4 je chce ručně prověřit.
REVIEWED_CUSTOM = {"licenseref-dinov3"}


def forbidden_packages(pip_list: str) -> list[str]:
    found = []
    for line in pip_list.splitlines():
        name = re.split(r"[\s=@]", line.strip(), maxsplit=1)[0]
        if name and FORBIDDEN.match(name):
            found.append(name.lower())
    return found


def license_verdict(license_id: str | None) -> str:
    if not license_id:
        return "FAIL"
    key = license_id.strip().lower()
    if key in PERMISSIVE:
        return "OK"
    if key in REVIEWED_CUSTOM:
        return "REVIEW"
    return "FAIL"


def card_license(card: str) -> str | None:
    match = re.match(r"^---\r?\n(.*?)\r?\n---", card, re.DOTALL)
    if not match:
        return None
    for line in match.group(1).splitlines():
        if line.startswith("license:"):
            return line.split(":", 1)[1].strip()
    return None


def comfy_version() -> tuple[int, ...] | None:
    source = COMFY_DIR / "comfyui_version.py"
    if not source.exists():
        return None
    match = re.search(
        r'__version__\s*=\s*"([\d.]+)"', source.read_text(encoding="utf-8")
    )
    return tuple(int(p) for p in match.group(1).split(".")) if match else None


def comfy_pip_list() -> str:
    python = COMFY_DIR / ".venv" / "Scripts" / "python.exe"
    result = subprocess.run(
        ["uv", "pip", "list", "--python", str(python)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def main() -> int:
    lines: list[tuple[str, str]] = []
    report: dict = {"measuredAt": date.today().isoformat(), "comfy": {}, "weights": []}

    version = comfy_version()
    trellis_nodes = (COMFY_DIR / "comfy_extras" / "nodes_trellis2.py").exists()
    ok = version is not None and version >= MIN_COMFY and trellis_nodes
    lines.append(
        (
            "OK" if ok else "FAIL",
            f"ComfyUI {version} at {COMFY_DIR}, native TRELLIS.2 nodes: {trellis_nodes}",
        )
    )
    report["comfy"] = {
        "version": ".".join(map(str, version or ())),
        "trellis2Nodes": trellis_nodes,
    }

    try:
        bad = forbidden_packages(comfy_pip_list())
        lines.append(
            (
                "FAIL" if bad else "OK",
                f"no nvdiffrast/nvdiffrec in ComfyUI venv (found: {bad or 'none'})",
            )
        )
    except (OSError, subprocess.CalledProcessError) as error:
        lines.append(("FAIL", f"cannot list ComfyUI venv packages: {error}"))

    total = 0
    for repo in REPOS:
        snap = snapshot_dir(repo)
        readme = snap / "README.md"
        repo_license = (
            card_license(readme.read_text(encoding="utf-8"))
            if readme.exists()
            else None
        )
        for w in repo.weights:
            file = snap / w.path
            license_id = w.license_override or repo_license
            verdict = license_verdict(license_id)
            size = file.stat().st_size if file.exists() else 0
            if not file.exists():
                verdict = "FAIL"
            total += size
            lines.append(
                (
                    verdict,
                    f"{repo.repo_id}/{w.path} {size / 1e9:.2f} GB license={license_id}",
                )
            )
            report["weights"].append(
                {
                    "repo": repo.repo_id,
                    "revision": repo.revision,
                    "file": w.path,
                    "bytes": size,
                    "license": license_id,
                    "licenseSource": w.license_source
                    or f"https://huggingface.co/{repo.repo_id}",
                    "verdict": verdict,
                }
            )
    report["totalWeightBytes"] = total

    for verdict, text in lines:
        print(f"{verdict:6} {text}")
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    return 1 if any(v == "FAIL" for v, _ in lines) else 0


if __name__ == "__main__":
    sys.exit(main())
