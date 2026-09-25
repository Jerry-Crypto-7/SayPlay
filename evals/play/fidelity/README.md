# Fidelity set – `/play`

`corpus.json` holds 30 sentences, each with a checklist written before any run (2–4 nouns, one verb). `scripts/play-fidelity.mjs` measures how much of that checklist survives from the sentence to the screen.

## Files

- `report.json` – live runs (`run` → `judge` → `report`): word draft and AI version through the running server, screenshots judged by a vision model. Never overwritten by the offline map.
- `draft-chain.json` – the offline loss map (`node --experimental-strip-types scripts/play-fidelity.mjs --offline`). No network, no model, deterministic: two runs differ only in `header.measuredAt`.

- `judge-10.json` – 10 sentences a juror might type (4 outside game genres, 3 with a verb the draft does not know, 3 fantasy), frozen on 2026-09-25 before any P28D change and reported separately so tuning on the 30 does not pass for a general gain. SHA-256 (LF line endings): `fc108201c388715dc989de94eed7b8263dc18c5276ab49baf2b6f7cf11e71990`, pinned by `scripts/__tests__/play-fidelity.test.ts`. `--offline --run <id>` writes both sets to `runs/<id>.json` and leaves `draft-chain.json` alone.

## P28D baseline (offline, before any change)

`runs/2026-09-25-p28-before.json`, build `82d924d`.

| | corpus (30) | judge-10 |
|---|---|---|
| compiled | 30/30 | 10/10 |
| inSpec | 0.691 | 0.378 |
| read | 0.655 | 0.378 |
| drawn | 0.591 | 0.324 |

9 of the 10 judge sentences fall to the grid (`tap_go`); only the dragon sentence gets another control (shooter).

## P28D T2 – nearest arcade game instead of mushrooms (offline)

`runs/2026-09-25-p28-t2.json`. A sentence where neither the control words nor any grid cue speak (no archetype score, no calm/search/moving-wall cue) now gets the nearest arcade game – verb, then noun, else the runner (`nearestControl` in `src/play/draft/controls.ts`). The arcade draft also reads sentence nouns into the roles its control reads: pickups ("grabbing sausages"), obstacles ("jumping over sprinklers", "running from a monkey"), a genre reskin ("angry birds but with cats and cardboard boxes") and a bare subject ("purple elephants doing …").

| | corpus before | corpus T2 | judge-10 before | judge-10 T2 |
|---|---|---|---|---|
| inSpec | 0.691 | 0.791 | 0.378 | 0.486 |
| read | 0.655 | **0.755** | 0.378 | 0.459 |
| drawn | 0.591 | 0.673 | 0.324 | 0.432 |

