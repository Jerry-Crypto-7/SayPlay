@echo off
rem P46E T5: nahraje odpovedi rezisera (gpt-oss-20b lokalne) pro evals/play/p46e/sentences.json do src/play/director/__fixtures__/p46-answers.
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p46e/record.cmd
set P45B_SENTENCES=evals/play/p46e/sentences.json
set P45B_ANSWERS=src/play/director/__fixtures__/p46-answers
set P45B_OUT=evals/play/p46e/director-logic.json
call npx vitest run --config vitest.measure.mts evals/play/p45b/director-logic.measure.ts
exit /b %ERRORLEVEL%
