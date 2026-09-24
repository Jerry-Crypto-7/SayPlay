"""Služba běží bez dozoru a drží klíč: klíč, cesta, fronta a pád ComfyUI.

Atrapa je jen ComfyUI klient (žádná karta); ověření klíče, cache i dodělávka
v Blenderu jsou skutečné.
"""

import threading
import time
from pathlib import Path

import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient

import cache
import server
from comfy_client import ComfyError
from preview import BLENDER

KEY = "s3cret-Key-for-tests"
needs_blender = pytest.mark.skipif(
    not Path(BLENDER).exists(), reason="Blender 5.1 not installed"
)


class FakeComfy:
    """Místo ComfyUI: obrázek je jen jméno, „3D“ je barevná koule jako surový výstup TRELLIS.2."""

    def __init__(
        self, crash_on_mesh: bool = False, gate: threading.Event | None = None
    ):
        self.crash_on_mesh = crash_on_mesh
        self.gate = gate
        self.calls = 0
        self.active = 0
        self.max_active = 0
        self._lock = threading.Lock()

    def alive(self) -> bool:
        return True

    def run(self, graph: dict) -> dict:
        with self._lock:
            self.calls += 1
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.gate is not None:
                self.gate.wait(timeout=10)
            if "save_image" in graph:
                return {
                    "outputs": {
                        "save_image": {
                            "images": [
                                {
                                    "filename": "x.png",
                                    "subfolder": "gen3d",
                                    "type": "output",
                                }
                            ]
                        }
                    }
                }
            if self.crash_on_mesh:
                raise ComfyError(
                    "prompt abc failed: VaeDecodeShapeTrellis: CUDA out of memory "
                    "in C:\\Users\\alice\\comfyui\\comfy\\ldm\\trellis2.py"
                )
            return {
                "outputs": {
                    "save_glb": {
                        "3d": [
                            {
                                "filename": "x.glb",
                                "subfolder": "gen3d",
                                "type": "output",
                            }
                        ]
                    }
                }
            }
        finally:
            with self._lock:
                self.active -= 1

    def download(self, output, target: Path) -> Path:
        mesh = trimesh.creation.icosphere(subdivisions=4, radius=0.5)
        mesh.visual.vertex_colors = np.tile(
            np.array([40, 140, 90, 255], dtype=np.uint8), (len(mesh.vertices), 1)
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        mesh.export(target)
        return target


def make_client(tmp_path: Path, comfy: FakeComfy) -> TestClient:
    return TestClient(server.create_app(KEY, comfy, cache_root=tmp_path / "cache"))


def wait_for(
    client: TestClient, job_id: str, states=("done", "failed"), timeout_s: float = 120
) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        body = client.get(f"/jobs/{job_id}", headers={"X-Gen3d-Key": KEY}).json()
        if body["status"] in states:
            return body
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} stuck in {body['status']}")


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"X-Gen3d-Key": "wrong"},
        {"X-Gen3d-Key": KEY.upper()},
        {"X-Gen3d-Key": KEY.lower()},
        {"X-Gen3d-Key": ""},
    ],
    ids=["missing", "wrong", "upper-case", "lower-case", "empty"],
)
def test_bad_key_is_401_and_creates_no_job(tmp_path, headers):
    comfy = FakeComfy()
    app = server.create_app(KEY, comfy, cache_root=tmp_path / "cache")
    client = TestClient(app)
    assert (
        client.post("/generate", json={"noun": "penguin"}, headers=headers).status_code
        == 401
    )
    assert client.get("/health", headers=headers).status_code == 401
    assert client.get("/jobs/anything", headers=headers).status_code == 401
    time.sleep(0.2)
    assert app.state.jobs == {}
    assert comfy.calls == 0


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_generated_docs_are_not_served_without_the_key(tmp_path, path):
    client = make_client(tmp_path, FakeComfy())
    assert client.get(path).status_code in (401, 404)


def test_full_queue_answers_429_and_creates_no_job(tmp_path):
    gate = threading.Event()
    app = server.create_app(
        KEY, FakeComfy(crash_on_mesh=True, gate=gate), cache_root=tmp_path / "cache"
    )
    client = TestClient(app)
    headers = {"X-Gen3d-Key": KEY}
    letters = "abcdefghijklmnopqrstuvwxyz"
    nouns = [
        f"thing {letters[i // 26]}{letters[i % 26]}"
        for i in range(server.MAX_QUEUE + 2)
    ]
    codes = [
        client.post("/generate", json={"noun": noun}, headers=headers).status_code
        for noun in nouns
    ]
    gate.set()
    assert codes[-1] == 429
    assert codes.count(200) == len(app.state.jobs) <= server.MAX_QUEUE + 1


def test_app_refuses_to_exist_without_a_key(tmp_path):
    with pytest.raises(ValueError):
        server.create_app("", FakeComfy(), cache_root=tmp_path)


def test_main_refuses_to_start_without_env_key(monkeypatch):
    monkeypatch.delenv("GEN3D_KEY", raising=False)
    with pytest.raises(SystemExit):
        server.main()


