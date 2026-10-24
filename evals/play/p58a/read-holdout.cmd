@echo off
rem P58A T9: zapecetena sada prectena lokalnim gpt-oss-20b jednou, po openSealedOnce; brana pak cteni prehrava jako T1 a T8.
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p58a/read-holdout.cmd
set READ=node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/p56a/read-set.ts --endpoint llamacpp:http://127.0.0.1:8792 --budget 60000
%READ% --set evals/play/p58a/holdout.json --out evals/play/p58a/readings/holdout.gpt-oss-20b.json
