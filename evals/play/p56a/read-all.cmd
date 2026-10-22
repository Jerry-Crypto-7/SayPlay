@echo off
rem P56A T4: dev sady prectene lokalnim gpt-oss-20b pod jednim serverem a zamkem GPU:
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p56a/read-all.cmd
rem Prikaz za -Then nesmi obsahovat mezery ani &&: zamek ho preda shellu, ktery ho rozdeli.
set READ=node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/p56a/read-set.ts --endpoint llamacpp:http://127.0.0.1:8792 --budget 60000
%READ% --set evals/play/p56a/audit-12.json || exit /b 1
%READ% --set evals/play/p55/holdout.json || exit /b 1
%READ% --set evals/play/p54c/dev.json || exit /b 1
%READ% --set evals/play/p54c/holdout.json || exit /b 1
%READ% --set evals/play/p30/dev.json || exit /b 1
%READ% --set evals/play/p43/panel.json
