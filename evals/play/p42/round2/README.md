# P42 round2 sealed measurement

64 new held-out labels with the original distribution (22 multi-action, 8 paraphrase, 10 negation, 8 unsupported, 16 single). All 303 prior examples are development data, including the first P42 held-out set. IDs remain group-scoped. The dataset seal records the exact UTF-8 bytes before any extraction, drafting, scoring or model invocation. Mechanical overlap checks cover P30, P41 and the entire original P42 set with repository-equivalent normalization plus NFKC.

The runner copies the first P42 final protocol and imports the same P41 scoring functions unchanged. Differences are the isolated output directory, explicit round2 guard and inclusion of this runner in source fingerprints. No metric, threshold, seed, hero comparison, environment comparison, witness requirement, honesty rule, latency or golden test was relaxed. Existing results, including interrupted results, cannot be overwritten.

Run only after freezing all implementation and development tuning:

```powershell
$env:P42_ROUND2_FINAL_OPEN_HELD_OUT='1'
node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/play/p42/round2/final.measure.ts
Remove-Item Env:P42_ROUND2_FINAL_OPEN_HELD_OUT
```

No final measurement has been run during preparation. The required human play check is separate and is never implied by automated results.


## Operational recovery of the interrupted run

The original final runner aborted inside `save()` / `writeFileSync`. Its valid `final.json` contains exactly the first 47 observations. The OS error code was not retained; Windows file sharing is a suspected cause, not a verified diagnosis. Neither the original result, runner nor dataset is changed by this recovery.

`resume.measure.ts` requires the dataset seal, the original source fingerprint `ab6a945773973c97e3161972e4183e24ca710b4c308e623bb3fe5a5b55cea9b7`, and an exact 47-row prefix of the original label ? seed ordering. It computes the fingerprint with the original git path selection, excluding **only** the newly introduced `resume.measure.ts`. All 47 rows, including their timing values, are retained without regeneration or rescoring. Only the remaining observations are generated. Scoring, thresholds, seeds, golden replay and measurement logic are unchanged.

Recovery writes separate `final-resumed.json`, `final-resumed.md` and `golden-resumed.log`, refusing existing recovery outputs. Its provenance records the original result SHA, original source fingerprint, recovery source SHA, preserved-prefix SHA, interruption and restart. The possible 48th unpersisted attempt is unknown; no result claims an uninterrupted one-shot run, and restarted-process latency is explicitly qualified. Checkpoint writes retry only EBUSY/EPERM/EACCES up to five times (25/50/100/200/400 ms); no measured action is retried by this I/O handling. Progress is printed every 40 total rows, so do not read the active checkpoint for progress.

After the frozen-source and prefix checks have been reviewed, the authorized recovery command is:

```powershell
$env:P42_ROUND2_RESUME_INTERRUPTED='1'
node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/play/p42/round2/resume.measure.ts
Remove-Item Env:P42_ROUND2_RESUME_INTERRUPTED
```

Creating this recovery runner does not execute it. The original guard and original output remain untouched.
