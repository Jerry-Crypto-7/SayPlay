"""Herní modely pro WORLDSTREAM PLAY – vlastní geometrie postavená v Blenderu.

Každý model je funkce, která ze základních těles (kvádr, válec, koule…)
poskládá stylizovaný low-poly objekt. Nic se nestahuje ani negeneruje cizím
modelem, takže licence je čistá (`LicenseRef-Worldsmith-Original`).

Souřadnice Blenderu: metry, +Z nahoru, přední strana modelu míří do -Y
(glTF exportér ji převede na +Z vpředu, +Y nahoru). Počátek je střed podstavy.

Spuštění (dělá ho `scripts/assets/game-models.mjs`, ne člověk):
  blender -b --factory-startup --python-exit-code 1 --python game_models.py -- \
      --out <dir> [--previews <dir>] [--only knight,key]

Do `--out` zapíše `<id>-lod0.glb`, `<id>-lod1.glb`, `<id>.png` (náhled do
katalogu) a `models.json` (id, popisek, tagy). `--previews` přidá velký náhled
pro lidskou kontrolu.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Euler, Vector

# ---------------------------------------------------------------- paleta
# Žádná fialová (pravidlo projektu). Barvy jsou sRGB hex, převádí se níž.
PALETTE = {
    "steel": ("#aeb8c2", 0.35, 0.8),
    "dark-steel": ("#4a525c", 0.45, 0.7),
    "gold": ("#e2b33c", 0.3, 0.9),
    "teal-cloth": ("#1f8a8a", 0.9, 0.0),
    "red-cloth": ("#c8412f", 0.85, 0.0),
    "leather": ("#6b4428", 0.8, 0.0),
    "wood": ("#8a5a36", 0.85, 0.0),
    "light-wood": ("#c49a64", 0.8, 0.0),
    "skin": ("#e0a67a", 0.7, 0.0),
    "ink": ("#1b1f24", 0.6, 0.0),
    "white": ("#f3f1ea", 0.7, 0.0),
    "ghost": ("#e6f6f2", 0.6, 0.0),
    "cream": ("#f1e3c2", 0.8, 0.0),
    "green": ("#4caf50", 0.6, 0.0),
    "slime": ("#6fd35a", 0.25, 0.0),
    "orange": ("#f08a24", 0.6, 0.0),
    "yellow": ("#f5d33b", 0.5, 0.0),
    "blue": ("#2f7fd6", 0.5, 0.0),
    "sky": ("#8fd3f4", 0.2, 0.0),
    "grey": ("#8d8a82", 0.9, 0.0),
    "dark-grey": ("#3a3d42", 0.7, 0.0),
    "stone": ("#9a968c", 0.95, 0.0),
    "moss": ("#5e7d3a", 0.95, 0.0),
    "brown": ("#7a4f2e", 0.9, 0.0),
    "pink": ("#f2a0a8", 0.7, 0.0),
    "cardboard": ("#c9a06a", 0.95, 0.0),
    "black": ("#15171a", 0.5, 0.0),
    "rubber": ("#2a2c30", 0.9, 0.0),
    "straw": ("#d8b25a", 0.95, 0.0),
    "fur": ("#c8894e", 0.95, 0.0),
    "ice": ("#bfe8f5", 0.08, 0.0),
    "dark-stone": ("#4e4a45", 0.95, 0.0),
}
# Svítící materiály: (barva, síla).
GLOW = {
    "glow-teal": ("#35e0c8", 2.5),
    "glow-orange": ("#ff8a2a", 3.0),
    "glow-red": ("#ff3b2f", 2.5),
    "glow-green": ("#8cff3a", 2.5),
    "glow-cyan": ("#6fe8ff", 2.5),
    "glow-yellow": ("#ffd84a", 2.5),
    "glow-white": ("#ffffff", 1.2),
}

SEG = 16  # počet segmentů oblých těles; LOD1 ho sníží


def _linear(hex_color):
    value = hex_color.lstrip("#")
    channels = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    return [
        c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels
    ]


_materials = {}


def material(name):
    if name in _materials:
        return _materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    if name in GLOW:
        color, strength = GLOW[name]
        rgb = _linear(color)
        bsdf.inputs["Base Color"].default_value = (*rgb, 1)
        bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
        # Síla nad 1 by exportér zapsal jako rozšíření KHR_materials_emissive_strength,
        # a to bezpečný loader odmítá (žádná rozšíření). Svit dodá barva, ne síla.
        bsdf.inputs["Emission Strength"].default_value = min(1.0, strength)
        bsdf.inputs["Roughness"].default_value = 0.4
    else:
        color, roughness, metallic = PALETTE[name]
        bsdf.inputs["Base Color"].default_value = (*_linear(color), 1)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
    _materials[name] = mat
    return mat


# ---------------------------------------------------------------- tělesa
def _finish(obj, mat, loc, rot, scale):
    obj.location = loc
    obj.rotation_euler = Euler([math.radians(a) for a in rot])
    obj.scale = scale
    obj.data.materials.append(material(mat))
    return obj


def box(mat, size, loc=(0, 0, 0), rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.active_object
    _finish(obj, mat, loc, rot, size)
    if bevel > 0:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 1
    return obj


def cyl(mat, radius, depth, loc=(0, 0, 0), rot=(0, 0, 0), top=None, verts=None):
    """Válec, nebo komolý kužel, když `top` je poloměr horní podstavy."""
    n = verts or SEG
    if top is None:
        bpy.ops.mesh.primitive_cylinder_add(vertices=n, radius=radius, depth=depth)
    else:
        bpy.ops.mesh.primitive_cone_add(
            vertices=n, radius1=radius, radius2=top, depth=depth
        )
    return _finish(bpy.context.active_object, mat, loc, rot, (1, 1, 1))


def ball(mat, radius, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=SEG, ring_count=max(4, SEG // 2), radius=radius
    )
    return _finish(bpy.context.active_object, mat, loc, rot, scale)


def gem(mat, radius, loc=(0, 0, 0), scale=(1, 1, 1), rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=radius)
    return _finish(bpy.context.active_object, mat, loc, rot, scale)


def ring(mat, major, minor, loc=(0, 0, 0), rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(
        major_segments=max(8, SEG + 4),
        minor_segments=max(4, SEG // 3),
        major_radius=major,
        minor_radius=minor,
    )
    return _finish(bpy.context.active_object, mat, loc, rot, (1, 1, 1))


def eyes(z, y, spread, size, mat="ink", x=0.0):
    """Dvě oči na přední straně (-Y) – postavy musí mít čitelný obličej."""
    for side in (-1, 1):
        ball(mat, size, (x + side * spread, y, z), scale=(1, 0.6, 1.2))


# ---------------------------------------------------------------- modely
MODELS = {}


def model(model_id, label, tags):
    def register(fn):
        MODELS[model_id] = {"id": model_id, "label": label, "tags": tags, "build": fn}
        return fn

    return register


@model(
    "knight",
    "Armoured knight hero",
    ["knight", "hero", "warrior", "paladin", "player", "armor", "armour"],
)
def knight():
    # nohy a boty
    for side in (-1, 1):
        cyl("dark-steel", 0.09, 0.42, (side * 0.11, 0, 0.27))
        box("dark-steel", (0.16, 0.24, 0.08), (side * 0.11, -0.03, 0.04), bevel=0.02)
    # trup: pancíř + tunika vpředu
    cyl("steel", 0.24, 0.5, (0, 0, 0.72), top=0.28)
    box("teal-cloth", (0.3, 0.04, 0.46), (0, -0.25, 0.68))
    box("gold", (0.1, 0.02, 0.1), (0, -0.28, 0.78), rot=(0, 45, 0))
    cyl("leather", 0.25, 0.06, (0, 0, 0.5))
    # ramena a paže
    for side in (-1, 1):
        ball("steel", 0.1, (side * 0.3, 0, 0.94))
        cyl("steel", 0.065, 0.36, (side * 0.33, 0, 0.74))
    # hlava: helma s hledím a chocholem
    cyl("steel", 0.2, 0.3, (0, 0, 1.15), top=0.19)
    ball("steel", 0.19, (0, 0, 1.3), scale=(1, 1, 0.7))
    box("ink", (0.26, 0.04, 0.05), (0, -0.19, 1.2))
    box("ink", (0.04, 0.04, 0.14), (0, -0.19, 1.13))
    ball("red-cloth", 0.09, (0, 0.04, 1.47), scale=(0.6, 1.8, 1.1))
    # štít v levé ruce, meč v pravé
    cyl("teal-cloth", 0.2, 0.05, (-0.44, -0.08, 0.74), rot=(90, 0, 0))
    cyl("gold", 0.21, 0.03, (-0.44, -0.06, 0.74), rot=(90, 0, 0))
    ball("gold", 0.05, (-0.44, -0.11, 0.74))
    box("steel", (0.05, 0.02, 0.62), (0.42, -0.12, 0.92))
    box("gold", (0.2, 0.04, 0.04), (0.42, -0.12, 0.6))
    cyl("leather", 0.025, 0.12, (0.42, -0.12, 0.52))


@model("key", "Golden key", ["key", "keys", "unlock"])
def key():
    ring("gold", 0.09, 0.028, (0, 0, 0.42), rot=(90, 0, 0))
    cyl("gold", 0.025, 0.3, (0, 0, 0.2))
    box("gold", (0.08, 0.03, 0.035), (0.04, 0, 0.1))
    box("gold", (0.06, 0.03, 0.035), (0.03, 0, 0.17))
    ball("glow-yellow", 0.035, (0, 0, 0.42))
    cyl("dark-grey", 0.1, 0.03, (0, 0, 0.015))


@model(
    "ghost",
    "Floating ghost",
    ["ghost", "ghosts", "spirit", "phantom", "spectre", "specter", "spooky"],
)
def ghost():
    ball("ghost", 0.34, (0, 0, 0.95), scale=(1, 1, 1.05))
    cyl("ghost", 0.34, 0.55, (0, 0, 0.62), top=0.34)
    # roztřepený lem
    for i in range(8):
        angle = i / 8 * math.tau
        cyl(
            "ghost",
            0.08,
            0.2,
            (math.cos(angle) * 0.27, math.sin(angle) * 0.27, 0.3),
            top=0.0,
            rot=(180, 0, 0),
            verts=8,
        )
    eyes(1.0, -0.31, 0.11, 0.06)
    ball("ink", 0.06, (0, -0.32, 0.84), scale=(1, 0.5, 1.4))
    for side in (-1, 1):
        ball("ghost", 0.09, (side * 0.38, -0.05, 0.8), scale=(1.4, 0.8, 0.8))


# ---- sbírané předměty


@model(
    "mushroom",
    "Glowing mushroom",
    ["mushroom", "mushrooms", "shroom", "shrooms", "fungus", "toadstool"],
)
def mushroom():
    cyl("cream", 0.09, 0.3, (0, 0, 0.15), top=0.07)
    ball("glow-teal", 0.24, (0, 0, 0.32), scale=(1, 1, 0.62))
    for x, y, z in (
        (0.1, -0.14, 0.4),
        (-0.12, -0.1, 0.42),
        (0.0, 0.16, 0.43),
        (0.17, 0.05, 0.38),
        (-0.06, -0.02, 0.46),
    ):
        ball("white", 0.035, (x, y, z), scale=(1, 1, 0.5))
    cyl("moss", 0.2, 0.03, (0, 0, 0.015))


@model("coin", "Gold coin", ["coin", "coins", "gold", "treasure", "money"])
def coin():
    cyl("gold", 0.2, 0.05, (0, 0, 0.3), rot=(90, 0, 0), verts=max(8, SEG))
    cyl("glow-yellow", 0.13, 0.06, (0, 0, 0.3), rot=(90, 0, 0), verts=max(8, SEG))
    box("gold", (0.05, 0.07, 0.14), (0, 0, 0.3))
    cyl("dark-grey", 0.12, 0.03, (0, 0, 0.015))
    cyl("dark-grey", 0.02, 0.1, (0, 0, 0.07))


@model(
    "crystal",
    "Glowing crystal",
    ["crystal", "crystals", "gem", "gems", "jewel", "jewels", "diamond", "diamonds"],
)
def crystal():
    gem("glow-cyan", 0.14, (0, 0, 0.3), scale=(1, 1, 1.9))
    gem("glow-cyan", 0.07, (0.13, 0.02, 0.14), scale=(1, 1, 1.8), rot=(0, 25, 0))
    gem("glow-cyan", 0.06, (-0.12, -0.04, 0.12), scale=(1, 1, 1.8), rot=(0, -25, 0))
    cyl("stone", 0.2, 0.08, (0, 0, 0.04), top=0.16)


@model("star", "Glowing star", ["star", "stars", "starfish"])
def star():
    for i in range(5):
        angle = i / 5 * 360
        box("glow-yellow", (0.09, 0.07, 0.2), (0, 0, 0.35), rot=(0, angle, 0))
        box(
            "glow-yellow",
            (0.09, 0.07, 0.2),
            (
                math.sin(math.radians(angle)) * 0.1,
                0,
                0.35 + math.cos(math.radians(angle)) * 0.1,
            ),
            rot=(0, angle, 0),
        )
    cyl("dark-grey", 0.1, 0.03, (0, 0, 0.015))
    cyl("dark-grey", 0.02, 0.16, (0, 0, 0.1))


@model("rubber-duck", "Rubber duck", ["duck", "ducks", "ducky", "duckling", "rubber"])
def rubber_duck():
    ball("yellow", 0.2, (0, 0.03, 0.17), scale=(1, 1.25, 0.8))
    ball("yellow", 0.13, (0, -0.1, 0.36))
    ball("orange", 0.06, (0, -0.22, 0.34), scale=(1.2, 1.3, 0.5))
    eyes(0.4, -0.2, 0.06, 0.025)
    ball("yellow", 0.07, (0, 0.24, 0.26), scale=(1, 1, 1.3), rot=(30, 0, 0))


@model(
    "chest", "Treasure chest", ["chest", "chests", "treasure-chest", "loot", "trunk"]
)
def chest():
    box("wood", (0.6, 0.4, 0.3), (0, 0, 0.15), bevel=0.01)
    cyl("wood", 0.2, 0.6, (0, 0, 0.3), rot=(0, 90, 0), verts=max(6, SEG))
    for x in (-0.22, 0.22):
        box("gold", (0.05, 0.42, 0.32), (x, 0, 0.16))
    box("gold", (0.1, 0.03, 0.12), (0, -0.21, 0.28))
    box("glow-yellow", (0.5, 0.2, 0.04), (0, 0, 0.5))


# ---- postavy a nepřátelé


def _biped(body, head_mat, head_r, height, legs="dark-grey"):
    """Jednoduchá postava: nohy, trup, hlava s očima – základ pro lidi a skřety."""
    leg = height * 0.3
    for side in (-1, 1):
        cyl(legs, 0.07, leg, (side * 0.09, 0, leg / 2))
    torso = height * 0.35
    cyl(body, 0.2, torso, (0, 0, leg + torso / 2), top=0.17)
    for side in (-1, 1):
        cyl(
            body,
            0.05,
            torso * 0.9,
            (side * 0.24, 0, leg + torso * 0.5),
            rot=(0, side * 12, 0),
        )
    head_z = leg + torso + head_r * 0.9
    ball(head_mat, head_r, (0, 0, head_z))
    eyes(head_z + head_r * 0.15, -head_r * 0.92, head_r * 0.35, head_r * 0.14)
    return head_z


@model(
    "waiter",
    "Hurried waiter",
    ["waiter", "waiters", "waitress", "server", "butler", "keeper", "chef"],
)
def waiter():
    head_z = _biped("white", "skin", 0.16, 1.5, legs="black")
    box("black", (0.36, 0.05, 0.12), (0, -0.19, 0.95))
    box("red-cloth", (0.12, 0.04, 0.06), (0, -0.2, 1.0))
    ball("brown", 0.16, (0, 0.03, head_z + 0.06), scale=(1.05, 1.05, 0.7))
    # tác s talířem nad pravou rukou
    cyl("steel", 0.02, 0.35, (0.32, -0.1, 1.05))
    cyl("steel", 0.18, 0.02, (0.32, -0.1, 1.23))
    ball("white", 0.07, (0.32, -0.1, 1.27), scale=(1, 1, 0.5))


@model(
    "goblin",
    "Goblin",
    [
        "goblin",
        "goblins",
        "orc",
        "orcs",
        "troll",
        "trolls",
        "monster",
        "monsters",
        "imp",
    ],
)
def goblin():
    head_z = _biped("leather", "green", 0.2, 1.1, legs="brown")
    for side in (-1, 1):
        cyl(
            "green",
            0.07,
            0.22,
            (side * 0.24, 0, head_z + 0.05),
            top=0.0,
            rot=(0, side * -70, 0),
        )
    ball("glow-red", 0.035, (-0.07, -0.2, head_z + 0.04))
    ball("glow-red", 0.035, (0.07, -0.2, head_z + 0.04))
    box("white", (0.03, 0.02, 0.04), (-0.04, -0.2, head_z - 0.1))
    box("white", (0.03, 0.02, 0.04), (0.04, -0.2, head_z - 0.1))
    # kyj
    cyl("wood", 0.03, 0.45, (0.3, -0.1, 0.55), rot=(15, 0, 0))
    ball("wood", 0.08, (0.3, -0.16, 0.78))


@model(
    "roomba",
    "Robot vacuum",
    ["roomba", "roombas", "vacuum", "robot-vacuum", "cleaner", "robot"],
)
def roomba():
    cyl("dark-grey", 0.4, 0.14, (0, 0, 0.09))
    cyl("black", 0.41, 0.06, (0, 0, 0.05))
    cyl("steel", 0.3, 0.02, (0, 0, 0.17))
    box("glow-red", (0.22, 0.03, 0.04), (0, -0.39, 0.12))
    cyl("glow-red", 0.05, 0.03, (0, -0.1, 0.18))
    for side in (-1, 1):
        cyl("steel", 0.08, 0.02, (side * 0.3, -0.25, 0.02))
        ball("ink", 0.04, (side * 0.12, -0.36, 0.14))


@model("drone", "Security drone", ["drone", "drones", "quadcopter", "surveillance"])
def drone():
    ball("dark-grey", 0.18, (0, 0, 0.6), scale=(1, 1, 0.55))
    cyl("glow-red", 0.06, 0.05, (0, -0.16, 0.58), rot=(90, 0, 0))
    for sx in (-1, 1):
        for sy in (-1, 1):
            box(
                "dark-grey",
                (0.34, 0.04, 0.03),
                (sx * 0.17, sy * 0.17, 0.63),
                rot=(0, 0, sx * sy * 45),
            )
            cyl("black", 0.03, 0.06, (sx * 0.3, sy * 0.3, 0.66))
            cyl("sky", 0.13, 0.01, (sx * 0.3, sy * 0.3, 0.7))
    cyl("dark-grey", 0.015, 0.45, (0, 0, 0.22))
    cyl("dark-grey", 0.15, 0.03, (0, 0, 0.015))


@model("cat", "Cat", ["cat", "cats", "kitten", "kitty"])
def cat():
    ball("orange", 0.2, (0, 0.05, 0.25), scale=(0.8, 1.4, 0.8))
    for sx in (-1, 1):
        for sy in (-1, 1):
            cyl("orange", 0.045, 0.18, (sx * 0.1, 0.05 + sy * 0.17, 0.09))
    ball("orange", 0.15, (0, -0.25, 0.42))
    for side in (-1, 1):
        cyl("orange", 0.05, 0.1, (side * 0.08, -0.25, 0.57), top=0.0, verts=4)
    eyes(0.45, -0.38, 0.055, 0.025, mat="glow-green")
    ball("pink", 0.02, (0, -0.4, 0.4))
    cyl("orange", 0.03, 0.4, (0, 0.35, 0.42), rot=(-35, 0, 0))


@model("seal", "Hungry seal", ["seal", "seals", "walrus", "sealion"])
def seal():
    ball("grey", 0.26, (0, 0.1, 0.24), scale=(0.9, 1.5, 0.9))
    ball("grey", 0.2, (0, -0.22, 0.48))
    ball("cream", 0.09, (0, -0.38, 0.44), scale=(1.1, 0.7, 0.8))
    ball("ink", 0.03, (0, -0.44, 0.47))
    eyes(0.55, -0.36, 0.08, 0.03)
    for side in (-1, 1):
        box(
            "dark-grey",
            (0.25, 0.1, 0.03),
            (side * 0.25, -0.05, 0.05),
            rot=(0, 0, side * 20),
        )
    box("dark-grey", (0.3, 0.12, 0.03), (0, 0.5, 0.05))


@model("slime", "Slime", ["slime", "slimes", "blob", "blobs", "jelly", "ooze"])
def slime():
    ball("slime", 0.34, (0, 0, 0.24), scale=(1, 1, 0.72))
    ball("slime", 0.2, (0, -0.02, 0.43), scale=(1, 1, 0.8))
    eyes(0.4, -0.27, 0.1, 0.05, mat="ink")
    for side in (-1, 1):
        ball("white", 0.018, (side * 0.1 + 0.015, -0.315, 0.425))
    ball("ink", 0.04, (0, -0.3, 0.3), scale=(1.6, 0.5, 0.6))


@model(
    "training-dummy",
    "Training dummy",
    ["dummy", "dummies", "training", "scarecrow", "target"],
)
def training_dummy():
    cyl("wood", 0.04, 1.3, (0, 0, 0.65))
    cyl("wood", 0.25, 0.06, (0, 0, 0.03))
    ball("cream", 0.23, (0, 0, 0.8), scale=(1, 0.8, 1.35))
    box("wood", (0.8, 0.06, 0.06), (0, 0, 1.0))
    ball("cream", 0.14, (0, 0, 1.28))
    for radius, mat, y in (
        (0.14, "red-cloth", -0.19),
        (0.09, "white", -0.2),
        (0.04, "red-cloth", -0.21),
    ):
        cyl(mat, radius, 0.02, (0, y, 0.8), rot=(90, 0, 0))
    eyes(1.3, -0.13, 0.05, 0.02)


@model(
    "robot",
    "Cardboard robot",
    ["robot", "robots", "android", "bot", "cardboard", "automaton"],
)
def robot():
    for side in (-1, 1):
        box("cardboard", (0.14, 0.16, 0.4), (side * 0.12, 0, 0.2))
    box("cardboard", (0.5, 0.34, 0.5), (0, 0, 0.66))
    box("dark-grey", (0.24, 0.02, 0.14), (0, -0.18, 0.7))
    ball("glow-green", 0.025, (-0.06, -0.19, 0.72))
    ball("glow-red", 0.025, (0.06, -0.19, 0.72))
    for side in (-1, 1):
        box("cardboard", (0.12, 0.12, 0.42), (side * 0.33, 0, 0.62))
    box("cardboard", (0.36, 0.3, 0.3), (0, 0, 1.08))
    box("glow-cyan", (0.26, 0.02, 0.07), (0, -0.16, 1.1))
    cyl("steel", 0.012, 0.18, (0, 0, 1.32))
    ball("glow-red", 0.035, (0, 0, 1.42))


@model(
    "wasp-nest",
    "Wasp nest",
    ["wasp", "wasps", "nest", "hive", "beehive", "bees", "hornet"],
)
def wasp_nest():
    cyl("wood", 0.04, 1.1, (0, 0.1, 0.55))
    box("wood", (0.06, 0.3, 0.06), (0, -0.03, 1.08))
    for i, (radius, z) in enumerate(
        ((0.18, 0.74), (0.24, 0.62), (0.22, 0.5), (0.15, 0.4))
    ):
        ball(
            "yellow" if i % 2 else "light-wood",
            radius,
            (0, -0.15, z),
            scale=(1, 1, 0.55),
        )
    ball("ink", 0.05, (0, -0.35, 0.52))
    for x, z in ((0.25, 0.8), (-0.28, 0.6), (0.22, 0.38)):
        ball("yellow", 0.035, (x, -0.3, z), scale=(1.4, 1, 1))
        box("ink", (0.02, 0.05, 0.05), (x, -0.3, z))
    cyl("wood", 0.2, 0.05, (0, 0.1, 0.025))


@model(
    "hamster",
    "Hamster",
    ["hamster", "hamsters", "mouse", "mice", "rodent", "gerbil", "rat"],
)
def hamster():
    ball("fur", 0.26, (0, 0.03, 0.25), scale=(1, 1.1, 0.9))
    ball("cream", 0.17, (0, -0.12, 0.2), scale=(1, 0.8, 0.9))
    for side in (-1, 1):
        ball("fur", 0.07, (side * 0.15, -0.02, 0.46), scale=(1, 0.5, 1))
        ball("pink", 0.04, (side * 0.15, -0.05, 0.46), scale=(1, 0.5, 1))
        ball("pink", 0.04, (side * 0.1, -0.2, 0.04), scale=(1, 1.4, 0.6))
    eyes(0.34, -0.22, 0.08, 0.035)
    ball("pink", 0.03, (0, -0.28, 0.28))


@model("penguin", "Penguin", ["penguin", "penguins"])
def penguin():
    ball("black", 0.26, (0, 0, 0.36), scale=(0.9, 0.85, 1.35))
    ball("white", 0.2, (0, -0.07, 0.33), scale=(0.9, 0.8, 1.3))
    ball("black", 0.18, (0, 0, 0.74))
    ball("white", 0.12, (0, -0.08, 0.72), scale=(1, 0.8, 0.9))
    cyl("orange", 0.05, 0.12, (0, -0.22, 0.73), top=0.0, rot=(90, 0, 0), verts=6)
    eyes(0.79, -0.15, 0.06, 0.028)
    for side in (-1, 1):
        box("black", (0.05, 0.14, 0.34), (side * 0.25, 0, 0.4), rot=(0, side * -15, 0))
        box("orange", (0.1, 0.16, 0.03), (side * 0.09, -0.06, 0.015))


# ---- věci na nošení a cíle doručení


@model("cake", "Birthday cake", ["cake", "cakes", "birthday", "dessert", "gateau"])
def cake():
    cyl("white", 0.26, 0.02, (0, 0, 0.01))
    cyl("pink", 0.22, 0.16, (0, 0, 0.1))
    cyl("cream", 0.23, 0.03, (0, 0, 0.19))
    cyl("pink", 0.15, 0.12, (0, 0, 0.26))
    cyl("cream", 0.16, 0.025, (0, 0, 0.33))
    for i in range(4):
        angle = i / 4 * math.tau + 0.4
        cyl("sky", 0.012, 0.09, (math.cos(angle) * 0.08, math.sin(angle) * 0.08, 0.39))
        ball(
            "glow-orange",
            0.018,
            (math.cos(angle) * 0.08, math.sin(angle) * 0.08, 0.45),
            scale=(1, 1, 1.5),
        )
    ball("red-cloth", 0.035, (0, 0, 0.37))


@model("pizza", "Hot pizza", ["pizza", "pizzas", "slice"])
def pizza():
    box("light-wood", (0.5, 0.5, 0.03), (0, 0, 0.015))
    cyl("light-wood", 0.26, 0.04, (0, 0, 0.05))
    cyl("orange", 0.23, 0.02, (0, 0, 0.07))
    cyl("yellow", 0.21, 0.02, (0, 0, 0.08))
    for x, y in ((0.1, 0.05), (-0.08, 0.1), (-0.05, -0.1), (0.08, -0.1), (0.0, 0.0)):
        cyl("red-cloth", 0.035, 0.02, (x, y, 0.095))
    for i in range(3):
        cyl("glow-white", 0.02, 0.18, (-0.1 + i * 0.1, 0, 0.22), top=0.005)


@model("egg", "Egg", ["egg", "eggs"])
def egg():
    ball("cream", 0.14, (0, 0, 0.22), scale=(1, 1, 1.35))
    ring("straw", 0.13, 0.04, (0, 0, 0.06))
    cyl("straw", 0.12, 0.04, (0, 0, 0.03))


@model(
    "altar",
    "Stone altar",
    ["altar", "altars", "shrine", "pedestal", "plinth", "shrines"],
)
def altar():
    box("stone", (0.9, 0.6, 0.15), (0, 0, 0.075), bevel=0.02)
    box("stone", (0.6, 0.4, 0.55), (0, 0, 0.42), bevel=0.02)
    box("stone", (0.8, 0.55, 0.1), (0, 0, 0.74), bevel=0.02)
    box("red-cloth", (0.5, 0.02, 0.35), (0, -0.21, 0.5))
    for x in (-0.3, 0.3):
        cyl("cream", 0.04, 0.16, (x, 0, 0.87))
        ball("glow-orange", 0.03, (x, 0, 0.98), scale=(1, 1, 1.6))
    gem("glow-cyan", 0.07, (0, 0, 0.86), scale=(1, 1, 1.4))


@model("bird-nest", "Bird nest", ["nest", "nests", "bird-nest", "bird", "birds"])
def bird_nest():
    ring("straw", 0.2, 0.08, (0, 0, 0.1))
    cyl("brown", 0.2, 0.06, (0, 0, 0.05))
    for x, y in ((-0.05, 0.03), (0.06, 0.0), (0.0, -0.07)):
        ball("sky", 0.05, (x, y, 0.12), scale=(1, 1, 1.3))


# ---- východy, brány, cíle cesty


@model(
    "exit-door",
    "Exit doors",
    ["exit", "exits", "doors", "exit-door", "doorway", "way-out"],
)
def exit_door():
    box("dark-grey", (1.5, 0.25, 0.12), (0, 0, 2.26))
    for side in (-1, 1):
        box("dark-grey", (0.12, 0.25, 2.2), (side * 0.69, 0, 1.1))
        box("green", (0.6, 0.08, 2.1), (side * 0.32, -0.02, 1.05), bevel=0.01)
        box("sky", (0.34, 0.09, 0.5), (side * 0.32, -0.02, 1.55))
        cyl("steel", 0.025, 0.3, (side * 0.07, -0.09, 1.05))
    box("glow-green", (0.7, 0.06, 0.24), (0, -0.14, 2.5))
    box("white", (0.5, 0.07, 0.08), (0, -0.16, 2.5))


@model(
    "stone-portal",
    "Glowing stone portal",
    ["portal", "portals", "stone", "gateway", "archway", "arch", "teleporter"],
)
def stone_portal():
    box("stone", (1.8, 0.7, 0.2), (0, 0, 0.1), bevel=0.03)
    for side in (-1, 1):
        box("stone", (0.32, 0.4, 1.9), (side * 0.7, 0, 1.15), bevel=0.03)
        gem("glow-teal", 0.06, (side * 0.7, -0.21, 1.6))
    cyl("stone", 0.86, 0.4, (0, 0, 2.1), rot=(90, 0, 0), verts=max(8, SEG))
    box("stone", (1.1, 0.42, 0.5), (0, 0, 1.85))
    cyl("glow-teal", 0.62, 0.05, (0, 0, 1.25), rot=(90, 0, 0), verts=max(8, SEG))
    box("glow-teal", (1.08, 0.05, 0.8), (0, 0, 0.62))


@model(
    "finish-flag",
    "Finish flag on a ledge",
    ["ledge", "ledges", "finish", "goal", "flag", "summit", "platform", "far-side"],
)
def finish_flag():
    box("stone", (1.2, 1.0, 0.3), (0, 0, 0.15), bevel=0.03)
    box("moss", (1.2, 1.0, 0.04), (0, 0, 0.32))
    cyl("steel", 0.03, 1.6, (0.4, 0.2, 1.1))
    ball("gold", 0.05, (0.4, 0.2, 1.92))
    for i in range(3):
        for j in range(2):
            box(
                "white" if (i + j) % 2 else "black",
                (0.18, 0.02, 0.15),
                (0.49 + i * 0.18 - 0.18 + 0.18, 0.2, 1.75 - j * 0.15),
            )


@model(
    "checkpoint",
    "Checkpoint post",
    ["checkpoint", "checkpoints", "waypoint", "marker", "post"],
)
def checkpoint():
    cyl("dark-grey", 0.2, 0.06, (0, 0, 0.03))
    cyl("white", 0.05, 1.3, (0, 0, 0.7))
    for z in (0.3, 0.7, 1.1):
        cyl("red-cloth", 0.055, 0.12, (0, 0, z))
    ball("glow-green", 0.1, (0, 0, 1.42))
    box("glow-green", (0.4, 0.02, 0.25), (0.22, 0, 1.18))


@model("hoop", "Flaming hoop", ["hoop", "hoops", "ring", "rings", "flaming", "loop"])
def hoop():
    for side in (-1, 1):
        cyl("dark-grey", 0.04, 0.9, (side * 0.55, 0, 0.45))
        cyl("dark-grey", 0.12, 0.04, (side * 0.55, 0, 0.02))
    ring("glow-orange", 0.5, 0.06, (0, 0, 1.3), rot=(90, 0, 0))
    ring("red-cloth", 0.5, 0.03, (0, -0.05, 1.3), rot=(90, 0, 0))
    for i in range(6):
        angle = i / 6 * math.tau
        cyl(
            "glow-yellow",
            0.05,
            0.16,
            (math.cos(angle) * 0.5, -0.02, 1.3 + math.sin(angle) * 0.5 + 0.05),
            top=0.0,
            verts=6,
        )


@model(
    "stepping-stone",
    "Stepping stone",
    ["stepping", "steppingstone", "slab", "slabs", "rock", "rocks"],
)
def stepping_stone():
    cyl("stone", 0.45, 0.2, (0, 0, 0.1), top=0.4, verts=9)
    cyl("moss", 0.3, 0.03, (0.05, -0.04, 0.21), verts=7)
    ball("stone", 0.1, (-0.3, 0.2, 0.18), scale=(1, 1, 0.6))


# ---- nebezpečné plochy (leží na zemi, výška do 0,2 m)


def _pool(rim, fill, radius=0.6):
    cyl(rim, radius, 0.1, (0, 0, 0.05), top=radius * 0.94, verts=max(9, SEG))
    cyl(fill, radius * 0.82, 0.04, (0, 0, 0.1), verts=max(9, SEG))


@model(
    "lava-pool", "Lava pool", ["lava", "magma", "vent", "vents", "molten", "fire-pit"]
)
def lava_pool():
    _pool("dark-stone", "glow-orange")
    for x, y in ((0.2, -0.1), (-0.25, 0.15), (0.05, 0.3)):
        ball("glow-yellow", 0.06, (x, y, 0.12), scale=(1, 1, 0.5))
    for x, y in ((0.5, 0.3), (-0.55, -0.2)):
        gem("dark-stone", 0.1, (x, y, 0.08))


@model("ice-patch", "Ice patch", ["ice", "icy", "frozen", "frost", "snow"])
def ice_patch():
    _pool("white", "ice")
    for x, y, r in ((0.25, -0.2, 20), (-0.2, 0.2, -30)):
        box("white", (0.3, 0.02, 0.02), (x, y, 0.125), rot=(0, 0, r))
    gem("ice", 0.1, (0.45, 0.3, 0.12), scale=(1, 1, 1.6))


@model("acid-pool", "Acid pool", ["acid", "poison", "toxic", "sludge", "goo", "swamp"])
def acid_pool():
    _pool("dark-grey", "glow-green")
    for x, y, r in ((0.15, -0.1, 0.07), (-0.2, 0.12, 0.05), (0.02, 0.28, 0.04)):
        ball("glow-green", r, (x, y, 0.13), scale=(1, 1, 0.8))


@model(
    "hazard-tile",
    "Glowing floor tile",
    ["tile", "tiles", "floor-tile", "trap", "traps", "pressure-plate"],
)
def hazard_tile():
    box("dark-grey", (1.0, 1.0, 0.08), (0, 0, 0.04), bevel=0.015)
    box("glow-red", (0.82, 0.82, 0.03), (0, 0, 0.09))
    # varovný terčík uprostřed – čitelný shora a oblý, aby LOD1 měl co ubrat
    cyl("dark-grey", 0.14, 0.02, (0, 0, 0.115))
    cyl("glow-yellow", 0.08, 0.02, (0, 0, 0.125))
    for i in range(3):
        box("dark-grey", (0.08, 0.84, 0.035), (-0.27 + i * 0.27, 0, 0.1), rot=(0, 0, 0))


# ---- rekvizity


@model(
    "shopping-cart",
    "Shopping cart",
    ["cart", "carts", "shopping", "trolley", "trolleys"],
)
def shopping_cart():
    box("steel", (0.5, 0.75, 0.04), (0, 0, 0.35))
    for side in (-1, 1):
        box("steel", (0.03, 0.75, 0.4), (side * 0.25, 0, 0.55))
        box("steel", (0.5, 0.03, 0.4), (0, side * 0.37, 0.55))
        cyl("steel", 0.015, 0.33, (side * 0.22, 0.3, 0.17))
        cyl("steel", 0.015, 0.33, (side * 0.22, -0.3, 0.17))
        for y in (-0.3, 0.3):
            cyl("black", 0.05, 0.04, (side * 0.22, y, 0.05), rot=(0, 90, 0))
    box("red-cloth", (0.5, 0.05, 0.05), (0, 0.44, 0.85))
    for x in (-0.12, 0.0, 0.12):
        box("steel", (0.015, 0.75, 0.38), (x, 0, 0.55))


# ---------------------------------------------------------------- export
def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for mesh in list(bpy.data.meshes):
        bpy.data.meshes.remove(mesh)


def build(model_id, segments):
    global SEG
    SEG = segments
    clear_scene()
    MODELS[model_id]["build"]()
    objects = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for obj in objects:
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        for mod in list(obj.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    joined = bpy.context.active_object
    joined.name = model_id
    joined.data.name = model_id
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # Podstava přesně na zemi, střed v ose.
    xs = [v.co.x for v in joined.data.vertices]
    ys = [v.co.y for v in joined.data.vertices]
    zs = [v.co.z for v in joined.data.vertices]
    shift = Vector(((min(xs) + max(xs)) / -2, (min(ys) + max(ys)) / -2, -min(zs)))
    for v in joined.data.vertices:
        v.co += shift
    for poly in joined.data.polygons:
        poly.use_smooth = False
    return joined


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
        export_texcoords=False,
        export_normals=True,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_animations=False,
    )


def render_preview(obj, path, size):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("preview") if scene.world is None else scene.world
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (
        *_linear("#e8edf0"),
        1,
    )
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.9
    dims = obj.dimensions
    radius = max(dims) * 0.5
    center = Vector((0, 0, dims.z / 2))
    cam_data = bpy.data.cameras.new("cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("cam", cam_data)
    scene.collection.objects.link(cam)
    direction = Vector((0.55, -1.0, 0.45)).normalized()
    cam.location = center + direction * (radius * 3.6 + 0.3)
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun_data = bpy.data.lights.new("sun", "SUN")
    sun_data.energy = 3.5
    sun = bpy.data.objects.new("sun", sun_data)
    sun.rotation_euler = Euler((math.radians(50), math.radians(10), math.radians(-30)))
    scene.collection.objects.link(sun)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for extra in (cam, sun):
        bpy.data.objects.remove(extra)


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = {argv[i]: argv[i + 1] for i in range(0, len(argv) - 1, 2)}
    out = args["--out"]
    previews = args.get("--previews")
    only = args["--only"].split(",") if "--only" in args else list(MODELS)
    os.makedirs(out, exist_ok=True)
    if previews:
        os.makedirs(previews, exist_ok=True)
    for model_id in only:
        for level, segments in ((0, 16), (1, 7)):
            obj = build(model_id, segments)
            export_glb(os.path.join(out, f"{model_id}-lod{level}.glb"))
            if level == 0:
                render_preview(obj, os.path.join(out, f"{model_id}.png"), 256)
                if previews:
                    render_preview(obj, os.path.join(previews, f"{model_id}.png"), 768)
        print(f"MODEL {model_id} ok")
    manifest = [
        {"id": m, "label": MODELS[m]["label"], "tags": MODELS[m]["tags"]}
        for m in MODELS
    ]
    with open(os.path.join(out, "models.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2)
        handle.write("\n")


main()
