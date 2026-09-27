# Training set – `/play` director, P30C

Training data for a LoRA on `gpt-oss-20b` (one generation of expert iteration). Every row was written by the **local** `gpt-oss-20b` (llama.cpp on loopback) and chosen by the publish robot and the offline fidelity chain. No row comes from astra or any other OpenAI model: the terms forbid training on their outputs, and `training/p30/__tests__/sft-set.test.ts` fails on any row whose `source`, `model` or endpoint says otherwise.

## Files

- `sentences.jsonl` – 320 training sentences from templates and word lists in `training/p30/sentences.mjs` (FNV-1a over family, index and slot, no model). Each carries a checklist shaped like `evals/play/fidelity/corpus.json` (2–4 nouns, one verb). 18 verb families weighted like the demand set, 23 distinct verbs. No sentence meets the fidelity corpus, `judge-10`, the demand set or `evals/play/p30/test-200.json` after normalisation; the test re-checks all four (the last only once it exists on this branch).
- `sft.jsonl` – one row per sentence that got a robot-approved candidate: `messages` (production compact system prompt, user, assistant with `content` and `thinking`), `source: "gpt-oss-20b-local"`, `seed`, `temperature`, `candidate`, `promptVersion` and the fidelity `score`.
- `collect-report.json` – every candidate without its text: time, fallback reason, robot verdict, control, completion tokens, fidelity score.
- `collect-state.json` (ignored) – the resumable working state with the text of every candidate.

`node --experimental-strip-types training/p30/collect.mjs --key-file <llama-server key>` resumes the run; `--build-only` rebuilds `sft.jsonl` and the report from the state.

## How a row is chosen

For each sentence the production director (`direct(…, { compact: true, maxRepairRounds: 0 })`) asks the model four times: k0 greedy (temperature 0, the production setting), k1–k3 sampled at 0.8 with a seed from the sentence id. A candidate the director accepted without a fallback runs the robot of `/api/play/games` (`playabilityIssues` over the derived seeds). Among those that pass, the one with the most checklist items read and drawn wins, then `inSpec`, then the lower k.

A candidate the model did not answer (`MODEL_UNAVAILABLE`) is not a measurement: the collector saves nothing for that sentence and stops, so the next run measures it again. The test fails on any booked sentence with fewer than four answers. On 27 Sep a ComfyUI job held the RTX 3090 (811 MiB free) and llama.cpp stopped decoding mid-answer; 13 candidates of `t311` and `t314`–`t316` timed out at 120 s, were dropped and measured again once the card was free.

## Run of 27 Sep 2026 (`promptVersion` `9f82af99`, `gpt-oss-20b-MXFP4.gguf`)

**320 of 320 sentences measured, 256 with a robot-approved candidate (80 %).**

| | greedy (k0) | sampled (k1–k3) |
|---|---|---|
| passed the robot | 96/320 (30 %) | 439/960 (46 %) |
| chosen | 81 | 175 |

Sampling is what makes the set: the production setting alone would give 96 rows, four tries give 256.

**Why candidates fail (1 280 in total):**

- `VERB_UNPROVED` 280 – the director rejected the game because the verb is not shown.
- `KEYPOINT_FAILED` 214, `UNWINNABLE` 46, `WORLD_REJECTED` 8, `LAYOUT_FAILED` 4 – the robot rejected the game.
- `MALFORMED` 193 – **187 of them hit the 4 000-token output cap**: the reasoning ate the budget before the JSON. The completion median is 2 282 tokens and the 90th percentile sits on the cap.

Answer time: median 16.0 s, 90th percentile 27.1 s.

**Chosen controls:** runner 65, shooter 33, tap_go 30, platform 26, steer 23, throw 22, timing 15, flap 14, rhythm 12, duel 11, move_free 5.

**Sentences with a row, by family:** jump 22/22, run 20/20, rhythm 12/12, flap 10/10, shoot 20/22, stack 18/20, fight 11/12, grow 11/12, dodge 11/12, race 22/25, defend 13/15, calm 23/33, build 7/10, throw 13/20, collect 18/30, escape 12/20, steal 8/15, match 5/10. The weakest families (match, steal, escape, collect) are the ones the set teaches least.

**Fidelity of the chosen rows:** 945 checklist items, 866 in the spec (92 %), 776 read (82 %), 650 drawn (69 %).
