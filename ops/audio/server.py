"""Služba: cíl hry -> hlas vypravěče na lokálním procesoru, za klíčem, s cache a frontou jedné úlohy.

    AUDIO_KEY=... uv run --project ops/audio --group voice python ops/audio/server.py   # jen 127.0.0.1:8794

POST /voice {"text": "Reach the flag."} -> {"id", "status"}; GET /voice/{id} -> Ogg,
nebo 202 (ještě se generuje), nebo 404 (neznámé či selhané); GET /health.
Každá cesta chce hlavičku X-Audio-Key shodnou s AUDIO_KEY, jinak 401.
Kartu nepotřebuje, takže nečeká na panoramata ani na zálohu režiséra.
"""

from __future__ import annotations

import hmac
import os
import queue
import re
import sys
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from pathlib import Path

import voice
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from voice import InvalidText, Synthesize

HOST, PORT = "127.0.0.1", 8794
MAX_QUEUE = (
    50  # cíl je krátká věta, pár sekund na procesoru; víc čekajících dostane 429
)
VOICE_ID = re.compile(r"^[0-9a-f]{32}$")


class VoiceRequest(BaseModel):
    text: str


@dataclass
class Job:
    id: str
    text: str
    status: str = "queued"  # queued | running | done | failed
    reason: str | None = None


def create_app(
    key: str,
    load_model: Callable[[], Synthesize] = voice.kokoro,
    cache_root: Path = voice.CACHE_ROOT,
    # Kokoro běží na procesoru (`voice.kokoro`), zámek karty tedy nedrží; `GpuLock` jen pro model na kartě.
    gpu_lock: Callable[[], AbstractContextManager[object]] = nullcontext,
) -> FastAPI:
    if not key:
        raise ValueError("AUDIO_KEY must be set")
    expected = key.encode("utf-8")
    jobs: dict[str, Job] = {}
    pending: queue.Queue[Job] = queue.Queue()
    lock = threading.Lock()
    model: list[Synthesize] = []
    cache_root.mkdir(parents=True, exist_ok=True)

    def require_key(x_audio_key: str | None = Header(default=None)) -> None:
        if x_audio_key is None or not hmac.compare_digest(
            x_audio_key.encode("utf-8"), expected
        ):
            raise HTTPException(status_code=401, detail="missing or wrong X-Audio-Key")

    def worker() -> None:
        while True:
            job = pending.get()
            job.status = "running"
            try:
                with gpu_lock():
                    if not model:
                        model.append(load_model())
                    voice.render(job.text, model[0], cache_root)
                job.status = "done"
            except Exception as error:  # noqa: BLE001 – úloha skončí failed s důvodem, nikdy nevisí
                job.reason = f"{type(error).__name__}: {error}"[:200]
                job.status = "failed"
                print(f"voice job {job.id} failed: {job.reason}", file=sys.stderr)
            finally:
                # Hotovou drží cache, selhanou nový dotaz zkusí znovu – slovník neroste s každou větou.
                with lock:
                    jobs.pop(job.id, None)
                pending.task_done()

    # Vestavěné /docs, /redoc a /openapi.json by klíč obešly – služba je nemá.
    app = FastAPI(
        title="audio",
        dependencies=[Depends(require_key)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    threading.Thread(target=worker, daemon=True, name="voice-worker").start()
    app.state.jobs = jobs

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "queued": pending.qsize(), "model": bool(model)}

    @app.post("/voice")
    def submit(request: VoiceRequest) -> dict:
        try:
            text = voice.narration(request.text)
        except InvalidText as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        vid = voice.voice_id(text)
        with lock:
            if voice.cached(vid, cache_root) is not None:
                return {"id": vid, "status": "done"}
            active = jobs.get(vid)
            if active is not None and active.status in ("queued", "running"):
                return {"id": vid, "status": active.status}
            if pending.qsize() >= MAX_QUEUE:
                raise HTTPException(status_code=429, detail="queue is full")
            job = jobs[vid] = Job(vid, text)
            pending.put(job)
        return {"id": vid, "status": "queued"}

    @app.get("/voice/{vid}")
    def fetch(vid: str):
        if not VOICE_ID.match(vid):
            raise HTTPException(status_code=404, detail="unknown voice")
        path = voice.cached(vid, cache_root)
        if path is not None:
            return FileResponse(
                path,
                media_type="audio/ogg",
                headers={"cache-control": "public, max-age=31536000, immutable"},
            )
        job = jobs.get(vid)
        if job is not None and job.status in ("queued", "running"):
            return JSONResponse({"id": vid, "status": job.status}, status_code=202)
        raise HTTPException(status_code=404, detail="unknown voice")

    return app


def main() -> None:
    import uvicorn

    key = os.environ.get("AUDIO_KEY", "")
    if not key:
        raise SystemExit("AUDIO_KEY is not set – refusing to start without a key")
    uvicorn.run(create_app(key), host=HOST, port=PORT)


if __name__ == "__main__":
    main()
