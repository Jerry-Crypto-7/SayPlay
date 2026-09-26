"""Hlasová služba běží bez dozoru a drží klíč: klíč, cache, fronta, zámek karty a pád modelu.

Atrapa je jen model (sinus místo Kokoro); klíč, cache, kódování Ogg přes ffmpeg
i zámek karty jsou skutečné.
"""

import importlib.util
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import voice
from fastapi.testclient import TestClient

# `music.py` dává `ops/gen3d` na začátek `sys.path` a tamní `server.py` by tohle jméno přebil.
_spec = importlib.util.spec_from_file_location(
    "audio_server", Path(__file__).resolve().parents[1] / "server.py"
)
server = sys.modules["audio_server"] = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(server)

KEY = "s3cret-Key-for-tests"
GOAL = "Reach the flag before the time runs out."


class FakeModel:
    def __init__(
        self,
        silent: bool = False,
        gate: threading.Event | None = None,
        lock_dir: Path | None = None,
    ):
        self.silent, self.gate, self.lock_dir = silent, gate, lock_dir
        self.calls = 0
        self.loads = 0
        self.lock_held: list[bool] = []

    def load(self):
        self.loads += 1
        return self.synthesize

    def synthesize(self, text: str) -> np.ndarray:
        self.calls += 1
        if self.lock_dir is not None:
            self.lock_held.append(self.lock_dir.exists())
        if self.gate is not None:
            self.gate.wait(timeout=10)
        if self.silent:
            return np.zeros(voice.RATE, dtype=np.float32)
        t = np.arange(voice.RATE) / voice.RATE
        return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def make(tmp_path: Path, model: FakeModel, lock_dir: Path | None = None) -> TestClient:
    lock_dir = lock_dir or tmp_path / "gpu.lock"
    app = server.create_app(
        KEY,
        load_model=model.load,
        cache_root=tmp_path / "cache",
        gpu_lock=lambda: voice.GpuLock(lock_dir, poll=0.02, wait_max=5),
    )
    return TestClient(app, headers={"X-Audio-Key": KEY})


