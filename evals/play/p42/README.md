# P42 measurement protocol

`sentences.json` contains the original 175 P41 development labels, all 64 former P41 held-out labels under `p41-former-held-out`, and 64 newly authored held-out labels. IDs are scoped by group; former and current held-out both preserve the `ho-` format. The new set has exactly the P41 kind distribution: 22 multi-action, 8 paraphrase, 10 negation, 8 unsupported, 16 single. `dataset-seal.json` records its byte SHA-256 before any extraction, drafting or scoring execution. Mechanical authoring checks established no normalized sentence overlap with P30 test-200 or any P41 sentence.

Tune only on the 239 development labels. Do not read held-out failures until implementation is frozen. The final runner refuses to overwrite any existing result, including an interrupted run. It makes no director or paid API calls.

After freezing implementation, run in PowerShell:

```powershell
$env:P42_FINAL_OPEN_HELD_OUT='1'
node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/play/p42/final.measure.ts
Remove-Item Env:P42_FINAL_OPEN_HELD_OUT
```

The P41 protocol is retained: five seeds, draft latency, world compilation, bot completion and deterministic replay, action witnesses, exact normalized hero identity, all-seeds sentence denominator, and P41 golden replay. Environment comparison changes only to the singular head noun. Unsupported actions count as success only when the exact missing triple is visibly admitted; supported actions still need witnesses even in mixed unsupported sentences. Admission never increases `proved`. Silence is measured from the final published-game honesty payload, not private composition metadata. Failed builds remain preservation failures; as in P41 they are not published silent omissions.

`final.json` checkpoints every observation and includes source/dataset fingerprints, specs, witnesses, honesty, verification and every failure. `final.md` summarizes acceptance thresholds. The four human play checks in the spec remain separate and must not be claimed by this automated report. Do not tune against held-out results or rerun them as development data.
