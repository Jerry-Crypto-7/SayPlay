# Ordinary browser cache eviction fixture

This supplements, rather than replaces, the existing
`e2e/worldstream-edit-memory.spec.ts` coverage. That existing production-page
test already performs 25 ordinary edits with scripted preview/commit/snapshot,
runtime/camera/identity continuity and renderer resource counts. Historical
session 3/4 reports remain unchanged. It alternates two shapes, so it does not
exercise the client's sixteen-entry mesh-cache eviction boundary.

The new opt-in measurement starts with variant 0, commits sixteen distinct
variants, revisits 0 (which must mesh again after eviction), then revisits the
recent variant 16 (which must hit cache without another worker job). This is
18 edits chosen to cross an actual implementation boundary, not a generic
high-count stress run. Seventeen distinct schema-valid blueprint hashes are
frozen before browser dispatch.

The path is production `/` prompt creation → scripted session SSE blueprint →
ordinary refine UI → scripted preview → apply/commit → scripted snapshot → real
blueprint validation, mesh worker/cache, scene reconciliation and rendering.
No direct Stage detail injection occurs. All API requests are intercepted;
unhandled API calls return a fixture error and external HTTP origins are
blocked. Model calls are zero, provenance is fixture, humanObservation is false
and liveMeasurement is NOT_RUN. Server commit-gate correctness is not tested.

Each edit records actual accepted fixture identity, changed renderer
representation, worker jobs, mesh provenance/timing and completed first-frame
stage. The frame stage completes after gl.render, not GPU execution/scanout.
The report records geometry/texture/program **counts**, not VRAM bytes or JS
heap; both byte fields remain null. Full pipeline pending interaction durations
stay null rather than being invented as completed totals.

## Run and evidence

Use a freshly built local production server. A build receipt should record
actual command success, app/config/package hashes before and after, BUILD_ID
and `.next/server/app/page.js` hash. An old `BUILD_ID` alone is insufficient.
The measurement embeds the supplied receipt for review; it is not a
cryptographic source/build attestation or an independent verifier of an
arbitrary caller-supplied receipt. Absent receipt means no current-source credit.

```powershell
$env:RC_ORDINARY_MEMORY='1'
$env:RC_ORDINARY_MEMORY_BASE_URL='http://127.0.0.1:3221'
$env:RC_ORDINARY_MEMORY_BUILD_RECEIPT='scratch/session7-ordinary-memory-build-receipt.json'
node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/reality-compiler/ordinary-edit-memory.measure.ts
```

Every run creates a unique `scratch/session7-ordinary-edit-memory/<uuid>` with
prepared configuration, each completed edit sample and final report, including
failures and source hashes before/after. No historical eval report is rewritten.
The browser and its context close in finally; the local server belongs to the
caller and is separately cleaned up when all authorized consumers finish.

Actual session 7 result:
`scratch/session7-ordinary-edit-memory/31ee3556-05e8-4e0d-92cd-25c2b5ea0b73/report.json`:

- **1/1 browser PASS**, 18 commits and 18 snapshots.
- Initial worker jobs 1; sixteen fresh variants plus evicted 0 increase to 18;
  recent variant 16 hits cache and leaves the count at 18.
- All 18 edits have new representation IDs, completed mesh and first-frame
  observations, and **7 geometries / 4 textures / 6 programs**, without count
  growth. This does not measure VRAM bytes or internal cache byte accounting.
- RTX 3090 through ANGLE/D3D11, Chromium 151, 1280×720, DPR 1, 16 logical CPUs,
  reduced motion. Single-session times are not a general percentile benchmark.
- A fresh successful `npm run build` had unchanged app/config/package hashes:
  `scratch/session7-ordinary-memory-build-before.json` and
  `scratch/session7-ordinary-memory-build-receipt.json`. The initial sandbox
  build spawn EPERM is retained separately, followed by narrow standard
  escalation. No build hooks or historical eval generators ran.

The fixture/evidence validator has **3/3 offline tests PASS**. Broader A8 visual,
human and performance acceptance criteria remain open.
