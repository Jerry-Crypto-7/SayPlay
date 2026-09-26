"""Služba: věta prostředí -> panorama na lokální kartě, za klíčem, s cache a frontou jedné úlohy.

    ENV_KEY=... uv run --project ops/env python ops/env/server.py     # jen 127.0.0.1:8793

POST /panorama {"setting": "snowy forest"} -> {"jobId"}; GET /jobs/{id} -> stav, soubory, horizont;
GET /files/{name} -> WebP; GET /health. Každá cesta chce hlavičku X-Env-Key shodnou s ENV_KEY, jinak 401.
Generování drží sdílený GPU zámek (týž adresář jako D:/claude/_shared/gpu-lock.mjs), takže se
nepotká s dávkami jiných stop.
"""

from __future__ import annotations

import hmac
import json
import os
import queue
import re
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from panorama import write
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
HOST, PORT = "127.0.0.1", 8793
MAX_QUEUE = 20  # ~10 min práce karty; víc čekajících prostředí dostane 429
CACHE_ROOT = Path("D:/caches/worldsmith-env")
LOCK_DIR = Path("D:/claude/_shared/gpu.lock")
STALE_SEC = 3 * 3600
# Selhaná úloha drží hodinu: route hry se ptá POSTem při každém dotazu klienta a prostředí,
# které na kartě padá vždy (OOM), by se jinak zařadilo znovu s každým dotazem.
FAILED_COOLDOWN_SEC = 3600

SETTING = re.compile(r"^[a-z0-9][a-z0-9 ,'-]{0,79}$")
WINDOWS_PATH = re.compile(r"(?:[A-Za-z]:|\\\\[^\\/\s]+)[\\/][^\s'\"]*")

Generator = Callable[[str, int], np.ndarray]


class PanoramaRequest(BaseModel):
    setting: str


def normalize(setting: str) -> str:
    text = " ".join(setting.lower().split())
    if not SETTING.match(text):
        raise ValueError(
            "setting must be 1-80 letters, digits, spaces, commas, apostrophes or dashes"
        )
    return text


