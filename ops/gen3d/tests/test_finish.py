"""Dodělávka: model ležící na boku, zmenšený stokrát a s 80 tis. trojúhelníky musí vyjít
jako stojící herní model v metrech pod stropem trojúhelníků, bez fialové."""

import hashlib
from pathlib import Path

import numpy as np
import pytest
import trimesh

import quality_gate
from finish import HERO_MAX_TRIANGLES, LOD0_TRIANGLES, LOD1_SHARE, finish
from palette import guard_purple, hsv_to_rgb, is_purple, quantize, stylize
from preview import BLENDER

PURPLE = [150, 60, 220, 255]  # odstín ~272°
ORANGE = [235, 140, 40, 255]


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


needs_blender = pytest.mark.skipif(
    not Path(BLENDER).exists(), reason="Blender 5.1 not installed"
)


def colour_half(mesh: trimesh.Trimesh, axis: int) -> trimesh.Trimesh:
    upper = mesh.vertices[:, axis] > mesh.vertices[:, axis].mean()
    mesh.visual.vertex_colors = np.where(upper[:, None], PURPLE, ORANGE).astype(
        np.uint8
    )
    return mesh


@pytest.fixture(scope="module")
def z_up_glb(tmp_path_factory) -> Path:
    """Sloup 0,3 × 0,3 × 1,5 dlouhý podél +Z glTF – autor ho modeloval se Z nahoru."""
    mesh = (
        trimesh.creation.box(extents=(0.3, 0.3, 1.5))
        .subdivide()
        .subdivide()
        .subdivide()
    )
    path = tmp_path_factory.mktemp("fixtures") / "z_up.glb"
    colour_half(mesh, axis=2).export(path)
    return path


@pytest.fixture(scope="module")
def dense_tiny_glb(tmp_path_factory) -> Path:
    """Koule s 81 920 trojúhelníky, průměr 2 cm – stokrát menší, než má být."""
    mesh = trimesh.creation.icosphere(subdivisions=6, radius=0.01)
    path = tmp_path_factory.mktemp("fixtures") / "dense_tiny.glb"
    colour_half(mesh, axis=1).export(path)
    return path


def test_gate_rejects_raw_dense_tiny_model(dense_tiny_glb):
    result = quality_gate.check(dense_tiny_glb)
    assert not result["passed"]
    assert any("triangles >" in r for r in result["reasons"])
    assert any("height" in r for r in result["reasons"])
    assert any("purple" in r for r in result["reasons"])


def test_gate_rejects_model_lying_on_its_side(z_up_glb):
    result = quality_gate.check(z_up_glb, expected_height_m=1.5)
    assert not result["passed"]
    assert any("wrong up axis" in r for r in result["reasons"])


def test_gate_rejects_model_without_colours(tmp_path):
    path = tmp_path / "grey.glb"
    mesh = trimesh.creation.icosphere(subdivisions=3, radius=0.5)
    mesh.apply_translation([0, 0.5, 0])
    mesh.export(path)
    result = quality_gate.check(path, expected_height_m=1.0)
    assert result["reasons"] == ["no vertex colours and no texture"]


def test_gate_rejects_shredded_mesh_with_flipped_faces(tmp_path):
    """Tučňák 24. 9.: síť z TRELLIS.2 bez přestavění měla střepy a plochy otočené
    napřeskáčku – brána ji pustila. Zdravá koule projde, s každou třetí plochou
    otočenou ne."""
    mesh = trimesh.creation.icosphere(subdivisions=3, radius=0.5)
    mesh.apply_translation([0, 0.5, 0])
    mesh.visual.vertex_colors = np.tile(ORANGE, (len(mesh.vertices), 1)).astype(
        np.uint8
    )
    healthy = tmp_path / "healthy.glb"
    mesh.export(healthy)
    assert quality_gate.check(healthy, expected_height_m=1.0)["passed"]

    faces = mesh.faces.copy()
    faces[::3] = faces[::3, ::-1]
    shredded = tmp_path / "shredded.glb"
    trimesh.Trimesh(
        mesh.vertices, faces, vertex_colors=mesh.visual.vertex_colors, process=False
    ).export(shredded)
    result = quality_gate.check(shredded, expected_height_m=1.0)
    assert any("inconsistent" in r for r in result["reasons"])


