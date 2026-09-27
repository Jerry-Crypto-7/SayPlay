"""P30C T2: ověří prostředí Unsloth ve WSL bez načtení modelu do karty.

Vypíše verzi CUDA, název karty, volnou paměť a verze torch/unsloth/transformers/
peft/trl/bitsandbytes/triton. Končí 1, když torch CUDA nevidí nebo když Triton
nepřeloží svůj CUDA pomocník (bez `Python.h` spadne potichu na CPU a trénink
by běžel bez jeho jader); jinak 0.

    bash wsl.sh python env-check.py
"""

import os
import sys
from importlib.metadata import version

import torch

if not torch.cuda.is_available():
    print("CUDA: not available to torch", file=sys.stderr)
    sys.exit(1)

# Triton ověřit dřív, než ho Unsloth potichu odstaví.
import triton

try:
    target = triton.runtime.driver.active.get_current_target()
except Exception as error:  # noqa: BLE001 – jakákoli chyba tu znamená nepoužitelný Triton
    print(f"Triton: cannot build its CUDA helper ({error})", file=sys.stderr)
    sys.exit(1)

# Unsloth se importuje před transformers/peft/trl, jinak je nepřepíše.
import unsloth  # noqa: F401

free, total = torch.cuda.mem_get_info()
print(f"CUDA (torch build): {torch.version.cuda}")
print(f"GPU: {torch.cuda.get_device_name(0)}")
# Ve WSL číslo nevidí paměť, kterou drží procesy Windows (llama.cpp, ComfyUI) – platí nvidia-smi.
print(f"VRAM free/total (as WSL sees it): {free / 2**30:.1f} / {total / 2**30:.1f} GiB")
print(f"bf16: {torch.cuda.is_bf16_supported()}")
print(f"Triton target: {target.backend} {target.arch}")
print(f"Python: {sys.version.split()[0]} ({sys.executable})")
for package in (
    "torch",
    "unsloth",
    "unsloth-zoo",
    "transformers",
    "peft",
    "trl",
    "bitsandbytes",
    "triton",
    "datasets",
):
    print(f"{package}: {version(package)}")
print(
    f"HF_HOME: {os.environ.get('HF_HOME', '(unset – set it to /mnt/d/caches/huggingface)')}"
)
