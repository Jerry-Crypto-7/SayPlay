"""Služba prostředí běží bez dozoru a drží klíč: klíč, cache, fronta, zámek GPU a pád generátoru.

Atrapa je jen generátor obrazu (žádná karta); klíč, cache, kódování WebP i zámek jsou skutečné.
"""

import json
import os
import threading
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

import server

KEY = "s3cret-Env-key-for-tests"


class FakeGenerator:
    def __init__(
        self, lock_dir: Path, crash: bool = False, gate: threading.Event | None = None
    ):
        self.lock_dir = lock_dir
        self.crash = crash
        self.gate = gate
        self.calls: list[str] = []
        self.locked_during_call: list[bool] = []

    def __call__(self, prompt: str, seed: int = 0) -> np.ndarray:
        self.calls.append(prompt)
        owner = self.lock_dir / "owner.json"
        self.locked_during_call.append(
            owner.exists() and json.loads(owner.read_text())["pid"] == os.getpid()
        )
        if self.gate is not None:
            self.gate.wait(timeout=10)
        if self.crash:
            raise RuntimeError(r"CUDA out of memory in C:\Users\someone\model.py")
        img = np.zeros((1024, 2048, 3), np.uint8)
        img[:512] = (120, 180, 230)
        img[512:] = (40, 120, 40)
        return img


@pytest.fixture
def env(tmp_path: Path):
    def make(**kwargs):
        lock_dir = tmp_path / "gpu.lock"
        gen = FakeGenerator(lock_dir, **kwargs)
        app = server.create_app(
            KEY, gen, cache_root=tmp_path / "cache", lock_dir=lock_dir
        )
        return TestClient(app), gen, lock_dir

    return make


def wait_done(client: TestClient, job_id: str) -> dict:
    for _ in range(200):
        body = client.get(f"/jobs/{job_id}", headers={"X-Env-Key": KEY}).json()
        if body["status"] in ("done", "failed"):
            return body
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_every_route_requires_the_key(env):
    client, _, _ = env()
    assert client.post("/panorama", json={"setting": "snowy forest"}).status_code == 401
    assert (
        client.post(
            "/panorama",
            json={"setting": "snowy forest"},
            headers={"X-Env-Key": "wrong"},
        ).status_code
        == 401
    )
    assert client.get("/jobs/x").status_code == 401
    assert client.get("/health").status_code == 401
    assert client.get("/files/x.webp").status_code == 401
    # Vestavěné dokumentace nejsou vůbec, takže je nejde ani obejít.
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path, headers={"X-Env-Key": KEY}).status_code == 404


def test_refuses_to_start_without_a_key(tmp_path):
    with pytest.raises(ValueError):
        server.create_app("", FakeGenerator(tmp_path), cache_root=tmp_path)


def test_generates_under_the_gpu_lock_and_serves_the_result(env):
    client, gen, lock_dir = env()
    job = client.post(
        "/panorama", json={"setting": "Snowy Forest"}, headers={"X-Env-Key": KEY}
    ).json()
    body = wait_done(client, job["jobId"])
    assert body["status"] == "done", body
    assert gen.locked_during_call == [True]
    assert not lock_dir.exists(), "lock must be released after generation"
    assert body["id"] == "snowy-forest"
    assert body["horizon"].startswith("#")
    image = client.get(f"/files/{body['file']}", headers={"X-Env-Key": KEY})
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/webp"
    assert (
        client.get(f"/files/{body['low']}", headers={"X-Env-Key": KEY}).status_code
        == 200
    )


def test_same_setting_comes_from_cache(env):
    client, gen, _ = env()
    first = client.post(
        "/panorama", json={"setting": "snowy forest"}, headers={"X-Env-Key": KEY}
    ).json()
    wait_done(client, first["jobId"])
    second = client.post(
        "/panorama", json={"setting": "  SNOWY   forest "}, headers={"X-Env-Key": KEY}
    ).json()
    assert wait_done(client, second["jobId"])["status"] == "done"
    assert len(gen.calls) == 1


def test_restarted_service_serves_from_the_disk_cache(env):
    client, _, _ = env()
    wait_done(
        client,
        client.post(
            "/panorama", json={"setting": "lava"}, headers={"X-Env-Key": KEY}
        ).json()["jobId"],
    )
    restarted, gen, _ = env()
    job = restarted.post(
        "/panorama", json={"setting": "lava"}, headers={"X-Env-Key": KEY}
    ).json()
    assert wait_done(restarted, job["jobId"])["status"] == "done"
    assert gen.calls == []


