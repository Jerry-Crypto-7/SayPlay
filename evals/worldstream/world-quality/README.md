# P20 quality baseline

`protocol.json` fixes the thresholds and rubric. `development.json` contains the
ten original P19 sentences; `holdout.json` adds five cases in each of four domains.
`a4-cases.json` specifies ten branch comparisons, eight of them non-timer changes.
`a4.test.ts` executes all ten specifications (eight non-timer) against
the actual runtime. Timer cases observe the specified 60-tick difference and
later convergence within the 400-tick horizon. These authored unit fixtures do not replace live model edits
or the visual comparison and human usability acceptance.

`MANIFEST.lock` records normalized-LF SHA-256 hashes before tuning. This is a local
integrity check, **not** an externally immutable freeze. Changing any case or
threshold requires a new version and an explanation. Do not put holdout answers
into model prompts as examples.

## Reproduce without model access

Run from the repository root. The P19 answer archive is private and must exist.
Use a fresh directory on every run; the replay refuses to replace old evidence.

```powershell
npx vitest run evals/worldstream/world-quality/corpus.test.ts
npx vitest run evals/worldstream/world-quality/a4.test.ts
$env:P20_RUN_DIR='plans/P20/replay-NEW-RUN-ID'
npx vitest run --config vitest.measure.mts evals/worldstream/world-quality/replay.measure.ts
$env:WORLDSMITH_QUALITY_DIR=$env:P20_RUN_DIR
$env:WORLDSMITH_QUALITY_CASES='evals/worldstream/world-quality/development.json'
$env:E2E_PORT='3120'
npx playwright test e2e/quality-gallery.spec.ts --project=chromium
```

The gallery builds production code. `results.json` retains rejected attempts;
missing blueprints remain in `gallery.html` and `richness.json`. Rendering a saved
valid blueprint unsuccessfully fails the gallery test. A successful test means
the harness finished, not that all ten scenes met product criteria.

`blind.html` hides prompts, titles and variant names. Keep `blind-key.json` with
the coordinator, not the raters. `gallery.html` is diagnostic and **not blind**.
Screenshots and browser/GPU metadata do not establish the 1080p performance gate.

`browser-observations.json` records navigation-to-first-presentation timestamps
inside the browser using the canvas presentation signal. Every expected case has
a row; absent blueprints have null timings. This is a saved-world loading probe,
not prompt-to-world latency, semantic recognition, or simulation readiness.
The routed browser context disables HTTP cache; these observations must not be
reported as separate cold/warm generation distributions. The three prompt-based
timings remain explicitly null until measured on the actual generation path.

Set `WORLDSMITH_QUALITY_PROFILE=1` in a fresh gallery output directory to use
1920×1080 and save `frame-profile.json`. After the 1.5-second settling period,
each valid scene records 180 browser frame intervals while the stage frame
counter advances, with a 30-second sampling cap. Raw intervals, missing cases,
draw calls, triangles, drawing-buffer size and renderer memory counts remain in
the artifact. The check requires actual 1080p frames, not a fast p95. A static
desktop observation is not GPU execution time, interactive load, or a reference
laptop G-P verdict. Keep the software renderer in a separate output directory.

For an in-progress live run, first copy completed outcomes and their saved
blueprints into a separate snapshot directory and record the source, timestamp,
and file hashes. Include all 30 expected cases in the gallery input. Never label
that snapshot as the final baseline, and do not modify the running generator's
output files. The report completion check deliberately fails for such a partial
snapshot while still writing `quality-summary.json` with pending IDs.

## Fresh model baseline

With the existing authorized product model transport configured:

```powershell
$env:P20_RUN_DIR='plans/P20/live-NEW-RUN-ID'
$env:WORLDSMITH_LATENCY_MODELS='gpt-6-astra@medium#cli'
npm run measure:worldstream-latency
```

P20 mode runs all 30 locked cases and refuses model/effort changes. The directory
must not already exist. It records requests and parsed answers per attempt,
per-call timings, outcomes (including failures), environment and saved blueprints.
Transport failure stops the run and fails it as incomplete. Never copy private
answers into the public dataset. No new account, credential setup or purchase is
part of this command. The transport retains its existing authentication handling.

This Node harness measures planner/compiler/proxy completion. It does **not**
measure first visible composition, browser interaction readiness or frame time.
Those remain separate browser observations. Cold/warm/new-asset distributions
also require labeled runs; do not infer cache state from an unlabeled duration.

After the live run, keep `P20_RUN_DIR` set and run:

```powershell
npx vitest run --config vitest.measure.mts evals/worldstream/world-quality/report.measure.ts
```

The summary preserves all 30 expected IDs. It writes an incomplete report but
fails the check if any cases are still missing. Missing timings stay null.
It also writes `group-summary.json` for development/holdout separately,
`stage-summary.json` for model-call timings and residual processing, and
`expected-cases.json` for the full gallery. Model wall times include transport;
the residual must not be labeled witness-search time. Stage percentiles do not
add up to the end-to-end percentile.

`repair-summary.json` separates certification with/without repair, rejected
cases with/without repair, and missing call records. It retains retry input
reasons separately from the terminal case failure and measures time spent in
repair calls. These are observed outcomes, not causal estimates of repair
benefit. Calls belonging to unfinished cases do not enter these counts.

## Human evaluation

1. Three independent raters describe every blind scene before seeing its prompt.
2. Then show each prompt and its requirements. Record place recognition, each
   main object, exact counts, relations, material and behavior separately.
3. Recognition requires the place and main requirements; use the majority of
   three judgments. Missing scenes stay in the denominator.
4. For visual preference, five people compare old/new views of the same blueprint
   with matching camera and a 20-second flythrough. Randomize presentation order;
   retain individual scores and dissent. Still images alone do not close G-W.
5. Keep model judgments in a separate diagnostic column. Until real ratings and
   the A4 usability sessions exist, report the relevant gates as pending.
