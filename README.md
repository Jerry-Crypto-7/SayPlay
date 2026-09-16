# WORLDSTREAM

A sentence in plain English becomes a 3D world you can look at and that runs. The model writes two declarative programs — the composition of the space, and the shape of its hero objects as signed distance fields that the browser meshes itself. A deterministic runtime executes the rules; the model never runs generated code. A second sentence changes one object of the world that is already standing, instead of building a new one.

Everything happens in the browser. There is no install, no plugin, and no loading screen before the first world.

## Run it

```powershell
npm ci
npx playwright install chromium
npm run build
npm run start
```

`npm run start` is the supported path. `next dev` breaks the session registry, so the live branch returns 404 on its event stream there.

Type a sentence into **Describe a place** and the world builds. Open **Inspect** at the bottom right to see the objects of the world and the tier each one is drawn at — meshed hero shape, composed kit piece, or clay. **Change one thing in this world** takes the second sentence: it shows the plan first — which object changes, what happens to it, and which objects the change does not name — and nothing moves until you press *Apply*.

## What it does not do, stated plainly

- **An unrecognised sentence is answered by the nearest authored world**, and the product says so on screen. When a sentence is recognised exactly, no such note appears — the note belongs to substitution, not to every world.
- **The second sentence has an authored change for only 5 of the 11 stored worlds.** Any other target is refused with a stated reason, not with a borrowed error about a model outage that never happened.
- **Time rewind and branching futures are not on this path.** They are built and tested, but they live on a development route; nothing here should be read as a claim that a visitor can rewind time.
- **The live model path runs only from the author's development machine** through the Codex CLI. When it is absent, the hosted deployment answers from the authored store.
- **Geometry is schematic.**
- **A world that passes every check does not certify semantic correctness.** The runtime proves the rules are consistent and the world can be won, never that it means what the sentence meant. The most recent internal review recognised 2 of 10 rendered rooms from the sentence that produced them, which is the measured size of that gap.

## Measured

Five sentences against the cloud model, 13 September 2026: **2.4 model calls per sentence**, a median of **143 s** to a finished world, a 95th percentile of **259 s**. Over a separate 30-sentence run the model authored the hero geometry for **0.3** of the attempts. Creation timings include process and transport overhead, and the judge-path timings were measured over the authored store, not a live model.

- [Sentence latency and stage breakdown](evals/worldstream/latency-report.json)
- [Thirty-sentence creation run](evals/worldstream/create-report.json)
- [First frame on the cooked path](evals/worldstream/first-frame.json)
- [What a visitor sees, beat by beat](docs/demo/judge-runbook.md)

## Checks

```powershell
npm run typecheck
npm run test
npm run test:e2e
node scripts/submission-check.mjs
```

Local Windows Playwright graphics tests use the hardware GPU through Direct3D 11; `e2e/gpu-renderer.spec.ts` records the actual WebGL renderer. CI defaults to software rendering, so keep hardware and software timings apart.

## Third-party material

Every library, asset, model, dataset and API is listed with its source, author, licence and required notices in [`DISCLOSURE.md`](DISCLOSURE.md), generated from `disclosure.json` by `npm run disclosure`.
