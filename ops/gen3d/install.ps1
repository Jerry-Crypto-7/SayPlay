# Instalace ComfyUI s nativním TRELLIS.2 a stažení vah pro ops/gen3d.
# Idempotentní: druhé spuštění nic nestahuje znovu a jen ověří stav.
# ComfyUI (GPL-3.0) je samostatný nástroj mimo repo, stejně jako Blender –
# do repa ani do dema se z něj nic nedostane.
$ErrorActionPreference = 'Stop'

$Comfy = if ($env:GEN3D_COMFY_DIR) { $env:GEN3D_COMFY_DIR } else { 'D:\tools\comfyui' }
$ComfyCommit = '1568e6cfd04586a4b3c4e1817ea7dde09b1bf9e7'  # 0.37.0, 2026-09-23
if (-not $env:HF_HOME) { $env:HF_HOME = 'D:\caches\huggingface' }
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Invoke-Checked([string]$What, [scriptblock]$Block) {
    Write-Host "== $What"
    & $Block
    if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE" }
}

if (-not (Test-Path "$Comfy\.git")) {
    Invoke-Checked 'clone ComfyUI' { git clone https://github.com/comfyanonymous/ComfyUI.git $Comfy }
}
$head = git -C $Comfy rev-parse HEAD
if ($head -ne $ComfyCommit) {
    Invoke-Checked 'fetch ComfyUI' { git -C $Comfy fetch --depth 200 origin master }
    Invoke-Checked 'checkout pinned ComfyUI' { git -C $Comfy checkout --detach $ComfyCommit }
}

$Py = "$Comfy\.venv\Scripts\python.exe"
if (-not (Test-Path $Py)) {
    Invoke-Checked 'create ComfyUI venv' { uv venv --python 3.12 "$Comfy\.venv" }
}
# Torch s CUDA 12.8 (RTX 3090 = sm_86) musí přijít dřív než requirements,
# jinak pip vezme CPU build z PyPI.
Invoke-Checked 'torch with CUDA' {
    uv pip install --python $Py torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
}
Invoke-Checked 'ComfyUI requirements' { uv pip install --python $Py -r "$Comfy\requirements.txt" }

Invoke-Checked 'download weights' { uv run --project $Here python "$Here\weights.py" }
Invoke-Checked 'check install' { uv run --project $Here python "$Here\check_install.py" }
