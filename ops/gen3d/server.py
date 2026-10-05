"""Služba: podstatné jméno -> GLB na lokální kartě, za klíčem, s cache a frontou jedné úlohy.

    GEN3D_KEY=... uv run server.py        # jen 127.0.0.1:8790, ComfyUI musí běžet na :8188

POST /generate {"noun": "penguin"} -> {"jobId"}; GET /jobs/{id} -> stav a cesty; GET /health.
Každá cesta chce hlavičku X-Gen3d-Key shodnou s GEN3D_KEY, jinak 401.
"""

from __future__ import annotations

import copy
import hmac
import json
import os
import queue
import re
import threading
import tomllib
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

import cache
from comfy_client import ComfyClient, outputs_of
from finish import finish

HERE = Path(__file__).resolve().parent
HOST, PORT = "127.0.0.1", 8790
MAX_QUEUE = 50  # ~40 min práce karty; víc čekajících slov dostane 429
CONFIG = tomllib.loads((HERE / "config.toml").read_text(encoding="utf-8"))
WORKFLOWS = json.loads(
    (HERE / "workflows" / "text_to_glb.json").read_text(encoding="utf-8")
)


# Cesta Windows (C:\… i UNC \\server\…) v textu výjimky; nahradí se jménem souboru.
WINDOWS_PATH = re.compile(r"(?:[A-Za-z]:|\\\\[^\\\s]+)\\[^\s'\"]*")


class GenerateRequest(BaseModel):
    noun: str


def public_reason(error: Exception) -> str:
    """Typ výjimky + krátká zpráva bez cest disku (a tedy bez jména uživatele)."""
    message = WINDOWS_PATH.sub(lambda m: m.group(0).rsplit("\\", 1)[-1], str(error))
    return f"{type(error).__name__}: {message}"[:300]


@dataclass
class Job:
    id: str
    noun: str
    status: str = "queued"  # queued | running | done | failed
    result: dict = field(default_factory=dict)
    reason: str | None = None

    def view(self, cache_root: Path) -> dict:
        body = {"jobId": self.id, "noun": self.noun, "status": self.status}
        if self.status == "done":
            # Relativně ke cache: klient zná kořen cache, absolutní cesta by prozradila disk.
            def rel(key: str) -> str:
                return (
                    Path(self.result[key]).resolve().relative_to(cache_root).as_posix()
                )

            body.update(
                glb=rel("lod0"),
                lod1=rel("lod1"),
                preview=rel("preview"),
                gate=self.result["gate"],
            )
        if self.reason:
            body["reason"] = self.reason
        return body


# Uzel a pole semínka obrázku v každém grafu; jiné semínko = jiný obrázek = jiná síť (P37D T2).
IMAGE_SEED = {"klein": ("noise", "noise_seed"), "zimage": ("sampler", "seed")}


def generate(comfy: ComfyClient, noun: str, out_dir: Path, seed: int = 0) -> dict:
    """Obrázek -> TRELLIS.2 -> dodělávka. Vyhazuje výjimku s důvodem, když cokoliv selže."""
    name = out_dir.name
    image_graph = copy.deepcopy(WORKFLOWS[f"image_{CONFIG['image_model']}"])
    image_graph["prompt"]["inputs"]["text"] = CONFIG["prompt"].format(noun=noun)
    node, field = IMAGE_SEED[CONFIG["image_model"]]
    image_graph[node]["inputs"][field] = seed
    image_graph["save_image"]["inputs"]["filename_prefix"] = f"gen3d/{name}"
    image = outputs_of(comfy.run(image_graph), "save_image")[0]

    mesh_graph = copy.deepcopy(WORKFLOWS["mesh"])
    mesh_graph["load_image"]["inputs"]["image"] = (
        f"{image.subfolder}/{image.filename} [output]"
    )
    mesh_graph["save_glb"]["inputs"]["filename_prefix"] = f"gen3d/{name}"
    raw = comfy.download(
        outputs_of(comfy.run(mesh_graph), "save_glb")[0], out_dir / "raw.glb"
    )

    result = finish(raw, out_dir, name)
    raw.unlink()
    if not result["gate"]["passed"]:
        raise RuntimeError("quality gate: " + "; ".join(result["gate"]["reasons"]))
    return result


def create_app(key: str, comfy: ComfyClient, cache_root: Path | None = None) -> FastAPI:
    if not key:
        raise ValueError("GEN3D_KEY must be set")
    expected = key.encode("utf-8")
    jobs: dict[str, Job] = {}
    by_slug: dict[str, Job] = {}
    pending: queue.Queue[Job] = queue.Queue()
    lock = threading.Lock()

    def require_key(x_gen3d_key: str | None = Header(default=None)) -> None:
        if x_gen3d_key is None or not hmac.compare_digest(
            x_gen3d_key.encode("utf-8"), expected
        ):
            raise HTTPException(status_code=401, detail="missing or wrong X-Gen3d-Key")

    def worker() -> None:
        while True:
            job = pending.get()
            job.status = "running"
            out_dir = cache.entry_dir(job.noun, cache_root)
            try:
                out_dir.mkdir(parents=True, exist_ok=True)
                job.result = cache.store(
                    job.noun, generate(comfy, job.noun, out_dir), cache_root
                )
                job.status = "done"
            except Exception as error:  # noqa: BLE001 – úloha skončí failed s důvodem, nikdy nevisí
                job.reason = public_reason(error)
                job.status = "failed"
            finally:
                pending.task_done()

    # Vestavěné /docs, /redoc a /openapi.json by klíč obešly – služba je nemá.
    app = FastAPI(
        title="gen3d",
        dependencies=[Depends(require_key)],
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    threading.Thread(target=worker, daemon=True, name="gen3d-worker").start()
    app.state.jobs = jobs

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "comfy": comfy.alive(), "queued": pending.qsize()}

    @app.post("/generate")
    def submit(request: GenerateRequest) -> dict:
        try:
            noun = cache.normalize(request.noun)
            slug = cache.slug(noun)
            cache.entry_dir(noun, cache_root)
        except cache.InvalidNoun as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        with lock:
            active = by_slug.get(slug)
            if active and active.status in ("queued", "running"):
                return {"jobId": active.id}
            job = Job(uuid.uuid4().hex, noun)
            hit = cache.lookup(noun, cache_root)
            if hit and Path(hit["lod0"]).exists():
                job.status, job.result = "done", hit
            elif pending.qsize() >= MAX_QUEUE:
                raise HTTPException(status_code=429, detail="queue is full")
            else:
                pending.put(job)
            jobs[job.id] = by_slug[slug] = job
        return {"jobId": job.id}

    @app.get("/jobs/{job_id}")
    def status(job_id: str) -> dict:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown job")
        return job.view((cache_root or cache.CACHE_ROOT).resolve())

    return app


def main() -> None:
    import uvicorn

    key = os.environ.get("GEN3D_KEY", "")
    if not key:
        raise SystemExit("GEN3D_KEY is not set – refusing to start without a key")
    uvicorn.run(create_app(key, ComfyClient()), host=HOST, port=PORT)


if __name__ == "__main__":
    main()
