# P37A sets – `/play`

## `dev-150.json` – 150 juror-style sentences

The dev set for P37A ("every sentence is a recognisable game"). Tune and measure on it; the sealed `../p30/test-200.json` stays closed until the final run.

Written on 2026-10-03 by a subagent that got only the tag descriptions from `../p30/README.md`, never the sealed file. Same checklist rules as `../fidelity/corpus.json`: 2–4 nouns (`hero`, `role`, `any`, `setting`) and exactly one `verb` with the controls a juror would expect, written before any run.

| group | ids | sentences | what it is |
|---|---|---|---|
| `unknown-verb` | `u01`–`u60` | 60 | a game-like sentence whose verb the keyword draft does not hear (knit, stir, weld, mow …) |
| `non-game` | `n01`–`n40` | 40 | outside game genres (an expense report, a root canal, a mortgage, a flat tire) |
| `fantasy` | `f01`–`f30` | 30 | dragons, wizards, elves, trolls |
| `mix` | `m01`–`m20` | 20 | 7 `short` ("toaster tornado"), 7 `typo`, 6 `two-verbs` |

Tags cross the groups: 127 sentences carry `unknown-verb`, 42 `non-game`, 40 `fantasy`.

- `unknown-verb` was checked once against the draft at `9691e4d4` (`noVerbTopic` in `src/play/draft/draft.ts`, the same method as P30): a sentence keeps the tag when the draft hears nothing in its checklist verb and the verb's inflections; a `short` sentence without a written verb keeps it when the draft hears nothing in the whole sentence. 7 sentences of the `unknown-verb` group used verbs the draft knows (milk, fish, sing, ring, ski, surf, pop) and were replaced by sentences with unknown verbs (shear, scrub, polish, decorate, brew, paint, fold); the tag was dropped from `f01` (guard), `m03`, `m05`, `m06` and added to `f02` (wrestle). The test only counts tags, so a later draft that learns a verb does not break the set – that is the point of P37A.
- `f02` matched a sealed sentence after normalization and was replaced. The match was found by the machine comparison only; the sealed sentence was not read.
- No sentence, after lower-casing and dropping punctuation (`normalizeSentence` in `scripts/play-fidelity.mjs`), is in the corpus, `judge-10`, `../p30/dev.json`, the 200 demand sentences (`../demand/corpus.json`) or the sealed test.

`scripts/__tests__/p37a-set.test.ts` pins the shape, the group sizes and ids, the tags each group promises and the overlaps.

## `src/play/arcade/nearest.json` – nearest catalog model (T6)

A noun the catalog has no tag for gets the nearest catalog model when the label embeddings (all-MiniLM-L6-v2, Apache-2.0, run only in `scripts/p37a/embed.py`) score it at `NEAREST_MIN` = 0.63 or above – just over the best score an abstract word reaches (`abstractCeiling`, "fashion → dress" 0.62). The scene reads it through `sceneModelOf` / `choose` in `src/play/arcade/models.ts`; the draft keeps reading `modelOf`, so genres and roles do not move. People of off-topic sentences (boss, wife, toddler, neighbor) have no useful embedding match and get a person model from the `PEOPLE` list instead.

**Re-run after every P37D batch:** `node scripts/p37d/missing-nouns.mjs` first (it writes `../p37d/missing.json`), then `node scripts/p37a/nearest.mjs`. The script prints every word with its top three matches, sorted by score; `src/play/arcade/__tests__/nearest.test.ts` goes red when a new batch lifts the abstract ceiling over the threshold.

Measured on 2026-10-04 (`baseline.measure.ts`, offline chain, not committed as `baseline.json`):

| dev-150 (199 items) | T2 baseline | before T6 (`885b644b`) | after T6 |
|---|---|---|---|
| item drawn by a model | 13 (6.5 %) | 33 (16.6 %) | 37 (18.6 %) |
| item drawn as a box (`no-model`) | 20 | 74 | 70 |
| hero drawn by a model | 59/104 | 52/104 | 53/104 |

The +30 point goal is not met. The text model is weak: of 208 table words the catalog has no tag for, 9 clear the threshold, and under it about half the matches are noise ("rabbit → turtle" 0.56, "fireball → hoop" 0.61). Of the 77 items still drawn as a box, 43 already have a label model – 38 of them are quest targets, which the scene draws with the fixed model of the quest type (tree, candle, pan, machine, cage in `src/components/play/arcade/quest/TargetStates.tsx`), not from the label. That is render work (P37B); the rest are nouns the catalog lacks (expense report, passport, towels) – P37D.
