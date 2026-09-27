#!/usr/bin/env bash
# Prostředí P30C ve WSL: uv, venv na disku WSL (import přes /mnt je pomalý),
# cache modelů na D:. Spouští příkaz v zamčeném prostředí z uv.lock:
#   wsl.exe -d Ubuntu-24.04 -- bash /mnt/d/claude/Hackaton-wt-p30c/training/p30/wsl.sh python env-check.py
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export UV_PROJECT_ENVIRONMENT="$HOME/.venvs/p30c"
# Python od uv má hlavičky (Python.h); systémový Ubuntu bez python3-dev ne a Triton
# pak nepřeloží svůj CUDA pomocník a tiše spadne na CPU.
export UV_PYTHON_PREFERENCE=only-managed
export HF_HOME=/mnt/d/caches/huggingface
cd "$(dirname "$0")"
exec uv run --frozen "$@"
