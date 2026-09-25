# Play performance – `/play`

`e2e/play-perf.spec.ts` (tag `@measure`, outside `npm run test:e2e`) measures what one game costs in frames and bytes. Run it against a production build:

```
npm run build
npx next start --port 3131 --hostname 127.0.0.1
FALLBACK_SMOKE_URL=http://127.0.0.1:3131 npx playwright test e2e/play-perf.spec.ts --project=chromium --grep @measure
```

`PERF_OUT` sets the output file, `PERF_REPEATS` the repeat count (default 3), `PERF_GAMES` / `PERF_PROFILES` narrow the run (`runner,arena,grid-collect` / `desktop,moto-g-power-emulated`). Run it alone: a second browser on the same machine skews every number.

## What is measured

Three games published through `POST /api/play/games`, each in a fresh browser context (empty HTTP cache):

| id | sentence | scene |
|---|---|---|
| `runner` | jumping arcade game with a lot of obstacles | arcade, runner |
| `arena` | like agar.io but you are a fish eating smaller fish | arcade, `move_free` |
| `grid-collect` | Collect five glowing mushrooms then open a portal. | grid |

Two profiles:

- `desktop` – 1440×900, no throttling.
- `moto-g-power-emulated` – the DevTools "Moto G Power" preset (412×823, DPR 1.75, mobile, touch), CPU throttled ×4 and network "Fast 4G" (9 Mb/s down, 1.5 Mb/s up, 165 ms RTT) through CDP. **This is emulation, not a phone:** the GPU is still this machine's, only the CPU is slowed. Real phones go into `devices.md`.

Per run:

- `firstDrawMs` – first WebGL draw call after navigation start; `firstTickMs` – first game tick.
- A 10 s play window: arcade games play the verified demo ("Show me how"), the grid runs on its own. `fpsP50` / `fpsP5` from the median and 95th-percentile frame interval (p5 fps = the worst 5 % of frames), `maxFrameMs`, `drawnFps` (frames that issued a draw call).
- `calls` / `triangles` per frame, counted by wrapping `WebGL2RenderingContext.draw*` – the same numbers as `renderer.info.render`, without touching the game code.
- A 3 s paused window (hidden tab; arcade only – the grid has no pause) and a 3 s window on the result screen after the verifier's run ends the game. The tab is not really hidden, so `requestAnimationFrame` keeps running and `drawnFps` shows whether the scene still draws.
- Bytes from `performance.getEntriesByType('resource')`: `.glb`, `.js` and all, transferred and encoded.
- `gpu` – the unmasked WebGL renderer string, so software and hardware runs are never mixed up.

Each cell's `median` is the median of the runs; `runs` keeps every run.

## Baseline 2026-09-25 (`baseline-2026-09-25.json`)

Commit `82d924d`, Chromium 151.0.7922.34 headless, ANGLE D3D11 on an NVIDIA RTX 3090, Intel Xeon W-2245, 128 GB RAM, Windows 11. 3 runs per cell, no page errors, every run ended `won`.

| cell | first draw | fps p50 / p5 | max frame | calls / triangles | drawn fps paused / ended | GLB / JS / all (KB) |
|---|---|---|---|---|---|---|
| runner, desktop | 0.7 s | 60 / 60 | 67 ms | 442 / 29.3k | 54 / 59 | 258 / 559 / 825 |
| runner, phone (emul.) | 5.4 s | **10 / 5** | 200 ms | 416 / 27.9k | 13 / 29 | 258 / 559 / 825 |
| arena, desktop | 0.7 s | 60 / 60 | 50 ms | 37 / 4.0k | 59 / 59 | 0 / 559 / 566 |
| arena, phone (emul.) | 4.6 s | 60 / 20 | 117 ms | 19 / 2.1k | 56 / 58 | 0 / 559 / 566 |
| grid-collect, desktop | 1.0 s | 60 / 60 | 67 ms | 61 / 9.0k | – / 59 | 54 / 696 / 757 |
| grid-collect, phone (emul.) | 7.2 s | 60 / 15 | 350 ms | 61 / 9.0k | – / 52 | 54 / 696 / 757 |

What the numbers say:

- **Target missed on the phone profile.** fps p5 ≥ 30: no cell passes on the phone (5, 20, 15). First game ≤ 3 s on Fast 4G: no cell passes (4.6–7.2 s).
- **The runner is draw-call bound.** 416–442 draw calls per frame against 19–61 in the other two scenes; with the CPU slowed ×4 it drops to 10 fps. Triangles (28k) are not the problem.
- **Paused and finished games draw every frame** (F-33): 54–59 drawn fps on desktop while nothing moves.
- **Bytes are not what makes the first frame slow.** 566–825 KB at Fast 4G is about 1–1.5 s of the 4.6–7.2 s; the rest is main-thread CPU at ×4.
- **GLB is 0–31 % of the first game's bytes.**

## Decisions (P28E)

- **T2 – render on demand when the game is not running: ADOPT** (F-33, the numbers above). Before/after below.
- **T3 – catalog out of the client bundle: DEFER.** The trigger fired on time (first frame > 3 s), not on bytes (JS 559–696 KB < 1 MB). The chunk holding the catalog index is 65 KB transferred / 230 KB decoded of the runner's 825 KB; removing all of it saves at most ~0.15 s of 5.4 s. It cannot bring the first frame under 3 s; startup CPU has to be profiled first.
- **T4 – meshopt compression: DEFER.** The trigger is GLB > 40 % of the first game's bytes; measured 31 % (runner), 7 % (grid), 0 % (arena).

## T2 – render on demand (`after-t2-2026-09-25.json`)

The arcade canvas draws every frame only while the run is live (`running` and not paused); otherwise it draws on demand, and every change of the session (restart, end of run, pause, resume) requests one frame. The animation mixer of rigged characters steps at most 0.1 s per frame, so the first frame after a pause does not jump through the pause. The grid has no pause and is not touched.

Drawn frames per second, median of 3 runs, same machine and build flow:

| cell | paused before → after | ended before → after | playing before → after |
|---|---|---|---|
| runner, desktop | 54 → **0** | 59 → **1** | 57 → 55 |
| runner, phone (emul.) | 13 → **0** | 29 → **1** | 10 → 10 |
| arena, desktop | 59 → **0** | 59 → **1** | 58 → 15 * |
| arena, phone (emul.) | 56 → **0** | 58 → **1** | 50 → 6 * |

\* The arena demo wins in about 2.5 s, so most of its 10 s play window is the result screen, which no longer draws. While the arena runs, fps p50 stays 60 and the max frame stays 50 ms (desktop) / 133 ms (phone).

Phone-profile numbers move by up to ~30 % between runs of the same build on this machine (grid, untouched by T2: fps p50 60 → 30, first draw 7.2 → 8.3 s); other sessions share the CPU. Compare desktop cells for small differences.
