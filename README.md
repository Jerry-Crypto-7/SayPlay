# Sayplay – Say it. Play it.

Write one sentence and get a short 3D game you can play in the browser within seconds. An AI-directed version of the same idea follows in the background. Games have their own links, appear in a vertical feed, and can be remixed with a sentence of your own – no account, no install.

**Status on 5 November 2026:** working prototype, not yet submitted. The AI director is gpt-6-astra through the paid OpenAI API. The measurements below date from 24–25 September and will be replaced by one run on the final build. The known gaps are listed under [Known issues](#known-issues); nothing below claims more than was measured.

## What you can do

1. **Open `/play`** (the root `/` redirects there). Type a sentence, or let an idea card or **Surprise me** fill one in.
2. **Play the instant version.** A deterministic draft built from the words of the sentence is compiled, checked by a robot player and published on the server; on a local production build the page showed the game in 1.2–2.0 s (see [Verified behaviour](#verified-behaviour)).
3. **Get the AI version.** In the background the AI director (gpt-6-astra through the paid OpenAI API) picks the control, add-ons, look, setting, roles and goal (`PLAY_DIRECTOR_MODE=compact`, the default). The same compiler and robot check run on it before it is published as a child of the draft.
4. **Win or lose, then change one thing.** Replay, a one-tap remix chip ("Make it harder", "Swap the enemy", …) or a remix sentence of your own; every remix is a new game with a link back to its parent.
5. **Share or scroll.** Each game has a link (`/play/<id>`) with a preview image; the feed shows AI-directed games one per screen.

Eleven controls exist: tap-to-go (grid) plus ten arcade controls – runner, platform, flap, steer, arena, shooter, throw, timing, rhythm and duel.

## How it works

```
sentence ─► word draft ─► GameSpec ─► compiler ─► world ─► robot check (win + replay) ─► version (hash id)
                │                                                                    │
                └─► AI director (background) ─► GameSpec ─► same compiler + check ───┘─► child version ─► feed
```

- **The model writes only a GameSpec** – choices from a closed registry of controls, add-ons, looks and roles, plus a title and a goal line. It never writes code, rules or geometry.
- **Nothing unwinnable is published.** The compiler tries up to four seeds; the robot must win each game and replay it to an equal state hash, and a game that does nothing when left alone is refused.
- **Sound.** Every game plays generated music and sound effects chosen by its look; an optional voice reads the objective.
- **Deterministic runtime.** Arcade games step at a fixed 60 Hz with `pure-rand` streams; the grid runtime steps at 20 Hz. Real time, particles, camera and sound stay outside the hashed state.
- **Versions never change.** The id is a hash of spec, world, seed and component versions; a remix is a new version. Stored in Upstash Redis for 180 days (`PLAY_VERSION_TTL_SECONDS`); without Upstash the server keeps games in memory and says so (`x-play-store: memory`).
- **Assets.** 783 catalogue models: 363 CC0 models (Kenney, Quaternius, KayKit), 56 built by code in Blender, 32 built by code in three.js and 332 generated offline by `ops/gen3d` (FLUX.2-klein-4B image → TRELLIS.2-4B mesh → Blender finishing; each model's pipeline is recorded in its catalogue entry), plus 15 rigged CC0 characters. Generated models are used at runtime like any other catalogue model. Provenance: a `PROVENANCE.md` for the catalogue and one per model set under `public/assets/`, licences: [DISCLOSURE.md](DISCLOSURE.md).

More detail: [docs/play/director.md](docs/play/director.md), [docs/play/ARCADE.md](docs/play/ARCADE.md), [docs/play/feed.md](docs/play/feed.md), [docs/play/CONTRACT.md](docs/play/CONTRACT.md).

## Verified behaviour

| What | Result | When, where |
|---|---|---|
| Build, typecheck | pass | 25 Sep 2026, `npm run build` (webpack) |
| Unit tests of `/play` | 1047 / 1047 pass | 25 Sep 2026, `src/play`, `src/components/play`, `src/app/play`, `src/app/api/play` |
| Sentence to playable game in the browser | 1.2–2.0 s, 0 console errors | 25 Sep 2026, local production build, Chromium |
| Collect game played to a win | 5/5 items + portal, win in 34 s | 25 Sep 2026, same build |
| AI version playable | 30 / 30 sentences, AI time p50 12 s, p90 20 s | 24 Sep 2026, one live run, [evals/play/fidelity/README.md](evals/play/fidelity/README.md) |
| Sentence items read by the game / drawn in the scene | 0.827 / 0.727 (AI), 0.646 / 0.583 (draft) | same run |
| What a vision judge actually sees on screen | 26 / 110 items, hero 8 / 18, setting 1 / 24 | same run |

## Known issues

- **The AI version is capped.** The director runs under a server-side spend cap and a daily count per visitor; once either is reached, games stay the instant draft.
- **Drafts ignore unknown verbs.** Without the AI version, sentences whose verb the draft does not know become a collect game with default items.
- **The setting is rarely visible** in the first frame (see the vision judge row above).
- **Spawned projectiles are not drawn** (found in code review).
- **Game keys listen on the whole window,** so typing a remix sentence on a shared link can lose letters.
- **No human playtest yet;** all results above are automated.

Work in progress is planned in the repository's internal plans (not published).

## Quick start

```powershell
npm ci
npx playwright install chromium
npm run build
node node_modules/next/dist/bin/next start
```

Open `http://localhost:3000/play`. Without model configuration every game is the instant draft and the page says the AI is not available. The AI version needs the server-side transport and spend controls: `WORLDSMITH_BRANCH=live`, `WORLDSMITH_MODEL_ENDPOINT`, `WORLDSMITH_MODEL_KEY`, `WORLDSMITH_MODEL`, `WORLDSMITH_SPEND_CAP_USD` (see `.env.example`). Use the webpack build (`npm run build`); under Turbopack the game page and the API get separate in-memory stores.

## Checks and attribution

```powershell
npm run typecheck
npx vitest run src/play src/components/play src/app/play src/app/api/play
npm run test:e2e
npm run gate:license
```

The Safari projects (`webkit-desktop`, `iphone-touch`) need their browser once: `npx playwright install webkit`.

The full unit suite (`npm run test`) and the end-to-end suite rewrite a few committed measurement files with new timings; check `git status` afterwards. Third-party materials, models and APIs are listed in [DISCLOSURE.md](DISCLOSURE.md), generated from `disclosure.json`.

## Origin

Sayplay grew out of an earlier world compiler built in this repository (describe a place, act in it, rewind, change one rule in words and compare two futures); its app has been removed and remains in the git history, while the grid game still runs on its rule engine (`src/ir`, `src/sim`), its verifier (`src/verify`) and its asset catalogue.
