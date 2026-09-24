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

**The offline map measures the word draft, not the AI version.** The draft is what a player sees in the first second; the AI upgrade usually carries more of the sentence. A loss here is a loss of the offline path, and only a live run (`report.json`) says what the AI version shows.
