# P42 round4 sealed held-out

Prepared independently on 2026-10-07 by a separate authoring agent. The author read the P42 specification and `src/play/intent/contract.ts`; no parser, composer, game implementation, previous results or previous sentence content was inspected. Prior datasets were accessed programmatically only for schema inspection and normalized overlap comparison. No extraction, drafting, scoring or API calls were run during preparation.

The dataset contains only `groups.held-out` and metadata: 64 newly authored English requests, distributed as 22 multi-action, 8 paraphrase, 10 negation, 8 unsupported and 16 single. Labels use singular noun heads for heroes, settings and objects; movement objects are null. Named threats are actors with the hero as their object. Unsupported is true only for the eight explicitly unsupported requests.

`prepare.py` records reproducible independent authoring, validates counts, IDs, unique sentences and actor orientation, and checks normalized overlap (NFKC, lowercase, whitespace collapse) against P30 test-200, P41 sentences, P42 original, round2 and round3. All five overlaps are zero. The first preparation attempt stopped before writing files because P30 uses a list of strings; the traversal was corrected without displaying any previous sentences. Dataset creation is exclusive and must not be rerun to overwrite the sealed files.

Exact UTF-8 bytes of `sentences.json` were sealed before any evaluation:

`2694b9c0355a00db18cd7300e8b1e06cef3d8ad5be31c0ce0503f6b39b827bd9`

`dataset-seal.json` records the hash, distribution and reference counts. `final.measure.ts` is byte-for-byte equivalent to round3 after reversing only `round3`/`round4` and `ROUND3`/`ROUND4` substitutions. Scoring, thresholds, five seeds, bounded I/O retries and write-once output protections are preserved. Existing round outputs were not edited.

After implementation and development tuning are frozen, run once from the repository root in PowerShell:

```powershell
$env:P42_ROUND4_FINAL_OPEN_HELD_OUT = '1'
node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/play/p42/round4/final.measure.ts --maxWorkers=1
Remove-Item Env:P42_ROUND4_FINAL_OPEN_HELD_OUT
```

Preparation did not run this command. Do not tune on the held-out dataset or overwrite results after observing them. Human play remains a separate acceptance requirement.


## Round4 operational recovery

The original runner stopped in save() with errno UNKNOWN (unknown error opening final.json), despite no concurrent progress reads. The I/O cause remains unknown; file locking is not established. Original runner, dataset and 187-row final.json remain unchanged.

Recovery validates source fingerprint c195c99605853bf3c5d66917f667065699223176a93908fa77e6b01e07000a48 and dataset seal 2694b9c0355a00db18cd7300e8b1e06cef3d8ad5be31c0ce0503f6b39b827bd9. Original path selection includes evals/play/p42/**/*.ts and excludes only the new round4 resume.measure.ts. Exactly 187 label ? seed prefix rows and their original timings are preserved. A possible unpersisted 188th attempt is unknown. Provenance records result/prefix/recovery-source hashes and restart; this is not an uninterrupted one-shot measurement.

An exclusive recovery-started.json marker rejects repeated invocation. Recovery creates a workspace-validated recovery-checkpoints directory and immutable row-188.json through row-320.json files. No large aggregate is rewritten after each observation. Separate final-resumed.json, final-resumed.md and golden-resumed.log are created only once at completion. Existing marker, checkpoint directory or output rejects overwrite. Partial files after fatal I/O remain evidence, never silently replaced.

UNKNOWN, EBUSY, EPERM and EACCES I/O errors retry at 100/200/400/800/1600/3200 ms. Writes retry the same in-memory bytes at the same explicit offset; no observation is regenerated. Progress prints every 40 total rows. Observation, scoring, thresholds and golden replay remain unchanged.

PowerShell recovery command (not executed during preparation):

```powershell
$env:P42_ROUND4_RESUME_INTERRUPTED='1'
node node_modules/vitest/vitest.mjs run --config vitest.measure.mts evals/play/p42/round4/resume.measure.ts
Remove-Item Env:P42_ROUND4_RESUME_INTERRUPTED
```
