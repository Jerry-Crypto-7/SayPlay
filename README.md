# WORLDSTREAM

Describe a place, act in its world, rewind, preview one rule change, and compare two synchronized futures. The current P20 product combines approved GLB/PBR objects, parametric architecture and terrain, and SDF geometry for unusual forms. A deterministic runtime executes declarative rules; the model never runs generated code.

**Current delivery is local.** [Watch the 90-second live A4 video](videos/worldstream-a4/worldstream-a4-live.mp4) or follow the [demo runbook](docs/demo/judge-runbook.md). Public operation, independent human review and the product acceptance gates remain unverified or incomplete; see [PROJECT-STATUS.md](PROJECT-STATUS.md).

## Run locally

```powershell
npm ci
npx playwright install chromium
npm run build
npm run start
```

Use the production build for verification. Live generation additionally requires the already authorized, configured server-side model transport and spend controls; these commands alone do not configure that service. See the [local walkthrough](docs/submission/demo-walkthrough.md). Do not use Next dev as acceptance evidence.

The main page defaults to **Generate my world**: submitting your prompt starts one live session. A failed or unavailable generation reports its reason, without silently substituting an authored world. **Prepared demo** is a separate explicit choice and remains labeled even for exact matches; it does not automatically become a live generation in the background.

A provisional layout or validated visual preview can appear before accepted rules. Such a preview is noninteractive, is not a simulation or replay, and does not certify the requested meaning. Once a world is accepted, perform an available action, choose **Before my last action**, propose a compatible change, inspect the preview and confirm. Desktop comparison shows two views with shared time and camera; mobile lets you switch views.

## What is demonstrated

One recorded production-browser A4 run on 17 September 2026 generated the requested reading room with an aquarium, two seated people, a terminal and a signal light. The accepted, controllable world arrived in **258.445 s**; the subsequent A4 path took **8.555 s**. This is one observation, not a percentile or a performance guarantee, and concurrent work was running.

The same terminal action sets `signalOn` to true in the original future and false in the changed future. Both futures in this example are `won`; the visible difference is the light. The comparison commit returns `validation: comparison-only` and `certificate: null`: it validates the supported comparison, not a new winning certificate for the alternative.

- [Raw recording, requests, timing and screenshots](plans/P20/live-browser-v3-20260917-1825/README.md)
- [Final video provenance, timing and encoded QA](videos/worldstream-a4/README.md)
- [Current P20 implementation and remaining gates](plans/P20-svet-a-dve-budoucnosti-2026-09-17.md)

The video openly speeds the first 260 seconds of its browser recording by 5×. Its original 800 × 450 browser footage is enlarged; the closing screenshot is 1920 × 1080. This automated browser recording is not a human study or proof of general prompt support.

## Limits

- Comparison supports bounded compatible edits of an existing rule condition, action or timer. Structural or unsupported edits are refused. Restore-original accepts a new revision without regenerating geometry; a page reload does not restore the visitor's local input history.
- Prepared scenes and their authored changes have limited coverage. They are demonstrations, not evidence of fresh generation.
- Structural validation and a successful deterministic witness do not certify semantic fidelity, recognizable objects or convincing appearance. Search exhaustion is not proof that a world cannot be won.
- Hand-authored `/dev/reference-scenes` are renderer calibration fixtures, never hidden generation fallbacks. Human visual evaluation, provider evidence and hosted-operation evidence remain separate gates.
- The single 258.445-second observation does not meet the P20 latency target.

## Checks and attribution

```powershell
npm run typecheck
npm run test
npm run test:e2e
node scripts/submission-check.mjs
```

Use targeted suites for changed behavior. Windows graphics tests record the actual hardware renderer; software-rendered CI and hardware timings are distinct. Third-party materials are documented in [DISCLOSURE.md](DISCLOSURE.md), generated from `disclosure.json`.

## Historical measurements

The 13 September experiments (five prompts: 2.4 calls/prompt, median 143 s, p95 259 s; a separate 30-prompt run) concern an earlier compiler. They are not acceptance results for the current hybrid version: [latency report](evals/worldstream/latency-report.json), [creation report](evals/worldstream/create-report.json), [prepared-path first frame](evals/worldstream/first-frame.json). Historical authored-store behavior and visual judgments are retained in the historical sections of the [runbook](docs/demo/judge-runbook.md); they do not describe today's default live path.
