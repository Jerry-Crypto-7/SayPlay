# FlashWorld spike: klon, prostředí a jedna scéna přes sdílený GPU zámek.
# Jen pro zopakování měření – váhy FlashWorld jsou dnes CC-BY-NC-SA-4.0 (evals/play/env/flashworld.md).
param(
  [string]$Tools = "D:/tools/flashworld",
  [string]$Out = "$env:TEMP/flashworld-out"
)
$ErrorActionPreference = "Stop"
$env:HF_HOME = "D:/caches/huggingface"

if (-not (Test-Path $Tools)) {
  git clone --depth 1 https://github.com/imlixinyang/FlashWorld.git $Tools
}
Push-Location $Tools
try {
  if (-not (Test-Path ".venv")) {
    uv venv --python 3.12
    uv pip install torch==2.6.0 torchvision==0.21.0 --index-url https://download.pytorch.org/whl/cu124
    uv pip install -r requirements.txt
  }
  nvidia-smi --query-gpu=memory.used,memory.total --format=csv
  New-Item -ItemType Directory -Force $Out | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  node D:/claude/_shared/gpu-lock.mjs -- .venv/Scripts/python cli.py --input_dir examples --output_dir $Out --spz --offload_t5 --offload_vae
  $sw.Stop()
  "seconds: $([math]::Round($sw.Elapsed.TotalSeconds, 1))"
  Get-ChildItem $Out -Recurse -Filter *.spz | Select-Object FullName, Length
} finally {
  Pop-Location
}
