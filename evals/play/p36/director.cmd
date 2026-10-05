@echo off
rem P36A T9: reziser s poli hloubky na lokalnim modelu (ops/llm/start.ps1 -Role fallback), zapise evals/play/p36/director.json.
rem Model a adresa v %P36_DIRECTOR_MODEL% / %P36_DIRECTOR_ENDPOINT% (vychozi gpt-oss-20b, http://127.0.0.1:8792):
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p36/director.cmd
call npx vitest run --config vitest.measure.mts evals/play/p36/director.measure.ts
exit /b %ERRORLEVEL%
