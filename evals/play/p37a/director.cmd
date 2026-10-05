@echo off
rem P37A T8: vyhraje AI verze nad navrhem? Lokalni gpt-oss-20b nad dev-150, cele pod zamkem GPU:
rem   node D:/claude/_shared/gpu-lock.mjs --wait-max 1500 -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p37a/director.cmd
node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p37a/director.measure.ts --model gpt-oss-20b --endpoint http://127.0.0.1:8792
