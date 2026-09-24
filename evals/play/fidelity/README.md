# Fidelity set – `/play`

`corpus.json` holds 30 sentences, each with a checklist written before any run (2–4 nouns, one verb). `scripts/play-fidelity.mjs` measures how much of that checklist survives from the sentence to the screen.

## Files

- `report.json` – live runs (`run` → `judge` → `report`): word draft and AI version through the running server, screenshots judged by a vision model. Never overwritten by the offline map.
- `draft-chain.json` – the offline loss map (`node --experimental-strip-types scripts/play-fidelity.mjs --offline`). No network, no model, deterministic: two runs differ only in `header.measuredAt`.

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

**The offline map measures the word draft, not the AI version.** The draft is what a player sees in the first second; the AI upgrade usually carries more of the sentence. A loss here is a loss of the offline path, and only a live run (`report.json`) says what the AI version shows.