def test_waits_for_a_lock_held_by_someone_else(env, tmp_path):
    client, gen, lock_dir = env()
    lock_dir.mkdir()
    # Živý cizí vlastník: tento proces sám, ale s jiným cmd – zámek se nesmí ukrást.
    (lock_dir / "owner.json").write_text(
        json.dumps({"pid": os.getppid(), "cmd": "other"})
    )
    job = client.post(
        "/panorama", json={"setting": "desert"}, headers={"X-Env-Key": KEY}
    ).json()
    time.sleep(0.3)
    assert gen.calls == []
    assert (
        client.get(f"/jobs/{job['jobId']}", headers={"X-Env-Key": KEY}).json()["status"]
        == "queued"
    )
    (lock_dir / "owner.json").unlink()
    lock_dir.rmdir()
    assert wait_done(client, job["jobId"])["status"] == "done"


def test_generator_crash_fails_the_job_without_leaking_paths(env):
    client, _, lock_dir = env(crash=True)
    job = client.post(
        "/panorama", json={"setting": "volcano"}, headers={"X-Env-Key": KEY}
    ).json()
    body = wait_done(client, job["jobId"])
    assert body["status"] == "failed"
    assert "Users" not in body["reason"] and "model.py" in body["reason"]
    assert not lock_dir.exists()


def test_failed_job_is_not_requeued_before_the_cooldown(tmp_path):
    # Route hry se ptá POSTem při každém dotazu klienta: selhaná úloha se nesmí
    # znovu pustit na kartu s každým z nich, jen po cool-downu.
    now = [1000.0]
    lock_dir = tmp_path / "gpu.lock"
    gen = FakeGenerator(lock_dir, crash=True)
    client = TestClient(
        server.create_app(
            KEY,
            gen,
            cache_root=tmp_path / "cache",
            lock_dir=lock_dir,
            failed_cooldown=60,
            clock=lambda: now[0],
        )
    )

    def post() -> str:
        return client.post(
            "/panorama", json={"setting": "volcano"}, headers={"X-Env-Key": KEY}
        ).json()["jobId"]

    first = post()
    assert wait_done(client, first)["status"] == "failed"
    now[0] += 59
    for _ in range(5):
        assert post() == first
    assert wait_done(client, first)["status"] == "failed"
    assert len(gen.calls) == 1

    now[0] += 2
    second = post()
    assert second != first
    assert wait_done(client, second)["status"] == "failed"
    assert len(gen.calls) == 2


def test_half_written_owner_file_is_not_stale(tmp_path):
    # gpu-lock.mjs zakládá adresář dřív, než zapíše owner.json: čerstvý prázdný zámek drží.
    lock_dir = tmp_path / "gpu.lock"
    lock_dir.mkdir()
    (lock_dir / "owner.json").write_text("")
    assert not server._stale(lock_dir)
    old = time.time() - 120
    os.utime(lock_dir, (old, old))
    assert server._stale(lock_dir)


def test_release_leaves_a_lock_taken_over_by_someone_else(tmp_path):
    lock_dir = tmp_path / "gpu.lock"
    with server.gpu_lock(lock_dir, 0.01):
        (lock_dir / "owner.json").write_text(json.dumps({"pid": os.getppid()}))
    assert lock_dir.exists()


def test_reason_hides_forward_slash_paths_too():
    reason = server.public_reason(OSError("cannot open 'C:/Users/someone/x.bin'"))
    assert "someone" not in reason and "x.bin" in reason


def test_repeated_requests_reuse_one_job(env):
    client, _, _ = env()
    ids = {
        client.post(
            "/panorama", json={"setting": "desert"}, headers={"X-Env-Key": KEY}
        ).json()["jobId"]
        for _ in range(5)
    }
    assert len(ids) == 1
    first = ids.pop()
    wait_done(client, first)
    again = client.post(
        "/panorama", json={"setting": "desert"}, headers={"X-Env-Key": KEY}
    ).json()["jobId"]
    assert again == first


@pytest.mark.parametrize("setting", ["", "x" * 81, "../../etc", "a;rm -rf"])
def test_rejects_bad_settings(env, setting):
    client, gen, _ = env()
    assert (
        client.post(
            "/panorama", json={"setting": setting}, headers={"X-Env-Key": KEY}
        ).status_code
        == 422
    )
    assert gen.calls == []


def test_files_route_does_not_escape_the_cache(env):
    client, _, _ = env()
    assert (
        client.get(
            "/files/..%2F..%2Fsecret.webp", headers={"X-Env-Key": KEY}
        ).status_code
        == 404
    )
    assert (
        client.get("/files/missing.webp", headers={"X-Env-Key": KEY}).status_code == 404
    )


def test_full_queue_answers_429(env, monkeypatch):
    monkeypatch.setattr(server, "MAX_QUEUE", 1)
    gate = threading.Event()
    client, _, _ = env(gate=gate)
    try:
        client.post("/panorama", json={"setting": "one"}, headers={"X-Env-Key": KEY})
        time.sleep(0.1)  # první běží, fronta prázdná
        assert (
            client.post(
                "/panorama", json={"setting": "two"}, headers={"X-Env-Key": KEY}
            ).status_code
            == 200
        )
        assert (
            client.post(
                "/panorama", json={"setting": "three"}, headers={"X-Env-Key": KEY}
            ).status_code
            == 429
        )
    finally:
        gate.set()
