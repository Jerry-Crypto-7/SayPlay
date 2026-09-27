# P30C – dotrénování gpt-oss-20b (volitelná stopa)

Plán: `plans/P30C-dotrenovani-gpt-oss-2026-09-27.md` (necommitovaný). Tady je kód a výsledky:

| Soubor | Co |
|---|---|
| `PROVIDER.md` | kdo umí sloužit vlastní LoRA pro gpt-oss-20b po tokenech (T1) |
| `pyproject.toml`, `uv.lock`, `.python-version` | pinované prostředí Unsloth pro WSL (T2) |
| `wsl.sh` | spustí příkaz v tom prostředí (uv, venv, cache modelů) |
| `env-check.py` | ověří CUDA, kartu, Triton a verze bez načtení modelu (T2) |

## Prostředí ve WSL (T2)

Předpoklady: WSL 2 s `Ubuntu-24.04`, ovladač NVIDIA ve Windows (WSL vidí kartu přes
`nvidia-smi`), `uv` v `~/.local/bin`. Ověřeno 27. 9. 2026: RTX 3090 24 GB, ovladač 610.60,
uv 0.12.1, Python 3.12.13 od uv, torch 2.12.1 s CUDA 13.0.

Instalace (jednou, ve WSL):

```bash
export PATH="$HOME/.local/bin:$PATH" UV_PROJECT_ENVIRONMENT="$HOME/.venvs/p30c" UV_PYTHON_PREFERENCE=only-managed
cd /mnt/d/claude/Hackaton-wt-p30c/training/p30
uv python install 3.12
uv sync --frozen          # jen podle uv.lock, nic nepřeresolvuje
```

Kontrola z Windows (Git Bash potřebuje `MSYS_NO_PATHCONV=1`, jinak přepíše cestu `/mnt/...`):

```bash
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu-24.04 -- bash /mnt/d/claude/Hackaton-wt-p30c/training/p30/wsl.sh python env-check.py
```

Vypíše verzi CUDA, kartu, cíl Tritonu a verze balíků; končí 0. Model se nenačítá.

Tři věci, na které se narazilo:

- **Python musí být od uv, ne systémový.** Ubuntu bez `python3-dev` nemá `Python.h`,
  Triton pak nepřeloží svůj CUDA pomocník a Unsloth potichu přepne jeho jádra na CPU
  („Triton is not supported on current platform, roll back to CPU“). `wsl.sh` proto
  nastavuje `UV_PYTHON_PREFERENCE=only-managed` a `env-check.py` v takovém případě končí 1.
- **`wsl.exe … bash -lc '…$PATH…'` nefunguje** – `$PATH` z Windows (mezery, závorky)
  se rozbalí dřív, než ho bash uvidí. Proměnné proto nastavuje `wsl.sh` uvnitř WSL.
- **Volná paměť karty ve WSL neplatí.** `torch.cuda.mem_get_info()` nevidí paměť, kterou
  drží procesy Windows (llama.cpp, ComfyUI); rozhoduje `nvidia-smi`.

Virtuální prostředí je na disku WSL (`~/.venvs/p30c`), ne na `/mnt/d` – import torch přes
souborový most Windows je pomalý. Cache modelů naopak na `D:` (`HF_HOME=/mnt/d/caches/huggingface`),
ať ji vidí i Windows.

Verze: `unsloth` 2026.9.11 drží `torch` pod 2.13 a sám si vybírá `transformers` 5.5.0
a `trl` 0.24.0. Novější `transformers`/`trl` z PyPI proto nepinovat ručně – rozbije to
resolvování. Aktualizace = zvednout `unsloth` a `unsloth-zoo`, `uv lock`, znovu `env-check.py`.

Velké soubory (váhy, checkpointy, GGUF) jen do `D:/caches/p30c/` (ve WSL `/mnt/d/caches/p30c/`);
`training/.gitignore` je z repa drží venku.
