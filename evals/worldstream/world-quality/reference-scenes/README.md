# T04 — manual visual ceiling references

Three **hand-authored development fixtures**, available at `/dev/reference-scenes`:

- `interior`: aquarium reading room, two seated people, furniture and a framed doorway.
- `courtyard`: waterside terrace, pergola, distant bank, people and planting.
- `observatory`: ring architecture, human scale and one authored twisted SDF aperture.

All use the production `WorldstreamStage`, GLB loader/cache, mesh worker and lighting component. Architecture is explicitly authored as local Three.js meshes in the dev harness. It is **not** emitted by the compiler, and this gallery is never used as a generation fallback. The borrowed demo world document is inert: this task tests visual light controls, not simulated rules or A4 branching.

Each scene has four fixed views, a seekable 20-second camera path and a working point-light toggle. The light toggle preserves asset representation IDs. Camera motion remains outside simulation state. Capture uses the actual browser canvas via `MediaRecorder`; no recreated video scene or external media is involved.

## Controlled comparisons

All captures share a 1600×940 framebuffer, DPR 1 and view 1 unless explicitly changing camera:

| Variant | Change |
|---|---|
| `full` | Authored layout, PBR asset materials, scene lighting, local procedural IBL, shadows |
| `clay` | Original `clayMaterial()` override; exactly the same geometry/camera/light |
| `proxy` | GLB assets replaced by their bounding boxes; architecture and SDF preserved |
| `layout` | Same GLB instances moved to a regular grid; architecture preserved |
| `light` | Original production light rig, no IBL |
| `camera` | Viewpoint moved 1.8× farther from the origin |
| `no-ibl` | Only IBL removed |
| `no-shadows` | Only shadow maps disabled |
| `lamp-off` | Point-light intensity and visible emitter switched off |

The environment map comes from the installed Three.js `RoomEnvironment` and PMREM, generated locally without downloads. The full rig still has four lights. GLB opaque meshes cast shadows; transparent glass does not cast an opaque shadow.

## Reproduce (PowerShell)

```powershell
npx vitest run evals/worldstream/world-quality/reference-scenes/scenes.test.ts src/worldstream/__tests__/framing.test.ts src/components/viewer/__tests__/asset-stage.test.ts
$env:E2E_PORT='3127'
npx playwright test e2e/world-quality-reference.spec.ts e2e/assets-glb.spec.ts --project=chromium
node evals/worldstream/world-quality/reference-scenes/summarize.mjs
```

Playwright builds and starts the production app. The summary script requires `ffmpeg` and `ffprobe` on PATH; it remuxes recordings without re-encoding to add duration/seek metadata (20-second path plus roughly 0.5-second end hold). `REFERENCE_OUTPUT` optionally selects a new capture directory; pass the same directory as the summary script's first argument. Default evidence lives in ignored `plans/P20/reference-scenes/`, including PNGs, three WebM flythroughs, renderer probes, contact sheets and `index.html` for human review. Do not mix captures from different builds in one report.

Pixel differences quantify the size of an image change, **not** aesthetic improvement. Human recognition/style scores remain pending. These fixtures do not change the locked development/holdout corpus or certify the live generator, 1080p laptop performance, collision handling, a material resolver, or simulation interactions.
