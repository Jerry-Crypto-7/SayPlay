"""Náhled modelu pro kontrolu okem: tři pohledy (zepředu, 3/4, z boku) vedle sebe v jednom PNG.

Pre-existing material, author: project owner, VR Blender Generate
(`scripts/preview_render.py`: setup_scene, import_model, setup_camera_and_lights).
Upraveno: materiál s barvami vrcholů (originál vykreslil TRELLIS model šedě),
skládání pohledů přes numpy v Blenderu místo PIL.

Z Pythonu: `render_preview(glb, png)`; uvnitř Blenderu běží `_render()`.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

BLENDER = os.environ.get(
    "GEN3D_BLENDER", "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe"
)
SIZE = 384
ANGLES = (0, 45, 90)


def render_preview(glb: Path, png: Path, timeout_s: float = 180) -> Path:
    result = subprocess.run(
        [
            BLENDER,
            "--background",
            "--factory-startup",
            "--python",
            __file__,
            "--",
            str(glb),
            str(png),
        ],
        capture_output=True,
        text=True,
        timeout=timeout_s,
    )
    if result.returncode != 0 or not png.exists():
        raise RuntimeError(
            f"preview render failed: {result.stdout[-1500:]} {result.stderr[-1500:]}"
        )
    return png


def _render(src: str, out: str) -> None:
    import math

    import bpy
    import numpy as np
    from mathutils import Vector

    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh objects found in {src}")
    for obj in meshes:
        if not obj.data.color_attributes:
            continue
        mat = bpy.data.materials.new("preview")
        mat.use_nodes = True
        tree = mat.node_tree
        node = tree.nodes.new("ShaderNodeVertexColor")
        node.layer_name = obj.data.color_attributes[0].name
        tree.links.new(
            node.outputs["Color"], tree.nodes["Principled BSDF"].inputs["Base Color"]
        )
        obj.data.materials.clear()
        obj.data.materials.append(mat)

    corners = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector([min(c[i] for c in corners) for i in range(3)])
    hi = Vector([max(c[i] for c in corners) for i in range(3)])
    center, size = (lo + hi) / 2, max(max(hi - lo), 1e-3)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = scene.render.resolution_y = SIZE
    scene.render.image_settings.file_format = "PNG"
    scene.world = bpy.data.worlds.new("preview")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        0.75,
        0.75,
        0.75,
        1.0,
    )
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    scene.collection.objects.link(sun)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    scene.camera = cam

    tiles = []
    for angle in ANGLES:
        a = math.radians(angle)
        cam.location = center + Vector(
            (math.sin(a) * size * 2.2, -math.cos(a) * size * 2.2, size * 0.5)
        )
        cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        tile = f"{out}.{angle}.png"
        scene.render.filepath = tile
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(tile)
        pixels = np.empty(SIZE * SIZE * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        tiles.append(pixels.reshape(SIZE, SIZE, 4))
        bpy.data.images.remove(image)
        os.remove(tile)

    sheet = np.concatenate(tiles, axis=1)
    combined = bpy.data.images.new(
        "sheet", width=SIZE * len(ANGLES), height=SIZE, alpha=True
    )
    combined.pixels.foreach_set(sheet.ravel())
    combined.filepath_raw = out
    combined.file_format = "PNG"
    combined.save()


if __name__ == "__main__" and "--" in sys.argv:
    _render(*sys.argv[sys.argv.index("--") + 1 :][:2])
