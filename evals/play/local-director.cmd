@echo off
rem P29B T9: lokalni zaloha rezisera na sade vernosti. Model v %P29B_FALLBACK% (gpt-oss-20b / qwen3.6-35b-a3b):
rem   set P29B_FALLBACK=gpt-oss-20b
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/local-director.cmd
node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/local-director.measure.ts --model %P29B_FALLBACK% --endpoint http://127.0.0.1:8792