def wait_done(client: TestClient, vid: str, timeout: float = 15.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/voice/{vid}")
        if response.status_code != 202:
            return response
        time.sleep(0.05)
    raise AssertionError("voice job never finished")


def test_every_route_wants_the_key(tmp_path):
    client = make(tmp_path, FakeModel())
    bare = TestClient(client.app)
    vid = voice.voice_id(GOAL)
    for headers in ({}, {"X-Audio-Key": "wrong"}, {"X-Audio-Key": KEY + "x"}):
        assert bare.get("/health", headers=headers).status_code == 401
        assert (
            bare.post("/voice", json={"text": GOAL}, headers=headers).status_code == 401
        )
        assert bare.get(f"/voice/{vid}", headers=headers).status_code == 401
        for docs in ("/docs", "/redoc", "/openapi.json"):
            assert bare.get(docs, headers=headers).status_code in (401, 404)


def test_refuses_to_start_without_a_key(monkeypatch):
    with pytest.raises(ValueError):
        server.create_app("")
    monkeypatch.delenv("AUDIO_KEY", raising=False)
    with pytest.raises(SystemExit):
        server.main()


def test_a_goal_becomes_an_ogg_and_the_second_ask_hits_the_cache(tmp_path):
    model = FakeModel()
    client = make(tmp_path, model)
    first = client.post("/voice", json={"text": f"  {GOAL}\n"})
    assert first.status_code == 200
    vid = first.json()["id"]
    assert vid == voice.voice_id(GOAL)
    audio = wait_done(client, vid)
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/ogg"
    assert audio.content[:4] == b"OggS"
    again = client.post("/voice", json={"text": GOAL})
    assert again.json() == {"id": vid, "status": "done"}
    assert model.calls == 1
    assert model.loads == 1


def test_a_running_job_answers_202_and_a_repeat_does_not_queue_twice(tmp_path):
    gate = threading.Event()
    model = FakeModel(gate=gate)
    client = make(tmp_path, model)
    vid = client.post("/voice", json={"text": GOAL}).json()["id"]
    assert client.get(f"/voice/{vid}").status_code == 202
    assert client.post("/voice", json={"text": GOAL}).json()["status"] in (
        "queued",
        "running",
    )
    gate.set()
    assert wait_done(client, vid).status_code == 200
    assert model.calls == 1


def test_a_silent_model_fails_the_job_and_a_new_ask_retries(tmp_path):
    model = FakeModel(silent=True)
    client = make(tmp_path, model)
    vid = client.post("/voice", json={"text": GOAL}).json()["id"]
    assert wait_done(client, vid).status_code == 404
    assert not list((tmp_path / "cache").glob("*.ogg"))
    model.silent = False
    assert client.post("/voice", json={"text": GOAL}).json()["status"] == "queued"
    assert wait_done(client, vid).status_code == 200


def test_generation_waits_for_the_shared_gpu_lock_and_releases_it(tmp_path):
    lock_dir = tmp_path / "gpu.lock"
    lock_dir.mkdir()
    # Zámek drží živý proces (tenhle) – úloha musí čekat.
    (lock_dir / "owner.json").write_text(f'{{"pid": {os.getpid()}}}', encoding="utf-8")
    model = FakeModel(lock_dir=lock_dir)
    client = make(tmp_path, model, lock_dir)
    vid = client.post("/voice", json={"text": GOAL}).json()["id"]
    time.sleep(0.3)
    assert model.calls == 0
    assert client.get(f"/voice/{vid}").status_code == 202
    for child in lock_dir.glob("*"):
        child.unlink()
    lock_dir.rmdir()
    assert wait_done(client, vid).status_code == 200
    assert model.lock_held == [True]
    assert not lock_dir.exists()


def test_a_lock_left_by_a_dead_process_is_taken_over(tmp_path):
    lock_dir = tmp_path / "gpu.lock"
    lock_dir.mkdir()
    (lock_dir / "owner.json").write_text('{"pid": 999999}', encoding="utf-8")
    client = make(tmp_path, FakeModel(), lock_dir)
    vid = client.post("/voice", json={"text": GOAL}).json()["id"]
    assert wait_done(client, vid).status_code == 200


@pytest.mark.parametrize("text", ["", "   ", "x" * (voice.MAX_CHARS + 1)])
def test_bad_text_is_422(tmp_path, text):
    assert (
        make(tmp_path, FakeModel()).post("/voice", json={"text": text}).status_code
        == 422
    )


@pytest.mark.parametrize("vid", ["../server.py", "ABC", "0" * 31, "g" * 32])
def test_unknown_or_malformed_ids_are_404(tmp_path, vid):
    assert make(tmp_path, FakeModel()).get(f"/voice/{vid}").status_code == 404


def test_an_id_cannot_walk_out_of_the_cache(tmp_path):
    # Na Windows je zpětné lomítko oddělovač cesty: `..\secret` by jinak došlo k souboru vedle cache.
    (tmp_path / "secret.ogg").write_bytes(b"OggS-not-a-voice")
    client = make(tmp_path, FakeModel())
    assert client.get("/voice/..%5Csecret").status_code == 404
    assert client.get("/voice/..%2Fsecret").status_code == 404


def test_settled_jobs_do_not_pile_up(tmp_path):
    model = FakeModel()
    client = make(tmp_path, model)
    vid = client.post("/voice", json={"text": GOAL}).json()["id"]
    assert wait_done(client, vid).status_code == 200
    deadline = time.monotonic() + 5
    while client.app.state.jobs and time.monotonic() < deadline:
        time.sleep(0.02)
    assert client.app.state.jobs == {}


def test_liveness_asks_the_os_without_signalling():
    assert voice._alive(os.getpid()) is True
    assert voice._alive(999_999) is False


UNICODE = "Go\x85now﻿!"


def test_cleaning_touches_only_ascii_whitespace():
    assert voice.narration("  Go\n\tnow!  ") == "Go now!"
    # Python i JavaScript by tady `\s` čistily každý jinak – id by se rozešlo.
    assert voice.narration(UNICODE) == UNICODE
    # Týž řetězec pinuje `voice-job.test.ts`.
    assert (
        voice.voice_id(voice.narration(UNICODE)) == "7307cbf840740e71fcb7e0c52c0a3f77"
    )


def test_voice_id_matches_the_next_side():
    # Týž řetězec pinuje `src/app/api/play/__tests__/voice-job.test.ts`.
    assert voice.voice_id(GOAL) == "ce7085647d35e2245d58872bf1e061bc"