def test_purple_guard_and_palette():
    rgb = np.array([[0.6, 0.25, 0.85], [0.9, 0.55, 0.15], [0.5, 0.5, 0.5]])
    assert is_purple(rgb).tolist() == [True, False, False]
    assert not is_purple(guard_purple(rgb)).any()
    assert np.allclose(guard_purple(rgb)[1:], rgb[1:])

    # Tučňák z karty 24. 9.: tmavá šedá těsně pod hranicí sytosti paletou prošla,
    # po uložení do GLB (lineárně, 8 bitů) ji brána viděla těsně nad hranicí.
    near_edge = np.array([[0.15, 0.1335, 0.15]])
    assert not is_purple(near_edge).any()
    stored = np.round(srgb_to_linear(guard_purple(near_edge)) * 255) / 255
    assert not is_purple(linear_to_srgb(stored)).any()

    # Totéž pro celou mřížku fialových odstínů přes jas i sytost.
    hue, sat, value = np.meshgrid(
        np.linspace(250, 320, 15), np.linspace(0.02, 1, 25), np.linspace(0.05, 1, 25)
    )
    grid = hsv_to_rgb(np.stack([hue.ravel(), sat.ravel(), value.ravel()], axis=1))
    stored = np.round(srgb_to_linear(guard_purple(grid)) * 255) / 255
    assert not is_purple(linear_to_srgb(stored)).any()

    noisy = np.random.default_rng(1).random((500, 3))
    assert len(np.unique(quantize(noisy, k=8), axis=0)) <= 8


@needs_blender
def test_z_up_model_is_stood_up_on_plus_y(tmp_path, z_up_glb):
    result = finish(z_up_glb, tmp_path, "column", source_up="Z", height_m=1.5)
    assert result["gate"]["passed"], result["gate"]["reasons"]
    width, height, depth = result["gate"]["stats"]["extentsM"]
    assert height == pytest.approx(1.5, rel=0.02)
    assert width == pytest.approx(0.3, rel=0.05)
    assert depth == pytest.approx(0.3, rel=0.05)
    assert result["gate"]["stats"]["purpleShare"] == 0


@needs_blender
def test_dense_tiny_model_is_scaled_and_decimated(tmp_path, dense_tiny_glb):
    result = finish(dense_tiny_glb, tmp_path, "ball", height_m=1.0)
    assert result["gate"]["passed"], result["gate"]["reasons"]
    assert result["triangles"]["lod0"] <= 5000
    assert result["triangles"]["lod1"] < result["triangles"]["lod0"]
    assert result["gate"]["stats"]["extentsM"][1] == pytest.approx(1.0, rel=0.02)
    assert result["gate"]["stats"]["materials"] <= 2
    assert Path(result["preview"]).stat().st_size > 5_000
    assert Path(result["lod1"]).exists()


