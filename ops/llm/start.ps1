# Spusti lokalni llama.cpp server P29B: ctecka vety (8791) nebo zalozni reziser (8792).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role reader
#   powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback [-Fallback gpt-oss-20b|qwen3.6-35b-a3b]
#
# Bez -Then server bezi dal a skript vypise jeho PID (zastavit: Stop-Process -Id <PID>).
# S -Then "<prikaz>" pocka na /health, pusti prikaz, server zastavi podle PID a vrati
# navratovy kod prikazu. Mereni jde cele pod zamkem GPU:
#   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role reader -Then evals/play/read/measure-all.cmd
# Zamek preda prikaz shellu, ktery ho rozdeli podle mezer a && provede sam (mimo server):
# za -Then proto patri jeden skript bez mezer, nikdy "node ... && node ...".
param(
  [ValidateSet('reader', 'fallback')][string]$Role = 'reader',
  # Zvoleny model zalohy (T9): viz ops/llm/README.md a evals/play/read/README.md.
  [ValidateSet('gpt-oss-20b', 'qwen3.6-35b-a3b')][string]$Fallback = 'gpt-oss-20b',
  [string]$Then = '',
  [int]$HealthTimeoutSec = 180
)
$ErrorActionPreference = 'Stop'

$llama = if ($env:LLAMA_CPP_DIR) { $env:LLAMA_CPP_DIR } else { 'D:/tools/llama.cpp' }
$gguf = if ($env:GGUF_DIR) { $env:GGUF_DIR } else { 'D:/caches/gguf' }

$models = @{
  'reader'          = @{ File = 'Qwen3-4B-Instruct-2507-Q5_K_M.gguf'; Port = 8791; Ctx = 4096 }
  'gpt-oss-20b'     = @{ File = 'gpt-oss-20b-MXFP4.gguf'; Port = 8792; Ctx = 16384 }
  'qwen3.6-35b-a3b' = @{ File = 'Qwen3.6-35B-A3B-UD-IQ3_S.gguf'; Port = 8792; Ctx = 16384 }
}
$pick = if ($Role -eq 'reader') { $models['reader'] } else { $models[$Fallback] }
$model = Join-Path $gguf $pick.File
$server = Join-Path $llama 'llama-server.exe'
foreach ($path in @($server, $model)) { if (-not (Test-Path $path)) { throw "missing $path - run ops/llm/install.ps1" } }

# -np 1: jeden slot, ctecka i zaloha odpovidaji po jedne; --jinja kvuli chat sablone modelu.
$arguments = @('-m', $model, '--host', '127.0.0.1', '--port', $pick.Port, '-ngl', '99', '-c', $pick.Ctx, '-np', '1', '--jinja', '--no-webui')
$process = Start-Process -FilePath $server -ArgumentList $arguments -PassThru -WindowStyle Hidden
Write-Output "llama-server $Role ($($pick.File)) pid $($process.Id) port $($pick.Port)"

$deadline = (Get-Date).AddSeconds($HealthTimeoutSec)
$healthy = $false
while ((Get-Date) -lt $deadline -and -not $process.HasExited) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($pick.Port)/health" -TimeoutSec 2
    if ($health.status -eq 'ok') { $healthy = $true; break }
  } catch { }
  Start-Sleep -Milliseconds 500
}
if (-not $healthy) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
  throw "llama-server $Role did not become healthy within $HealthTimeoutSec s"
}
Write-Output "healthy: http://127.0.0.1:$($pick.Port)"
if ($Then -eq '') { exit 0 }
# Skript z -Then smi mit lomitka (evals/play/read/measure-all.cmd); cmd /c potrebuje zpetna.
if (Test-Path -LiteralPath $Then -PathType Leaf) { $Then = "`"$((Resolve-Path -LiteralPath $Then).Path)`"" }

try {
  cmd /c $Then
  $code = $LASTEXITCODE
} finally {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  Write-Output "stopped pid $($process.Id)"
}
exit $code
