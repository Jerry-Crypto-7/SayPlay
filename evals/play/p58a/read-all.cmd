@echo off
rem P58A T1: dev sady viditelnosti prectene lokalnim gpt-oss-20b jednou; vychozi stav (T1) i dev kontrola (T8) je prehravaji.
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p58a/read-all.cmd
rem Prikaz za -Then nesmi obsahovat mezery ani &&: zamek ho preda shellu, ktery ho rozdeli.
set READ=node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/p56a/read-set.ts --endpoint llamacpp:http://127.0.0.1:8792 --budget 60000
%READ% --set evals/play/p56a/audit-12.json --out evals/play/p58a/readings/audit-12.gpt-oss-20b.json || exit /b 1
%READ% --set evals/play/p56a/holdout.json --out evals/play/p58a/readings/p56a-holdout.gpt-oss-20b.json
