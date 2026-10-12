@echo off
rem P45B T11: reziser s logikou na lokalnim modelu (ops/llm/start.ps1 -Role fallback), zapise fixtury logic-answers a evals/play/p45b/director-logic.json.
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p45b/director-logic.cmd
call npx vitest run --config vitest.measure.mts evals/play/p45b/director-logic.measure.ts
exit /b %ERRORLEVEL%
