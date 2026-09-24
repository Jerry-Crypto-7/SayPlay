"""Dodělávka surového GLB z TRELLIS.2 na stylizovaný herní model.

Blender (úklid, osy, metry, pivot, paleta, jeden materiál) -> gltfpack (LOD0 pod
5 000 trojúhelníků, LOD1) -> náhled PNG -> kontrola kvality.

Pre-existing material, author: project owner, VR Blender Generate
(`scripts/mesh_postprocess.py`, `scripts/optimize_asset.py`, `scripts/lod_generator.py`):
pořadí kroků a dvě úrovně detailu. PyMeshLab, retopologie, UV a zapékání textur
odříznuté; Hunyuan/Tripo/Meshy/Rodin a původní provozní služby se nepoužívají.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path

import quality_gate
import trimesh
from preview import BLENDER, render_preview

HERE = Path(__file__).resolve().parent
FINISH_SCRIPT = HERE / "blender" / "finish_mesh.py"
LOD0_TRIANGLES = 4750  # rezerva pod strop 5 000
LOD1_SHARE = 0.35


def triangle_count(path: Path) -> int:
    scene = trimesh.load(path, force="scene")
    return sum(len(g.faces) for g in scene.geometry.values())


def gltfpack(source: Path, target: Path, ratio: float) -> None:
    """-sa: bez agresivního režimu gltfpack drží barevné švy a cíl mine; -noq: bez rozšíření."""
    npx = shutil.which("npx") or "npx"
    args = [npx, "-y", "gltfpack@1.2.0", "-i", str(source), "-o", str(target), "-noq"]
    if ratio < 1.0:
        args += ["-si", f"{ratio:.4f}", "-sa"]
    subprocess.run(args, check=True, capture_output=True, timeout=120)


def blender_finish(
    raw: Path, clean: Path, source_up: str, height_m: float, colors: int
) -> None:
    result = subprocess.run(
        [
            BLENDER,
            "--background",
            "--factory-startup",
            "--python",
            str(FINISH_SCRIPT),
            "--",
            "--input",
            str(raw),
            "--output",
            str(clean),
            "--source-up",
            source_up,
            "--height",
            str(height_m),
            "--colors",
            str(colors),
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if "GEN3D_FINISH_OK" not in result.stdout or not clean.exists():
        raise RuntimeError(
            f"Blender finishing failed: {result.stdout[-1500:]} {result.stderr[-1500:]}"
        )


def finish(
    raw: Path,
    out_dir: Path,
    name: str,
    source_up: str = "Y",
    height_m: float = 1.0,
    colors: int = 12,
) -> dict:
    """Vrátí cesty k LOD0/LOD1/náhledu a výsledek kontroly kvality (`gate.passed`, `gate.reasons`)."""
    started = time.perf_counter()
    out_dir.mkdir(parents=True, exist_ok=True)
    clean = out_dir / f"{name}-clean.glb"
    lod0, lod1, preview = (
        out_dir / f"{name}-lod0.glb",
        out_dir / f"{name}-lod1.glb",
        out_dir / f"{name}.png",
    )

    blender_finish(raw, clean, source_up, height_m, colors)
    clean_tris = triangle_count(clean)
    gltfpack(clean, lod0, min(1.0, LOD0_TRIANGLES / max(clean_tris, 1)))
    lod0_tris = triangle_count(lod0)
    gltfpack(clean, lod1, min(1.0, LOD1_SHARE * lod0_tris / max(clean_tris, 1)))
    clean.unlink()
    render_preview(lod0, preview)

    return {
        "lod0": str(lod0),
        "lod1": str(lod1),
        "preview": str(preview),
        "triangles": {"lod0": lod0_tris, "lod1": triangle_count(lod1)},
        "gate": quality_gate.check(lod0, expected_height_m=height_m),
        "seconds": round(time.perf_counter() - started, 2),
    }


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser()
    parser.add_argument("raw", type=Path)
    parser.add_argument("out_dir", type=Path)
    parser.add_argument("name")
    parser.add_argument("--source-up", default="Y")
    parser.add_argument("--height", type=float, default=1.0)
    args = parser.parse_args()
    print(
        json.dumps(
            finish(args.raw, args.out_dir, args.name, args.source_up, args.height),
            indent=2,
        )
    )
