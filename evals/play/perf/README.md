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

## R1 – runner stops drawing the whole track (`after-r1-2026-09-25.json`)

Profiled on the emulated phone (CDP `Profiler`): the runner's frame went to React re-rendering every body of the track 20× a second (the HUD's tick re-rendered the canvas with a new `cast` object), then to three.js matrix updates and culling over the whole track. Three changes:

- The arcade canvas is `memo` with a memoized `cast`; the HUD re-renders per tick, the canvas does not (the scene reads the session in `useFrame`).
- The camera's far plane is the look's fog end. Past it every pixel is sky colour, so nothing visible is lost.
- Bodies further than the far plane (+12 m) are hidden and left out of the matrix update.

| runner | calls / frame | fps p50 / p5 phone (emul.) | fps p50 / p5 desktop |
|---|---|---|---|
| baseline | 416–442 | 10 / 5 | 60 / 60 |
| after R1 | 188–198 | **30 / 12** | 60 / 60 |

p5 ≥ 30 on the phone profile is still not reached: 35 % of the profile is native work (`(program)`, GPU commands under a ×4-slowed CPU) that this machine cannot attribute further; real phones (`devices.md`) decide whether it matters. `e2e/play-arcade.spec.ts` pins the median draw calls at ≤ 250 (the whole track was 490).

## R2 – what the first frame waits for (`before-r2-2026-09-25.json` → `after-r2-2026-09-25.json`)

A CDP `Profiler` (sampling every 0.5 ms) ran from navigation to the first draw and the first tick on the phone profile, 3 runs per game. The script was temporary and is not in the repo.

**What it showed.** From about 0.25 s to the first frame the main thread is 90–100 % busy. There is one gap of about 0.25 s while the lazily loaded three.js chunks download. The first frame is CPU-bound. Bytes are not the problem.

Busy time up to the first frame, split by what was on the stack (run 2 of 3):

| share of busy time | runner (4.3 s) | arena (3.9 s) | grid (6.9 s) |
|---|---|---|---|
| React / R3F render and commit (incl. three.js objects built during render) | 31 % | 30 % | 26 % |
| Native: JS parse and compile, style and layout, GPU commands | 27 % | 25 % | 45 % |
| Module evaluation, not counting Zod | 22 % | 26 % | 10 % |
| Module evaluation: building Zod schemas | 15 % | 12 % | 10 % |
| three.js waiting for shaders to link | 2 % | 1 % | 1 % |

Top 10 by self time (runner, run 2; minified names mapped to their source):

