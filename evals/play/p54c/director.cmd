@echo off
rem P54C T14: zivy reziser nad dev sadou P54C (gpt-oss-20b lokalne). Skupiny a strop volani z prostredi (P54C_GROUPS, P54C_CALL_BUDGET):
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p54c/director.cmd
call npx vitest run --config vitest.measure.mts evals/play/p54c/director.measure.ts --reporter=dot
exit /b %ERRORLEVEL%
