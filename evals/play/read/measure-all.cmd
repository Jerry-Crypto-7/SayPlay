@echo off
rem P29B T3: cele mereni ctecky pod jednim serverem. Spoustet pres zamek GPU:
rem   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role reader -Then evals/play/read/measure-all.cmd
rem Prikaz za -Then nesmi obsahovat mezery ani &&: zamek ho preda shellu, ktery ho rozdeli.
node --experimental-strip-types scripts/play-fidelity.mjs --offline --reader http://127.0.0.1:8791 --run p29b-reader || exit /b 1
node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/read/measure.ts --reader http://127.0.0.1:8791 --run p29b-reader