| # | self time | what it is |
|---|---|---|
| 1 | 1165 ms (24 %) | `(program)`: native parse, compile, layout, GPU |
| 2 | 631 ms (13 %) | the webpack `require` – mostly lazy compilation of module bodies on first use |
| 3 | 122 ms | the Zod v4 `$constructor` init, run for every schema built at module load |
| 4 | 85 ms | the R3F reconciler (a second React reconciler) commit loop |
| 5 | 64 ms | three.js `WebGLProgram` shader check (`getProgramInfoLog`, waits for the link) |
| 6 | 61 ms | `GLTFLoader` constructor and plugin registration |
| 7 | 60 ms | Zod `ZodType` init (the classic API binds every method per schema) |
| 8 | 55 ms | GC |
| 9 | 55 ms | Zod `check` (constraints like `.min().max()` added per schema) |
| 10 | 48 ms | other Zod core code (same chunk as #3) |

Where the Zod time comes from (inclusive, runner): `src/shape/schema.ts` 120–180 ms, reached through the mesh worker's in-thread fallback that `PlayShell` imported for the grid. Then the arcade contract and pieces 50–100 ms, the worldstream and IR schemas 40–55 ms, and the asset and scene schemas 40–60 ms. In the grid, parsing the 761 KB asset catalog with `assetCatalogSchema.parse` at module load takes a further 490 ms.

**Fix taken: the arcade no longer loads the grid game.** `PlayShell` imported `GridShell` statically, which brought the worldstream runtime, the mesh client, `src/shape/schema.ts` and the IR schemas into every arcade start. `GridShell` now has its own file and is loaded with `next/dynamic` (still rendered on the server). `timerLeft` moved out of `Hud.tsx` into `timer.ts`, so `ArcadePlay` no longer imports the grid HUD.

T1 probe, phone profile (emulated), median of 3, same machine and same session, build before → after:

| cell | first draw | first tick | JS transferred |
|---|---|---|---|
| runner | 5.1 → 5.1 s (runs 5.8/5.1/4.4 → 5.3/5.1/4.4) | 5.9 → 5.8 s | 559 → **485 KB** |
| arena | 5.6 → **4.6 s** (6.2/5.6/5.2 → 4.7/4.6/4.3) | 5.9 → 4.8 s | 559 → **485 KB** |
| grid-collect | 7.0 → 6.2 s (7.0/6.8/8.9 → 6.9/6.2/5.9) | 6.0 → 5.1 s | 696 → 697 KB |

The profiling script's own runs (the profiler adds overhead) give runner 4.06 → 3.81 s, arena 3.97 → 3.77 s and grid 4.46 → 5.15 s. The grid moved in opposite directions in the two measurements, so it is within this machine's noise (see below). All 9 probe runs after the change ended `won` with no page errors. `e2e/play-shell.spec.ts` (grid) and `e2e/play-arcade.spec.ts` pass.

**Decision.** The ≤ 3 s target is still not met on the emulated phone. The arcade saved 74 KB of JS and about 0.2 s of CPU (arena up to 1 s in the probe, but that is within noise). What remains is React/R3F render, native compile and three.js – no single cheap fix is left. These were measured and not done:

- **Zod at module load, 0.4–0.5 s in the arcade**, spread across the arcade contract and its 20+ piece files. Moving to `zod/mini` or building schemas lazily touches every piece. DEFER until real phones show that the start matters.
- **The grid parses the whole catalog, 0.49 s.** The catalog is the proxy's allowlist (`WORLDSTREAM_ASSETS`). Changing how it is validated is an access decision, so it is not done inside a performance task.
- **The lazy three.js chunks download after hydration, a gap of about 0.25 s.** Preloading them only saves the gap.

Real phones (`devices.md`) decide whether any of these is worth it. (Superseded: real phones were skipped, T5 below tried the candidates on the emulated phone.)

Phone-profile numbers move by up to ~30 % between runs of the same build on this machine (grid, untouched by T2: fps p50 60 → 30, first draw 7.2 → 8.3 s); other sessions share the CPU. Compare desktop cells for small differences.

## Real phones: not measured

The user decided on 2026-09-25 to skip the iOS Safari and Android check. `devices.md` does not exist. Every phone number in this file is the emulated profile: this machine's GPU, the CPU slowed ×4. Nothing here says how the game runs on a real phone.

## T5 – start-up candidates from the R2 profile (`ab-t5-2026-09-25.json`)

**How it was measured.** Back-to-back runs were not usable. Another project's e2e suite shared the CPU (load 66–100 %), and a plain before → after run showed the runner 0.8 s *slower* after a change that removes work. So two production builds were served side by side (ports 3131 and 3132), and the T1 probe ran one repeat on A, then one on B, flipping the order every round. Each number below is the median of the paired B − A differences on the phone profile (emulated), runner and arena. All 68 runs ended `won` with no page errors.

| candidate | runner first draw | runner first tick | arena first draw | arena first tick | rounds | decision |
|---|---|---|---|---|---|---|
| (1) GameSpec schemas out of the arcade start (`cb1b42b`) | −0.25 s | −0.22 s | −0.23 s | −0.24 s | 6 | kept |
| (2) three.js chunks requested at module load (`2b32072`) | −0.13 s | −0.22 s | −0.28 s | −0.28 s | 6 | kept |
| (3) catalog parse in the grid | – | – | – | – | – | not tried |

- **(1)** The Zod time in the arcade did not come from the pieces. `addons.ts` imported one constant, `ADDONS`, from `spec.ts`. That import brought in the whole GameSpec schema, the mechanic registry and `worlddoc`, about 170 of the roughly 370 schema calls on the arcade start path. `ADDONS` now lives in `arcade/contract.ts` and `spec.ts` re-exports it. JS transferred 497 → 490 KB. The piece schemas (about 200 calls) stay; building them lazily touches 20+ files for at most the remaining half of this gain. `src/components/play/__tests__/arcade-bundle.test.ts` fails if `ArcadePlay` reaches `spec.ts`, `registry.ts` or `worlddoc.ts` again.
- **(2)** `next/dynamic` asks for the `ArcadeStage` chunks only on first render, after hydration. `ArcadePlay` now starts the same import as soon as its module loads. Runner first draw improved by less than the plan's 0.2 s threshold. It was kept because the first tick, when the game can be played, improved by 0.22 s, and B was faster in 9 of 12 draw pairs and 10 of 12 tick pairs.
- **(3)** The only way to take the 0.49 s catalog parse off the grid's first frame is to validate the allowlist differently or not at all in the browser. Deferring the parse to the first `resolve` does not help, because the grid resolves assets in its first render. The plan allowed this candidate only without an allowlist change, so it was not tried.

**Before T5 → after T5**, same method, 5 rounds (`total` in the JSON):

| cell (phone, emulated) | first draw, median A → B | first tick, median A → B | paired median |
|---|---|---|---|
| runner | 3.01 → **2.64 s** | 3.46 → **2.97 s** | draw −0.30 s, tick −0.40 s |
| arena | 2.87 → **2.47 s** | 2.93 → **2.54 s** | draw −0.35 s, tick −0.35 s |

**Target ≤ 3 s: met in the median on this machine, not in every run.** One of the 5 rounds hit a load spike where both builds took 5.3–6.6 s. These absolute numbers are lower than the R2 table above (4.6–5.1 s) because the machine was quieter during this run, not only because of T5. The paired differences are the part that belongs to T5. The grid was not re-measured (not in the AC, untouched by T5).
