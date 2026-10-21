"""Dodělávka surového modelu v Blenderu: úklid, osy, metry, pivot, barvy, jeden materiál.

Pre-existing material, author: project owner, VR Blender Generate
(`scripts/optimize_asset.py`: import_mesh, join_meshes, cleanup_mesh). Vazby na původní
provozní služby (úložiště, webhooky, RunPod, Azure, interní API) a retopologie/UV/bake odříznuté –
cesta nese barvy ve vrcholech, ne texturu.

    blender --background --factory-startup --python finish_mesh.py -- \
        --input raw.glb --output clean.glb --source-up Y --height 1.0 --colors 10

`--profile hero --triangles N` (P57, nejpoužívanější modely): zjednoduší síť už v Blenderu
na N trojúhelníků s ochranou otevřených okrajů a ostrých hran a k paletě přidá jeden akcent.
"""

import argparse
import math
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from palette import stylize

# Osa „nahoru“ zdroje v souřadnicích glTF -> rotace, která ji v Blenderu (Z nahoru)
# postaví na +Z. Import glTF převádí +Y glTF na +Z Blenderu, +Z glTF na −Y Blenderu.
UP_ROTATIONS = {
    "Y": Matrix.Identity(4),
    "Z": Matrix.Rotation(math.radians(-90), 4, "X"),
    "X": Matrix.Rotation(math.radians(-90), 4, "Y"),
}
SHARP_ANGLE = math.radians(60)  # hrana s větším lomem nese siluetu (ucho, ploutev, roh)
# Decimate přičte hraně mimo skupinu cenu úměrnou její délce × síla; okraje tak jdou až naposled.
PROTECT_FACTOR = 100.0


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--source-up", choices=sorted(UP_ROTATIONS), default="Y")
    parser.add_argument("--height", type=float, default=1.0)
    parser.add_argument("--colors", type=int, default=12)
    parser.add_argument("--profile", choices=["default", "hero"], default="default")
    parser.add_argument("--triangles", type=int, default=0)
    args = parser.parse_args(argv)
    if args.profile == "hero" and args.triangles <= 0:
        parser.error("--profile hero needs --triangles")
    return args


def import_mesh(filepath):
    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=filepath)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh objects found in {filepath}")
    return meshes


def join_meshes(meshes):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.parent = None
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def cleanup_mesh(obj):
    """Úklid artefaktů AI modelu. Mazání „vnitřních stěn“ z originálu vypuštěno –
    u tenkých částí (křídla, ploutve) maže platnou geometrii."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True, use_faces=False)
    bpy.ops.mesh.dissolve_degenerate(threshold=0.0001)
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=0.0001)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def orient_scale_pivot(obj, source_up, height):
    obj.data.transform(UP_ROTATIONS[source_up])
    coords = np.empty(len(obj.data.vertices) * 3)
    obj.data.vertices.foreach_get("co", coords)
    coords = coords.reshape(-1, 3)
    lo, hi = coords.min(axis=0), coords.max(axis=0)
    extent_up = hi[2] - lo[2]
    if extent_up <= 1e-9:
        raise RuntimeError("Model has no height along its up axis")
    scale = height / extent_up
    center = Vector(((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]))
    obj.data.transform(Matrix.Scale(scale, 4) @ Matrix.Translation(-center))
    obj.data.update()


def decimate_protected(obj, target):
    """Hero: zjednodušení v Blenderu místo hrubého `gltfpack -sa`. Vrcholy otevřených okrajů
    a ostrých hran stojí mimo skupinu, kterou Decimate bere, takže silueta jde až naposled."""
    faces = len(obj.data.polygons)
    if faces <= target:
        return
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    keep = {
        vert.index
        for edge in bm.edges
        if edge.is_boundary
        or (edge.is_manifold and edge.calc_face_angle(0.0) > SHARP_ANGLE)
        for vert in edge.verts
    }
    bm.free()
    group = obj.vertex_groups.new(name="decimate")
    group.add(
        [v.index for v in obj.data.vertices if v.index not in keep], 1.0, "REPLACE"
    )
    modifier = obj.modifiers.new("decimate", "DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = target / faces
    modifier.use_collapse_triangulate = True
    modifier.vertex_group = group.name
    modifier.vertex_group_factor = PROTECT_FACTOR
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    # Odkaz na skupinu po aplikaci modifikátoru neplatí, hledá se znovu podle jména.
    obj.vertex_groups.remove(obj.vertex_groups["decimate"])


def stylize_colors(obj, k, accent=False):
    attrs = obj.data.color_attributes
    if not attrs:
        return False
    attr = attrs.active_color or attrs[0]
    values = np.empty(len(attr.data) * 4, dtype=np.float32)
    attr.data.foreach_get("color_srgb", values)
    rgba = values.reshape(-1, 4)
    rgba[:, :3] = stylize(rgba[:, :3].astype(np.float64), k, accent)
    attr.data.foreach_set("color_srgb", rgba.ravel())
    attrs.active_color = attr
    return True


def single_material(obj, has_colors):
    mat = bpy.data.materials.new("gen3d")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Roughness"].default_value = 0.9
    bsdf.inputs["Metallic"].default_value = 0.0
    if has_colors:
        node = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        node.layer_name = obj.data.color_attributes.active_color.name
        mat.node_tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def main():
    args = parse_args()
    obj = join_meshes(import_mesh(args.input))
    cleanup_mesh(obj)
    orient_scale_pivot(obj, args.source_up, args.height)
    hero = args.profile == "hero"
    if hero:
        decimate_protected(obj, args.triangles)
    has_colors = stylize_colors(obj, args.colors, accent=hero)
    single_material(obj, has_colors)
    bpy.ops.object.shade_smooth()
    bpy.ops.export_scene.gltf(
        filepath=args.output,
        export_format="GLB",
        use_selection=False,
        export_yup=True,
        export_apply=True,
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
        export_vertex_color="ACTIVE",
        export_extras=False,
    )
    print(f"GEN3D_FINISH_OK {args.output}")


if __name__ == "__main__":
    main()
