# Installs the llama.cpp Windows CUDA build and the chosen GGUF models.
# Idempotent: existing files are skipped, partial downloads resume (curl.exe -C -).
# Usage: powershell -ExecutionPolicy Bypass -File ops/llm/install.ps1 [-SkipModels] [-Cuda 12.4]
param(
  [string]$LlamaDir = $(if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } else { 'D:/tools/llama.cpp' }),
  [string]$GgufDir = $(if ($env:GGUF_DIR) { $env:GGUF_DIR } else { 'D:/caches/gguf' }),
  # 12.4 on purpose: the driver on this machine exposes CUDA 13.3, the 13.x build targets 13.4.
  [string]$Cuda = '12.4',
  [switch]$SkipModels
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Reader + fallback director candidates (see ops/llm/README.md for the decision rule).
$Models = @(
  @{ Repo = 'unsloth/Qwen3-4B-Instruct-2507-GGUF'; File = 'Qwen3-4B-Instruct-2507-Q5_K_M.gguf' },
  @{ Repo = 'ggml-org/gpt-oss-20b-GGUF';           File = 'gpt-oss-20b-MXFP4.gguf' },
  @{ Repo = 'unsloth/Qwen3.6-35B-A3B-GGUF';        File = 'Qwen3.6-35B-A3B-UD-IQ3_S.gguf' }
)

function Get-File([string]$Url, [string]$Dest) {
  if (Test-Path $Dest) { Write-Host "skip  $Dest"; return }
  $part = "$Dest.part"
  Write-Host "get   $Url"
  # Windows PowerShell 5.1 turns native stderr into a terminating error under 'Stop'.
  $ErrorActionPreference = 'Continue'
  # System curl on purpose: a curl.exe earlier on PATH (Git's mingw64) may be blocked.
  & "$env:SystemRoot\System32\curl.exe" -sS -L --fail --retry 5 --retry-delay 5 -C - -o $part $Url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $Url" }
  Move-Item -Force $part $Dest
}

New-Item -ItemType Directory -Force -Path $LlamaDir, $GgufDir | Out-Null

# --- llama.cpp -------------------------------------------------------------
if (Test-Path (Join-Path $LlamaDir 'llama-server.exe')) {
  Write-Host "skip  llama.cpp ($(Get-Content -ErrorAction SilentlyContinue (Join-Path $LlamaDir 'BUILD.txt')))"
} else {
  # Builds are published as prereleases, so /releases/latest is not the newest build.
  $releases = Invoke-RestMethod -Headers @{ 'User-Agent' = 'ops-llm-install' } `
    'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10'
  $bin = $null; $rt = $null; $tag = $null
  foreach ($r in $releases) {
    $bin = $r.assets | Where-Object { $_.name -like "llama-*-bin-win-cuda-$Cuda-x64.zip" } | Select-Object -First 1
    $rt = $r.assets | Where-Object { $_.name -eq "cudart-llama-bin-win-cuda-$Cuda-x64.zip" } | Select-Object -First 1
    if ($bin -and $rt) { $tag = $r.tag_name; break }
  }
  if (-not $tag) { throw "no release with win-cuda-$Cuda-x64 assets among the last 10" }
  $tmp = Join-Path $LlamaDir '_download'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  foreach ($a in @($bin, $rt)) {
    $zip = Join-Path $tmp $a.name
    Get-File $a.browser_download_url $zip
    Expand-Archive -Force -Path $zip -DestinationPath $LlamaDir
  }
  # The binary zip may nest everything in a subfolder; flatten it.
  $nested = Get-ChildItem -Path $LlamaDir -Recurse -Filter 'llama-server.exe' | Select-Object -First 1
  if (-not $nested) { throw 'llama-server.exe not found after extraction' }
  if ($nested.DirectoryName -ne (Resolve-Path $LlamaDir).Path) {
    Get-ChildItem $nested.DirectoryName | Move-Item -Force -Destination $LlamaDir
  }
  Set-Content -Path (Join-Path $LlamaDir 'BUILD.txt') -Value "$tag win-cuda-$Cuda-x64"
  Remove-Item -Recurse -Force $tmp
  Write-Host "ok    llama.cpp $tag -> $LlamaDir"
}

# --- models ----------------------------------------------------------------
if (-not $SkipModels) {
  foreach ($m in $Models) {
    Get-File "https://huggingface.co/$($m.Repo)/resolve/main/$($m.File)" (Join-Path $GgufDir $m.File)
  }
}
Write-Host 'done'
