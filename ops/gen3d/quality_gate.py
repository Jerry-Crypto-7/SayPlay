"""Kontrola kvality hotového modelu: vrátí, jestli prošel, a proč ne.

Pre-existing material, author: project owner, VR Blender Generate
(`scripts/quality_gate.py`: triangle_count, material_count, texture_resolution).
Kontroly kostí, UV a tvarových klíčů vypuštěné – cesta nese barvy ve vrcholech.
Přidané: osy a pivot, rozměr v metrech, fialová, rozšíření glTF (karanténa
`scripts/assets/import-external.mjs` přijímá jen čisté core glTF).
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import trimesh

from palette import is_purple

MAX_TRIANGLES = 5000
MIN_TRIANGLES = 100
MAX_MATERIALS = 2
MAX_TEXTURE_PX = 512
MIN_HEIGHT_M, MAX_HEIGHT_M = 0.05, 20.0
HEIGHT_TOLERANCE = 0.10
PIVOT_TOLERANCE = 0.02
MAX_PURPLE_SHARE = 0.01


COMPONENTS = {
    5121: (np.uint8, 255.0),
    5123: (np.uint16, 65535.0),
    5126: (np.float32, 1.0),
}
WIDTH = {"VEC3": 3, "VEC4": 4}


def read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    if data[:4] != b"glTF":
        raise ValueError("not a GLB file")
    length = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20 : 20 + length])
    return doc, data[20 + length + 8 :]


def read_gltf_json(path: Path) -> dict:
    return read_glb(path)[0]


def _view_bytes(doc: dict, binary: bytes, view_index: int) -> bytes:
    view = doc["bufferViews"][view_index]
    start = view.get("byteOffset", 0)
    return binary[start : start + view["byteLength"]]


def read_colors(doc: dict, binary: bytes) -> np.ndarray | None:
    """COLOR_0 všech primitiv jako sRGB 0–1 (glTF je ukládá lineárně).

    Čte se přímo z glTF: trimesh u primitiva s materiálem barvy vrcholů neukáže."""
    chunks = []
    for mesh in doc.get("meshes", []):
        for primitive in mesh["primitives"]:
            index = primitive.get("attributes", {}).get("COLOR_0")
            if index is None:
                continue
            accessor = doc["accessors"][index]
            dtype, scale = COMPONENTS[accessor["componentType"]]
            width = WIDTH[accessor["type"]]
            view = doc["bufferViews"][accessor["bufferView"]]
            stride = (
                view.get("byteStride", width * np.dtype(dtype).itemsize)
                // np.dtype(dtype).itemsize
            )
            raw = np.frombuffer(
                _view_bytes(doc, binary, accessor["bufferView"]), dtype=dtype
            )
            start = accessor.get("byteOffset", 0) // np.dtype(dtype).itemsize
            values = raw[start : start + accessor["count"] * stride].reshape(
                accessor["count"], stride
            )
            linear = values[:, :3].astype(np.float64) / scale
            chunks.append(
                np.where(
                    linear <= 0.0031308,
                    linear * 12.92,
                    1.055 * np.power(linear, 1 / 2.4) - 0.055,
                )
            )
    return np.concatenate(chunks) if chunks else None


def texture_sizes(doc: dict, binary: bytes) -> list[tuple[int, int] | None]:
    sizes = []
    for image in doc.get("images", []):
        blob = (
            _view_bytes(doc, binary, image["bufferView"])
            if "bufferView" in image
            else b""
        )
        sizes.append(
            struct.unpack(">II", blob[16:24])
            if blob[:8] == b"\x89PNG\r\n\x1a\n"
            else None
        )
    return sizes


def check(
    path: Path,
    expected_height_m: float | None = None,
    max_triangles: int = MAX_TRIANGLES,
) -> dict:
    reasons: list[str] = []
    doc, binary = read_glb(path)
    if doc.get("extensionsUsed") or doc.get("extensionsRequired"):
        reasons.append(f"glTF extensions not allowed: {doc.get('extensionsUsed')}")

    materials = len(doc.get("materials", []))
    if materials > MAX_MATERIALS:
        reasons.append(f"{materials} materials > {MAX_MATERIALS}")

    scene = trimesh.load(path, force="scene")
    geometries = list(scene.dump()) if scene.geometry else []
    triangles = sum(len(g.faces) for g in geometries)
    if triangles < MIN_TRIANGLES:
        reasons.append(f"{triangles} triangles < {MIN_TRIANGLES}")
    if triangles > max_triangles:
        reasons.append(f"{triangles} triangles > {max_triangles}")

    textures = texture_sizes(doc, binary)
    for size in textures:
        if size is None:
            reasons.append("texture is not an embedded PNG – size unchecked")
        elif max(size) > MAX_TEXTURE_PX:
            reasons.append(f"texture {size[0]}x{size[1]} > {MAX_TEXTURE_PX} px")

    stats: dict = {
        "triangles": triangles,
        "materials": materials,
        "bytes": path.stat().st_size,
    }
    if geometries:
        vertices = np.concatenate([g.vertices for g in geometries])
        lo, hi = vertices.min(axis=0), vertices.max(axis=0)
        extents = hi - lo
        size = float(extents.max())
        height = float(extents[1])
        stats["extentsM"] = [round(float(e), 4) for e in extents]
        if not MIN_HEIGHT_M <= height <= MAX_HEIGHT_M:
            reasons.append(
                f"height {height:.3f} m outside {MIN_HEIGHT_M}–{MAX_HEIGHT_M} m"
            )
        if (
            expected_height_m
            and abs(height - expected_height_m) > HEIGHT_TOLERANCE * expected_height_m
        ):
            reasons.append(
                f"height along +Y is {height:.3f} m, expected {expected_height_m} m (wrong up axis or scale)"
            )
        if abs(lo[1]) > PIVOT_TOLERANCE * size:
            reasons.append(f"pivot not at the base: lowest point y={lo[1]:.3f}")
        center = (lo + hi) / 2
        if max(abs(center[0]), abs(center[2])) > PIVOT_TOLERANCE * size:
            reasons.append(f"pivot not centred: x={center[0]:.3f} z={center[2]:.3f}")

        # Střepy z nepřestavěné sítě TRELLIS.2 mají sousední plochy otočené proti sobě;
        # každá zdravá síť z workflow (i s barevnými švy) je po svaření vrcholů konzistentní.
        welded = trimesh.util.concatenate(geometries)
        welded.merge_vertices()
        if not welded.is_winding_consistent:
            reasons.append(
                "inconsistent face winding – shredded mesh (was it remeshed?)"
            )

        colors = read_colors(doc, binary)
        if colors is not None:
            share = float(is_purple(colors).mean())
            stats["purpleShare"] = round(share, 4)
            if share > MAX_PURPLE_SHARE:
                reasons.append(
                    f"{share:.1%} of vertex colours are purple (hue 250–320°)"
                )
        elif not textures:
            reasons.append("no vertex colours and no texture")
    else:
        reasons.append("no geometry")

    return {"passed": not reasons, "reasons": reasons, "stats": stats}


if __name__ == "__main__":
    import sys

    print(
        json.dumps(
            check(Path(sys.argv[1]), float(sys.argv[2]) if len(sys.argv) > 2 else None),
            indent=2,
        )
    )
