"""Tenký klient HTTP API ComfyUI: poslat workflow, počkat na výsledek, stáhnout soubor."""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8188"


class ComfyError(RuntimeError):
    pass


@dataclass(frozen=True)
class OutputFile:
    filename: str
    subfolder: str
    type: str


class ComfyClient:
    def __init__(self, base_url: str = DEFAULT_URL, timeout_s: float = 600.0):
        self.base_url = base_url.rstrip("/")
        self.timeout_s = timeout_s
        self.client_id = uuid.uuid4().hex

    def _get(self, path: str) -> bytes:
        with urllib.request.urlopen(self.base_url + path, timeout=30) as response:
            return response.read()

    def _post_json(self, path: str, body: dict) -> dict:
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise ComfyError(
                f"POST {path} -> {error.code}: {error.read()[:2000]!r}"
            ) from error

    def alive(self) -> bool:
        try:
            self._get("/system_stats")
            return True
        except OSError:
            return False

    def submit(self, workflow: dict) -> str:
        reply = self._post_json(
            "/prompt", {"prompt": workflow, "client_id": self.client_id}
        )
        if reply.get("node_errors"):
            raise ComfyError(f"workflow rejected: {reply['node_errors']}")
        return reply["prompt_id"]

    def wait(self, prompt_id: str, poll_s: float = 0.5) -> dict:
        """Počká na dokončení a vrátí záznam z /history. Chyba ComfyUI -> ComfyError."""
        deadline = time.monotonic() + self.timeout_s
        while time.monotonic() < deadline:
            history = json.loads(self._get(f"/history/{prompt_id}"))
            entry = history.get(prompt_id)
            if entry and entry.get("status", {}).get("completed") is not None:
                status = entry["status"]
                if status.get("status_str") != "success":
                    raise ComfyError(
                        f"prompt {prompt_id} failed: {_error_message(status)}"
                    )
                return entry
            time.sleep(poll_s)
        raise ComfyError(f"prompt {prompt_id} did not finish in {self.timeout_s:.0f} s")

    def run(self, workflow: dict) -> dict:
        return self.wait(self.submit(workflow))

    def download(self, output: OutputFile, target: Path) -> Path:
        query = urllib.parse.urlencode(
            {
                "filename": output.filename,
                "subfolder": output.subfolder,
                "type": output.type,
            }
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(self._get(f"/view?{query}"))
        return target


def outputs_of(entry: dict, node_id: str) -> list[OutputFile]:
    """Soubory, které vydal daný uzel (obrázky i 3D modely)."""
    node = entry.get("outputs", {}).get(node_id, {})
    files = []
    for key in ("images", "3d", "model_3d", "meshes", "files"):
        for item in node.get(key, []) or []:
            if isinstance(item, dict) and "filename" in item:
                files.append(
                    OutputFile(
                        item["filename"],
                        item.get("subfolder", ""),
                        item.get("type", "output"),
                    )
                )
    return files


def _error_message(status: dict) -> str:
    for kind, data in status.get("messages", []):
        if kind == "execution_error":
            return (
                f"{data.get('node_type')}: {data.get('exception_message', '').strip()}"
            )
    return status.get("status_str", "unknown")