def sha(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# Výstup bez profilu před P57 T7 (21. 10. 2026, Blender 5.1, gltfpack 1.2.0), dva běhy shodné.
GOLDEN = {
    "column": (
        "598d97397d1377660f83e6dd9bf960615526e3bc78628457104294047b5fe55c",
        "fb1bb9b7fc32d43d913ed5c0158c9ac74314d14b574ccf4dff7bce3c1dee3165",
    ),
    "ball": (
        "2520c21abc6827d0f5c68477f12733fe3f9e0235c20bc961b967a52fc4cb4e72",
        "3c994be379484bdce102c125cf93ec6e61985779aead2fa37f03f7adcf1e5340",
    ),
}


@needs_blender
def test_default_profile_output_is_byte_identical(tmp_path, z_up_glb, dense_tiny_glb):
    """Profil hero nesmí pohnout jediným bajtem modelů, které se přegenerovávají bez něj."""
    column = finish(z_up_glb, tmp_path / "c", "column", source_up="Z", height_m=1.5)
    ball = finish(dense_tiny_glb, tmp_path / "b", "ball", height_m=1.0)
    assert (sha(column["lod0"]), sha(column["lod1"])) == GOLDEN["column"]
    assert (sha(ball["lod0"]), sha(ball["lod1"])) == GOLDEN["ball"]


@needs_blender
def test_hero_profile_doubles_lod0_and_keeps_the_lod1_budget(tmp_path, dense_tiny_glb):
    """Hero má na desktopu dvojnásobek trojúhelníků LOD0, ale LOD1 (telefon, dálka) stejný
    rozpočet jako bez profilu – nafouknutý LOD1 by srazil FPS na telefonu."""
    plain = finish(dense_tiny_glb, tmp_path / "plain", "ball", height_m=1.0)
    hero = finish(
        dense_tiny_glb, tmp_path / "hero", "ball", height_m=1.0, profile="hero"
    )
    assert hero["gate"]["passed"], hero["gate"]["reasons"]
    assert (
        1.5 * plain["triangles"]["lod0"]
        <= hero["triangles"]["lod0"]
        <= HERO_MAX_TRIANGLES
    )
    assert hero["triangles"]["lod1"] <= LOD1_SHARE * LOD0_TRIANGLES + 1
    assert hero["triangles"]["lod1"] == pytest.approx(
        plain["triangles"]["lod1"], rel=0.05
    )
    assert hero["gate"]["stats"]["extentsM"][1] == pytest.approx(1.0, rel=0.02)


@needs_blender
def test_hero_profile_keeps_the_open_edge_of_a_shell(tmp_path):
    """Silueta: hero zjednodušuje v Blenderu a vrcholy otevřeného okraje drží. Miska
    (polokoule, 40 tis. trojúhelníků) si okraj ponechá, i když tělo spadne na pětinu."""
    sphere = trimesh.creation.icosphere(subdivisions=6, radius=0.5)
    bowl = sphere.submesh(
        [np.where(sphere.triangles_center[:, 1] <= 0)[0]], append=True
    )
    bowl.visual.vertex_colors = np.tile(ORANGE, (len(bowl.vertices), 1)).astype(
        np.uint8
    )
    raw = tmp_path / "bowl.glb"
    bowl.export(raw)

    def open_edges(path) -> int:
        mesh = trimesh.load(path, force="mesh", process=True)
        mesh.merge_vertices(merge_tex=True, merge_norm=True)
        return len(trimesh.grouping.group_rows(mesh.edges_sorted, require_count=1))

    hero = finish(raw, tmp_path / "hero", "bowl", height_m=0.5, profile="hero")
    assert hero["triangles"]["lod0"] < len(bowl.faces) / 4
    assert open_edges(hero["lod0"]) >= 0.9 * open_edges(raw)


def test_hero_palette_keeps_one_accent_the_twelve_colours_lose():
    """Oko nebo zobák: 3 jasně červené vrcholy mezi 3 600 tlumenými. Dvanáct barev je
    zprůměruje do okolí, hero je ponechá jako třináctou barvu."""
    rng = np.random.default_rng(3)
    centres = [
        [0.35 + 0.04 * i, 0.30 + 0.02 * (i % 4), 0.22 + 0.015 * (i % 3)]
        for i in range(12)
    ]
    muted = np.concatenate(
        [np.clip(np.array(c) + rng.normal(0, 0.03, (300, 3)), 0, 1) for c in centres]
    )
    red = np.tile([0.9, 0.08, 0.06], (3, 1))
    rgb = np.concatenate([muted, red])

    plain = stylize(rgb, 12)
    assert np.array_equal(plain, guard_purple(quantize(rgb, 12)))
    assert np.abs(plain[-3:] - red).max() > 0.1
    hero = stylize(rgb, 12, accent=True)
    assert len(np.unique(hero, axis=0)) <= 13
    assert np.abs(hero[-3:] - red).max() < 0.02
    assert np.array_equal(hero[:-3], plain[:-3])