- AC `read` ≥ 0.646 + 0.10 = 0.746: met (0.755). No corpus sentence lost `read`; 8 gained (s006, s008, s069, s088, s095, s155, h07, and s088's boxes).
- Judge-10 (untuned): 5 sentences moved off the grid; j07 ("squirrel hoards acorns") **lost** `read` 0.50 → 0.25 – the grid read "hoard" as collecting, the runner does not.
- All 40 drafts compile and pass the robot (`src/play/__tests__/draft-nearest.test.ts`).

## P28D T3 – sentence nouns beat default props (offline)

`runs/2026-09-25-p28-t3.json`; `draft-chain.json` refreshed on the same build. The shooter's waves take a creature of the sentence ("rides a dragon") or the thing being popped; the throw tower is built from the target label ("cardboard boxes" → crates); "space marine" draws the astronaut. A thing the catalog lacks gets a **stand-in** in the scene (balloon → ball, sprinkler → fire hydrant) instead of the robot or hurdle, but the chain still counts it `no-model` – the stand-in is not the thing. Titles are cut at a word and never end on a preposition ("Knight Rides Dragon", not "… Over").

| | corpus T2 | corpus T3 | judge-10 T2 | judge-10 T3 |
|---|---|---|---|---|
| read | 0.755 | 0.755 | 0.459 | 0.486 |
| drawn | 0.673 | **0.691** | 0.432 | 0.432 |

- AC `drawn` ≥ 0.583 + 0.10 = 0.683: met (0.691).
- Kept on purpose: a kangaroo rival is not drawn as a fox (character categories stay off for props and rivals).

## The chain

Every checklist item gets four stages, computed by `src/play/fidelity/chain.ts`:

1. **asked** – the item is on the sentence's checklist.
2. **inSpec** – the GameSpec carries it (a role label, `theme.setting`, the control or a mechanic).
3. **read** – it sits where the control actually reads it (`src/play/capabilities.ts`), or an addon (`spec.addons`) fulfils it.
4. **drawn** – the scene draws it: the role has a body in the compiled world and the model picker (`src/play/arcade/models.ts`, on the grid `src/play/compile/assets.ts`) found a model for its label. A label without a model is drawn as a box or the default hero, so it counts as lost (`why: "no-model"`). A setting is drawn when a control that reads it draws the scene set; a verb is drawn when it is played.

`why` names the first stage where the item was lost: `not-in-spec`, `not-read-by-control`, `no-model`, `off-camera` (reserved for the camera-frame probe, never produced offline) or `ok`. `causes` lists the five most frequent `why × control × slot` groups by the number of sentences they hit.

## Known limits

- **Arena (`move_free`) setting.** The top-down camera mostly sees the arena floor. The floor takes the set's track colour and the set's props stand past the arena edge, so they come into view only near the edge. `drawn: true` here means the scene draws the set, not that the first frame shows the props.
- **Grid verbs (`tap_go`, 6 sentences after P27A T5).** "do taxes", "date", "match", "throw", "defend", "slide" – the grid walks, collects and avoids. None of these is a control or a mechanic the grid has, so the draft cannot carry them without a new control.
- **The thrown thing (`throw`, 3 sentences).** "snowballs", "cats", "cardboard boxes" – the throw scene reads only the player and target labels and always throws its own ball. Drawing the projectile from the sentence needs the scene to read a new label.
- **Grid roles without a catalog model (`tap_go`, 2 sentences).** "fishmonger" and "battery" have no asset. The nearest tags are wrong on sight ("cell" is a germ), so they stay boxes until generation adds them.

## Live run 2026-09-24-p27 (P27D T1)

Merged build `c3d0bf2`, 30 sentences, AI through `codex-cli` / `gpt-6-astra` at effort `high` on the subscription, upstream timeout 285 s. Summary with the full config and every failure: `runs/2026-09-24-p27.json` (`report.json` untouched). Late results stay in the denominator.

| | offline map (`draft-chain.json`) | live `2026-09-23-t6` | live `2026-09-24-p27` |
|---|---|---|---|
| AI version playable | – | 23/30 | **25/30** |
| failures | – | NOT_PLAYABLE 7 | NOT_PLAYABLE 3, MALFORMED 1, timeout 1 |
| late results (after deadline) | – | – | 4 (3 of them AI) |
| inSpec, final | 0.691 (draft) | 0.806 | **0.887** |
| read, final | 0.655 (draft) | 0.521 | **0.801** |
| read, draft | 0.655 | 0.360 | 0.646 |
| drawn, final / draft | – / 0.591 | not measured | 0.702 / 0.583 |
| vision judge, items seen (final) | – | 18/110 | 25/110 |
| vision judge, hero seen (final) | – | 6/18 | 10/18 |
| vision judge, setting seen (final) | – | 0/24 | 0/24 |
| draft p50 | – | 173 ms | 207 ms |
| upgrade p50 / p90 | – | 44 s / 84 s | 45 s / **317 s** |

- **Against t6:** the draft now reads almost what the offline map predicts (0.646 vs 0.655, t6 had 0.360), so wave 1 moved the first second, not just the AI version. The AI version reads 0.801 of the checklist and fails less often (5 vs 7).
- **Against the offline map:** live draft `read` matches the map within 0.01 and `drawn` within 0.01, so the map is a fair predictor of the first second.
- **p90 is a hang, not a slow model.** Four calls hit the 285 s codex timeout (`codex exec ran past the timeout` in the server log); the other 26 finished in 28–138 s. Three of the four still produced an AI version at ~315–319 s, one ended as `timeout` at 331 s. Inference: an occasional stuck `codex exec`, which the timeout cuts too late to matter for a player. Cutting that tail is T2's job.
- **The vision judge still sees no setting (0/24)** and only 25 of 110 items, while `drawn` says 0.702. The gap is the known arena/top-down limit above plus small bodies in a 3D frame; `drawn` is a structural claim, the judge is the oracle.

## Compact first answer, 2026-09-24-p27-compact (P27D T2)

Same 30 sentences, same model and config, build `b17cd5c` with `PLAY_DIRECTOR_MODE=compact` (the summary header says `05fa3e9` because `summary` stamps the HEAD it ran on; the code under test is the same). The model picks only control, addons, look, setting, title, role labels and a goal line; `src/play/director/compact.ts` builds the game on the control's template, then the same critic, robot check and repair rounds run. Summary: `runs/2026-09-24-p27-compact.json`.

| | full GameSpec (`2026-09-24-p27`) | compact (`2026-09-24-p27-compact`) |
|---|---|---|
| AI version playable | 25/30 | **30/30** |
| failures | NOT_PLAYABLE 3, MALFORMED 1, timeout 1 | none |
| late results | 4 | 0 |
| read, final | 0.801 | **0.827** |
| drawn, final | 0.702 | **0.727** |
| inSpec, final | 0.887 | 0.913 |
| read, AI versions only | 0.860 (of 25) | 0.827 (of 30) |
| vision judge, items / hero / setting (final) | 25/110 · 10/18 · 0/24 | 26/110 · 8/18 · 1/24 |
| upgrade p50 / p90 | 45 s / 317 s | **12 s / 20 s** |

- **Kept: compact**, now the default (`PLAY_DIRECTOR_MODE=full` brings the whole GameSpec back). It is faster to a playable AI version by 33 s at the median and its fidelity is not worse (read +0.026, drawn +0.025), which is the T2 rule.
- **Target not met:** the C2 working target is p50 ≤ 10 s; measured 12.4 s. The 28/30 usable target is met (30/30).
- **What compact loses:** per AI version it reads slightly less (0.827 vs 0.860) and the judge saw the hero in 8 of 18 instead of 10. The full answer writes its own mechanics and parameters; compact keeps the template's. The gain is that no sentence falls back to the draft any more.
- **Why it is faster (inference):** the answer is ~8 short fields instead of a full GameSpec, and the prompt is a control table instead of the whole registry. Nothing hung past the 285 s timeout in this run.

**The offline map measures the word draft, not the AI version.** The draft is what a player sees in the first second; the AI upgrade usually carries more of the sentence. A loss here is a loss of the offline path, and only a live run (`report.json`) says what the AI version shows.