@pytest.mark.parametrize(
    "noun",
    [
        "",
        "   ",
        "../x",
        "..\\x",
        "a/b",
        "C:\\Windows",
        "penguin!",
        "the",
        "x" * 41,
        "nul",
        "CON",
        "the aux",
    ],
)
def test_bad_nouns_are_rejected_before_any_path_exists(tmp_path, noun):
    comfy = FakeComfy()
    client = make_client(tmp_path, comfy)
    response = client.post(
        "/generate", json={"noun": noun}, headers={"X-Gen3d-Key": KEY}
    )
    assert response.status_code == 422
    assert not (tmp_path / "cache").exists() or not any((tmp_path / "cache").iterdir())
    assert not (tmp_path / "x").exists()
    assert comfy.calls == 0


def test_normalisation_folds_plural_article_and_case():
    assert cache.normalize("Penguins") == "penguin"
    assert cache.normalize("the penguin") == "penguin"
    assert cache.normalize("  A Teapot ") == "teapot"
    assert cache.normalize("boxes") == "box"
    assert cache.normalize("ice creams") == "ice cream"
    assert cache.slug("ice cream") == "ice-cream"
    # Z korpusu vět 24. 9.: „zombies“ vyšlo jako „zomby“ a vedle „zombie“ by se generovalo dvakrát.
    for plural, singular in [
        ("zombies", "zombie"),
        ("cookies", "cookie"),
        ("candies", "candy"),
        ("shelves", "shelf"),
        ("knives", "knife"),
        ("snowmen", "snowman"),
        ("glasses", "glass"),
    ]:
        assert cache.normalize(plural) == singular


def test_entry_dir_never_leaves_the_cache(tmp_path):
    root = tmp_path / "cache"
    assert cache.entry_dir("penguin", root).parent == root.resolve()
    with pytest.raises(cache.InvalidNoun):
        cache.entry_dir("../x", root)


def test_comfy_crash_mid_job_ends_failed_with_reason(tmp_path):
    client = make_client(tmp_path, FakeComfy(crash_on_mesh=True))
    job_id = client.post(
        "/generate", json={"noun": "penguin"}, headers={"X-Gen3d-Key": KEY}
    ).json()["jobId"]
    body = wait_for(client, job_id, timeout_s=10)
    assert body["status"] == "failed"
    assert "CUDA out of memory" in body["reason"]
    assert "glb" not in body
    # Důvod nesmí prozradit disk ani jméno uživatele – jen typ výjimky a zprávu.
    assert ":\\" not in body["reason"] and "alice" not in body["reason"]
    assert body["reason"].startswith("ComfyError: ")


def test_queue_runs_one_job_at_a_time(tmp_path):
    gate = threading.Event()
    comfy = FakeComfy(
        crash_on_mesh=True, gate=gate
    )  # pád po obrázku – Blender tu není potřeba
    client = make_client(tmp_path, comfy)
    headers = {"X-Gen3d-Key": KEY}
    first = client.post("/generate", json={"noun": "penguin"}, headers=headers).json()[
        "jobId"
    ]
    second = client.post("/generate", json={"noun": "teapot"}, headers=headers).json()[
        "jobId"
    ]
    time.sleep(0.3)
    assert client.get(f"/jobs/{first}", headers=headers).json()["status"] == "running"
    assert client.get(f"/jobs/{second}", headers=headers).json()["status"] == "queued"
    gate.set()
    wait_for(client, second, timeout_s=10)
    assert comfy.max_active == 1


def test_same_noun_while_queued_returns_the_same_job(tmp_path):
    gate = threading.Event()
    client = make_client(tmp_path, FakeComfy(crash_on_mesh=True, gate=gate))
    headers = {"X-Gen3d-Key": KEY}
    first = client.post("/generate", json={"noun": "penguin"}, headers=headers).json()[
        "jobId"
    ]
    again = client.post("/generate", json={"noun": "Penguins"}, headers=headers).json()[
        "jobId"
    ]
    gate.set()
    assert first == again


@needs_blender
def test_generated_model_is_cached_and_second_request_skips_the_gpu(tmp_path):
    comfy = FakeComfy()
    client = make_client(tmp_path, comfy)
    headers = {"X-Gen3d-Key": KEY}
    job_id = client.post("/generate", json={"noun": "penguin"}, headers=headers).json()[
        "jobId"
    ]
    body = wait_for(client, job_id)
    assert body["status"] == "done", body.get("reason")
    # Cesty jsou relativní ke cache, žádná absolutní cesta disku.
    for field in ("glb", "lod1", "preview"):
        assert ":" not in body[field] and not body[field].startswith("/"), body[field]
    glb = tmp_path / "cache" / body["glb"]
    assert glb.exists() and glb.resolve().is_relative_to(
        (tmp_path / "cache" / "penguin").resolve()
    )
    assert body["gate"]["passed"]
    calls = comfy.calls

    again = client.post("/generate", json={"noun": "Penguins"}, headers=headers).json()[
        "jobId"
    ]
    body = client.get(f"/jobs/{again}", headers=headers).json()
    assert body["status"] == "done"
    assert tmp_path / "cache" / body["glb"] == glb
    assert comfy.calls == calls
