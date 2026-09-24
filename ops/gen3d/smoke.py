"""Orákulum služby bez atrap: skutečný ComfyUI, skutečná karta, skutečný klíč.

    uv run smoke.py --noun penguin

Spustí ComfyUI (když už neběží) a službu s náhodným klíčem, zavolá bez klíče
(čeká 401) a s klíčem (čeká `done` a GLB, který projde kontrolou kvality),
a nakonec zabije jen procesy, které sám spustil, podle PID.
Cache je čerstvý dočasný adresář, aby model opravdu vznikl na kartě.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from comfy_client import ComfyClient
from quality_gate import check

HERE = Path(__file__).resolve().parent
COMFY_DIR = Path("D:/tools/comfyui")
SERVICE = "http://127.0.0.1:8790"
JOB_TIMEOUT_S = 300


def call(method: str, path: str, key: str | None, body: dict | None = None):
    request = urllib.request.Request(
        SERVICE + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={
            "Content-Type": "application/json",
            **({"X-Gen3d-Key": key} if key else {}),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def wait_until(ready, timeout_s: float, what: str) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if ready():
            return
        time.sleep(1)
    raise SystemExit(f"FAIL: {what} not ready in {timeout_s:.0f} s")


def service_up(key: str) -> bool:
    try:
        return call("GET", "/health", key)[0] == 200
    except OSError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--noun", default="penguin")
    args = parser.parse_args()

    started: list[subprocess.Popen] = []
    key = secrets.token_urlsafe(24)
    cache_dir = Path(tempfile.mkdtemp(prefix="gen3d-smoke-"))
    comfy = ComfyClient()
    try:
        if not comfy.alive():
            started.append(
                subprocess.Popen(
                    [
                        str(COMFY_DIR / ".venv/Scripts/python.exe"),
                        "main.py",
                        "--listen",
                        "127.0.0.1",
                        "--port",
                        "8188",
                        "--disable-auto-launch",
                    ],
                    cwd=COMFY_DIR,
                    env={**os.environ, "HF_HOME": "D:/caches/huggingface"},
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
            wait_until(comfy.alive, 240, "ComfyUI")
        started.append(
            subprocess.Popen(
                [sys.executable, str(HERE / "server.py")],
                cwd=HERE,
                env={**os.environ, "GEN3D_KEY": key, "GEN3D_CACHE_DIR": str(cache_dir)},
            )
        )
        wait_until(lambda: service_up(key), 60, "gen3d service")

        code, _ = call("POST", "/generate", None, {"noun": args.noun})
        assert code == 401, f"no key -> {code}, expected 401"
        code, _ = call("POST", "/generate", "wrong-" + key, {"noun": args.noun})
        assert code == 401, f"wrong key -> {code}, expected 401"
        assert call("GET", "/health", key)[1]["queued"] == 0, "a job exists after 401"

        started_at = time.monotonic()
        code, body = call("POST", "/generate", key, {"noun": args.noun})
        assert code == 200, f"generate -> {code} {body}"
        job_id = body["jobId"]
        while True:
            _, job = call("GET", f"/jobs/{job_id}", key)
            if job["status"] in ("done", "failed"):
                break
            assert time.monotonic() - started_at < JOB_TIMEOUT_S, "job hangs > 5 min"
            time.sleep(2)
        seconds = time.monotonic() - started_at
        assert job["status"] == "done", f"job failed: {job.get('reason')}"

        glb = (
            cache_dir / job["glb"]
        ).resolve()  # služba vrací cestu relativně ke cache
        assert glb.is_relative_to(cache_dir.resolve()), f"{glb} outside the cache"
        gate = check(glb)
        assert gate["passed"], f"quality gate: {gate['reasons']}"
        print(
            json.dumps(
                {
                    "noun": args.noun,
                    "seconds": round(seconds, 1),
                    "glb": str(glb),
                    "gate": gate,
                },
                indent=2,
            )
        )
        print("SMOKE OK")
        return 0
    finally:
        for process in reversed(started):
            process.terminate()
            process.wait(timeout=30)


if __name__ == "__main__":
    raise SystemExit(main())
