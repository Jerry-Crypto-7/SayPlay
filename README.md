# WORLDSTREAM — Reality Compiler pilot

A short source describes a discrete spatial procedure. The application proposes a runnable 3D scenario, links rules to source excerpts, and compares the same recorded actions before and after a timer intervention.

The project targets an **own local demo using a Codex subscription**. The legacy subscription launcher is currently blocked pending production dispatcher validation; prepared local scenes remain available. Public hosting and a completed competition submission are not available. Source citations retain their review status: a valid byte range does not prove that a rule accurately represents its source.

Missing conditions can be supplied in **User supplement**. The addition is stored and cited separately; it does not rewrite the original text. New proposals link each trigger, condition and action to its own evidence. You can inspect that support before confirming parameters and later in **Why?**. Historical saved projects remain readable with their original, whole-rule evidence.

## Run the local demo

Prerequisites for prepared local use: Node.js and the dependencies in `package-lock.json`, and a production build. Fresh subscription generation additionally requires a validated fixed WSL dispatcher. Current credential-free CLI probes verify synthetic isolation, resource enforcement and cleanup scenarios; production authentication, network access and the complete production boundary remain unvalidated. `npm run demo:subscription` refuses with `SUBSCRIPTION_PRODUCTION_NOT_VALIDATED` before login or process creation; environment overrides cannot reopen the legacy launcher.

```powershell
npm ci
npx playwright install chromium
npm run build
npm run start
```

The ordinary prompt path can display labelled prepared scenes locally. A fresh source proposal requires the subscription dispatcher. The historical controlled demo used its own server at `127.0.0.1:3116`, a 30-minute session and at most 12 sequential model calls, with no API fallback or automatic retries; its current launcher is blocked as described above.

The prefilled fictional source is editable. Each text accepts up to 4,000 Unicode code points; original and supplement together are limited to 16,000 UTF-8 bytes. Review all seven critical parameter groups before starting; missing or conflicting support blocks acceptance. The pilot supports discrete grid movement and a single timer intervention per project. **Save source project** stores both branches and visitor inputs in this browser; **Restore saved source project** validates and replays them after a reload. Unsaved work is lost. Geometry is schematic.

Drag the scene to orbit, scroll to zoom, or focus the canvas and use arrow keys to pan. **Frame scene** resets the view. Edits preserve the camera and existing object wrappers. Ordinary worlds can display their validated coarse scene while shape detail is built; prepared, approximate, and live origins remain labelled.

Ordinary edits support shapes and validated behavior changes. Palette, lighting and material operations are rejected because the current renderer does not apply `world.look`. If a committed change's snapshot cannot be read, **Restore accepted change** retries the read without committing again. If its mesh fails, the accepted coarse world remains usable and **Retry accepted detail** rebuilds only the local geometry.

Legacy entity motion such as swaying is also unsupported. A mixed shape/motion proposal explicitly offers **only the shape**, with behavior unchanged; you review that reduced scope before applying it. Motion-only requests and older stored motion previews are refused. Historical prepared assets remain unchanged.

**Stop waiting** cancels local waiting and pending mesh work while preserving any displayed scene. **Stop waiting for source** keeps the accepted project and discards the pending proposal. Late results cannot replace the view. A remote model request may still finish; this control does not promise to cancel provider usage.

The historical holdout exposed missing-duration cases accepted without the clarification required by its protocol. The current flow adds mandatory parameter review, but has not passed a new independent semantic series. Use explicitly complete procedures for the local demo and review critical parameters manually. A successful simulation does not establish faithful interpretation of an ambiguous source.

The historical subscription series recorded a creation median of 126.22 seconds and p95 of 180.43 seconds; edit p95 was 3.73 seconds. Creation missed the original 30/60-second targets. These timings predate the new parameter-review flow; a new live before/after measurement has not run. CLI timings include process and transport overhead, and human review is measured separately. Subscription use consumes the account's available allowance; the launcher does not invent a per-token USD price.

## Evidence and validation

Local Windows Playwright graphics tests use the hardware GPU through Direct3D 11. `e2e/gpu-renderer.spec.ts` records and checks the actual WebGL renderer. Set `$env:E2E_RENDERER='software'` only to reproduce historical SwiftShader runs; CI defaults to software, and `$env:E2E_RENDERER='native'` explicitly requests hardware. Build, TypeScript, unit tests, and the current mesh worker remain CPU work. Keep hardware and software timing results separate.

- [Demo walkthrough and attempt archives](evals/reality-compiler/subscription-demo.md)
- [Subscription benchmark](evals/reality-compiler/subscription-report.md)
- [Decision and limits](evals/reality-compiler/decision.md)
- [Handoff readiness](evals/reality-compiler/submission-readiness.md)
- [Human study protocol](evals/reality-compiler/user-study.md)
- [Optimization measurements and their limits](evals/reality-compiler/optimization-baseline.md)
- [Development before/after review protocol](evals/reality-compiler/holdout-v2/protocol.md)
- [Prepared UI walkthrough video and disclosure](evals/reality-compiler/prepared-video.md)
- [Single-process operating proposal](ops/worldstream-single-process.md)
- [Offline WSL supervisor protocol and production limits](scripts/subscription-wsl-supervisor-protocol.md)
- [Actual credential-free CLI capsule and fault evidence](scripts/subscription-cli-supervisor.md)
- [Candidate systemd resource envelope and its limitations](scripts/subscription-systemd-cli-probe.md)
- [Ordinary generation, repair and browser materialization evidence](scripts/reality-compiler-ordinary-generation-session.md)
- [Ordinary edit cache eviction measurement](evals/reality-compiler/ordinary-edit-memory.md)

```powershell
npm run typecheck
npx vitest run scripts/__tests__/measure-reality-compiler.test.ts scripts/__tests__/codex-subscription.test.ts
# Historical automated protocol: currently stops before inference with
# PARAMETER_REVIEW_REQUIRED. A new live series needs a versioned human-review phase.
$env:RC_SUBSCRIPTION_AUTHORIZED='1'
npm run measure:reality-compiler-subscription
```

The historical benchmark preserves failures and unattempted pairs. Its oracle is never included in the model request. Parameter acknowledgement does not change claim review status or certify meaning. Offline fixture tests may script the acknowledgement; live measurement may not. Human semantic review and five actual participants remain separate evidence requirements. Historical prepared worlds, offline fixtures and API measurement paths remain in the repository and do not establish the current pilot's quality.

Third-party components and source provenance are recorded in `disclosure.json`. See the handoff report for unresolved release requirements.