def slug(setting: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", setting).strip("-")


def public_reason(error: Exception) -> str:
    """Typ výjimky + krátká zpráva bez cest disku (a tedy bez jména uživatele)."""
    message = WINDOWS_PATH.sub(lambda m: re.split(r"[\\/]", m.group(0))[-1], str(error))
    return f"{type(error).__name__}: {message}"[:300]


def _alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        handle = ctypes.windll.kernel32.OpenProcess(
            0x1000, False, pid
        )  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        ctypes.windll.kernel32.CloseHandle(handle)
        return code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _owner_pid(lock_dir: Path) -> int | None:
    try:
        return int(
            json.loads((lock_dir / "owner.json").read_text(encoding="utf-8"))["pid"]
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _stale(lock_dir: Path) -> bool:
    pid = _owner_pid(lock_dir)
    try:
        age = time.time() - lock_dir.stat().st_mtime
    except FileNotFoundError:
        return False
    if pid is None:
        # Chybějící, prázdný nebo rozepsaný owner.json: gpu-lock.mjs zakládá adresář
        # dřív, než ho zapíše. Zastaralý až po minutě, stejně jako v gpu-lock.mjs.
        return age > 60
    return not _alive(pid) or age > STALE_SEC


@contextmanager
def gpu_lock(lock_dir: Path, poll: float) -> Iterator[None]:
    """Týž protokol jako gpu-lock.mjs: atomický mkdir, owner.json s pid, zastaralý zámek se uklidí."""
    while True:
        try:
            lock_dir.mkdir(parents=False)
            break
        except FileExistsError:
            if _stale(lock_dir):
                for child in lock_dir.iterdir():
                    child.unlink()
                lock_dir.rmdir()
                continue
            time.sleep(poll)
    try:
        owner = {
            "pid": os.getpid(),
            "cwd": str(HERE),
            "cmd": "ops/env/server.py",
            "since": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        (lock_dir / "owner.json").write_text(json.dumps(owner), encoding="utf-8")
        yield
    finally:
        # Jen vlastní zámek: po 3 h ho mohl jiný čekatel prohlásit za zastaralý a převzít.
        if _owner_pid(lock_dir) == os.getpid():
            for child in lock_dir.iterdir():
                child.unlink()
            lock_dir.rmdir()


@dataclass
class Job:
    id: str
    setting: str
    status: str = "queued"  # queued | running | done | failed
    meta: dict | None = None
    reason: str | None = None
    failed_at: float | None = None

    def view(self) -> dict:
        body = {"jobId": self.id, "setting": self.setting, "status": self.status}
        if self.status == "done" and self.meta:
            name = slug(self.setting)
            body.update(
                id=name,
                file=f"{name}.webp",
                low=f"{name}-low.webp",
                horizon=self.meta["horizon"],
            )
        if self.reason:
            body["reason"] = self.reason
        return body


def create_app(
    key: str,
    generate: Generator,
    cache_root: Path = CACHE_ROOT,
    lock_dir: Path = LOCK_DIR,
    lock_poll: float = 0.05,
    failed_cooldown: float = FAILED_COOLDOWN_SEC,
    clock: Callable[[], float] = time.monotonic,
) -> FastAPI:
    if not key:
        raise ValueError("ENV_KEY must be set")
    expected = key.encode("utf-8")
    jobs: dict[str, Job] = {}
    by_slug: dict[str, Job] = {}
    pending: queue.Queue[Job] = queue.Queue()
    lock = threading.Lock()

    def require_key(x_env_key: str | None = Header(default=None)) -> None:
        if x_env_key is None or not hmac.compare_digest(
            x_env_key.encode("utf-8"), expected
        ):
            raise HTTPException(status_code=401, detail="missing or wrong X-Env-Key")

    def cached(name: str) -> dict | None:
        meta = cache_root / f"{name}.json"
        if meta.exists() and (cache_root / f"{name}.webp").exists():
            return json.loads(meta.read_text(encoding="utf-8"))
        return None

    def worker() -> None:
        while True:
            job = pending.get()
            try:
                with gpu_lock(lock_dir, lock_poll):
                    job.status = "running"
                    pixels = generate(job.setting, 0)
                name = slug(job.setting)
                job.meta = write(pixels, cache_root, name) | {"setting": job.setting}
                (cache_root / f"{name}.json").write_text(
                    json.dumps(job.meta), encoding="utf-8"
                )
                job.status = "done"
            except Exception as error:  # noqa: BLE001 – úloha skončí failed s důvodem, nikdy nevisí
                job.reason = public_reason(error)
                job.failed_at = clock()
                job.status = "failed"
            finally:
                pending.task_done()

    # Vestavěné /docs, /redoc a /openapi.json by klíč obešly – služba je nemá.
    app = FastAPI(
        title="env",
        dependencies=[Depends(require_key)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    threading.Thread(target=worker, daemon=True, name="env-worker").start()

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "queued": pending.qsize()}

    @app.post("/panorama")
    def submit(request: PanoramaRequest) -> dict:
        try:
            setting = normalize(request.setting)
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        name = slug(setting)
        with lock:
            # Jedna úloha na prostředí: opakovaný dotaz nevyrábí nové záznamy; selhaná se
            # nahradí až po cool-downu, jinak ji vrací dál i se stavem failed.
            active = by_slug.get(name)
            if active and (
                active.status != "failed"
                or active.failed_at is None
                or clock() - active.failed_at < failed_cooldown
            ):
                return {"jobId": active.id}
            job = Job(uuid.uuid4().hex, setting)
            hit = cached(name)
            if hit:
                job.status, job.meta = "done", hit
            elif pending.qsize() >= MAX_QUEUE:
                # Stará selhaná úloha zůstává: smazat ji před 429 by nechalo by_slug
                # ukazovat na nic a každý další POST by padal na KeyError.
                raise HTTPException(status_code=429, detail="queue is full")
            else:
                pending.put(job)
            if active:
                del jobs[active.id]
            jobs[job.id] = by_slug[name] = job
        return {"jobId": job.id}

    @app.get("/jobs/{job_id}")
    def status(job_id: str) -> dict:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown job")
        return job.view()

    @app.get("/files/{name}")
    def file(name: str) -> FileResponse:
        if (
            not re.fullmatch(r"[a-z0-9-]+\.webp", name)
            or not (cache_root / name).is_file()
        ):
            raise HTTPException(status_code=404, detail="unknown file")
        return FileResponse(cache_root / name, media_type="image/webp")

    return app


def main() -> None:
    import uvicorn
    from panorama import generate

    key = os.environ.get("ENV_KEY", "")
    if not key:
        raise SystemExit("ENV_KEY is not set – refusing to start without a key")
    uvicorn.run(create_app(key, generate, lock_poll=15.0), host=HOST, port=PORT)


if __name__ == "__main__":
    main()
