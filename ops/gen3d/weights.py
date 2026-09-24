"""Váhy, které generování potřebuje: odkud, v jaké revizi a pod jakou licencí.

Stahuje se do HF_HOME (D:/caches/huggingface) a ComfyUI je najde přes
`extra_model_paths.yaml`, takže nic se nekopíruje dvakrát.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

COMFY_DIR = Path(os.environ.get("GEN3D_COMFY_DIR", "D:/tools/comfyui"))
HF_HOME = Path(os.environ.get("HF_HOME", "D:/caches/huggingface"))


@dataclass(frozen=True)
class Weight:
    path: str  # cesta v repozitáři
    folder: str  # typ složky v ComfyUI (folder_paths)
    # Licence souboru, když se liší od karty repozitáře (přebalené cizí váhy).
    license_override: str | None = None
    license_source: str | None = None


@dataclass(frozen=True)
class Repo:
    repo_id: str
    revision: str
    role: str
    weights: tuple[Weight, ...] = field(default_factory=tuple)


# Revize jsou přišpendlené – nová verze vah se přeměří, ne tiše stáhne.
REPOS: tuple[Repo, ...] = (
    Repo(
        "Comfy-Org/TRELLIS.2",
        "430a9d09b2416687018c8fe8edced2ad4858a439",
        "image to 3D (TRELLIS.2-4B, microsoft)",
        (
            Weight("diffusion_models/trellis_2_bf16.safetensors", "diffusion_models"),
            Weight("vae/trellis_2_shape_vae_bf16.safetensors", "vae"),
            Weight("vae/trellis_2_texture_vae_bf16.safetensors", "vae"),
            # Karta přebaleného repa říká MIT, ale kodér obrázku je DINOv3 od Meta
            # pod vlastní licencí (komerční použití dovoleno, omezení podle účelu).
            Weight(
                "clip_vision/dino_v3_vit_l.safetensors",
                "clip_vision",
                license_override="LicenseRef-DINOv3",
                license_source="https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md",
            ),
        ),
    ),
    Repo(
        "Comfy-Org/z_image_turbo",
        "6fc90a3b1b653e935a0d175e260736de25b84df5",
        "text to image (Z-Image-Turbo) + shared Qwen3-4B text encoder",
        (
            Weight(
                "split_files/diffusion_models/z_image_turbo_bf16.safetensors",
                "diffusion_models",
            ),
            Weight("split_files/text_encoders/qwen_3_4b.safetensors", "text_encoders"),
            Weight("split_files/vae/ae.safetensors", "vae"),
        ),
    ),
    Repo(
        "Comfy-Org/flux2-klein-4B",
        "5f526678002e43af5551dadb73ce2e8c91b43afe",
        "text to image (FLUX.2 klein 4B); text encoder shared with Z-Image (same sha256)",
        (
            Weight(
                "split_files/diffusion_models/flux-2-klein-4b.safetensors",
                "diffusion_models",
            ),
            Weight("split_files/vae/flux2-vae.safetensors", "vae"),
        ),
    ),
    Repo(
        "Comfy-Org/BiRefNet",
        "25511f8787e51912e1480706b4e47b8f467fbf72",
        "background removal (BiRefNet)",
        (Weight("background_removal/birefnet.safetensors", "background_removal"),),
    ),
)


def snapshot_dir(repo: Repo) -> Path:
    name = "models--" + repo.repo_id.replace("/", "--")
    return HF_HOME / "hub" / name / "snapshots" / repo.revision


def fetch() -> None:
    from huggingface_hub import hf_hub_download

    for repo in REPOS:
        for filename in ("README.md", *(w.path for w in repo.weights)):
            print(f"fetch {repo.repo_id}/{filename}", flush=True)
            hf_hub_download(repo.repo_id, filename, revision=repo.revision)


def extra_model_paths() -> dict:
    config: dict = {}
    for repo in REPOS:
        folders: dict[str, str] = {}
        for w in repo.weights:
            folders.setdefault(w.folder, str(Path(w.path).parent).replace("\\", "/"))
        key = (
            "gen3d_"
            + repo.repo_id.split("/")[1].replace(".", "_").replace("-", "_").lower()
        )
        config[key] = {
            "base_path": str(snapshot_dir(repo)).replace("\\", "/"),
            **folders,
        }
    return config


def write_extra_model_paths() -> Path:
    import yaml

    target = COMFY_DIR / "extra_model_paths.yaml"
    target.write_text(
        yaml.safe_dump(extra_model_paths(), sort_keys=False), encoding="utf-8"
    )
    return target


if __name__ == "__main__":
    fetch()
    print(f"wrote {write_extra_model_paths()}")
