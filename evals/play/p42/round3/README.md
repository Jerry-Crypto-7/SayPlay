# P42 round3 sealed measurement

New 64-sentence held-out set: 22 multi-action, 8 paraphrase, 10 negation, 8 unsupported and 16 single-action labels. All prior 367 sentences are development data. IDs remain scoped by group. `dataset-seal.json` records the exact UTF-8 SHA-256 before any extraction, drafting or scoring. Mechanical normalized overlap checks cover P30, P41, original P42 and round2.

The runner preserves the original P42 five-seed protocol, scoring imports, thresholds and denominators. Source provenance includes all TypeScript sources under `evals/play/p42/**/*.ts`, in addition to the original source selection. It refuses any existing final JSON/Markdown/golden output and exclusively creates its initial checkpoint. Only transient EBUSY/EPERM/EACCES write errors retry (25/50/100/200/400 ms); no generated observation is retried. Progress prints to stdout at 40-row intervals. Do not read the active checkpoint for progress.

After freezing implementation and development tuning:

```powershell
$env:P42_ROUND3_FINAL_OPEN_HELD_OUT='1'
node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/play/p42/round3/final.measure.ts
Remove-Item Env:P42_ROUND3_FINAL_OPEN_HELD_OUT
```

No final measurement was executed during preparation. Human play remains a separate required check; automated results never imply that it occurred.
