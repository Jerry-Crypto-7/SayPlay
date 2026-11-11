# Claims in the README and the submission texts, with their proof

Every number in [README.md](../../../README.md), [description.md](../../../docs/submission/description.md) and [demo-walkthrough.md](../../../docs/submission/demo-walkthrough.md) has a row here. Each row names the file in this repository that holds the measurement and an exact excerpt (`Evidence`) found in that file. `node scripts/readme-claims.mjs` checks that every number in those texts is listed here, that every file exists in the public repository, that every excerpt is in its file, and that no link in those texts is dead; `node scripts/submission-check.mjs` runs the same check as check 9.

Several measurement reports are written in Czech, so some excerpts are Czech. A decimal comma (`1,8 s`) is the same number as `1.8 s`.

## Measured results

| ID | Claim | Numbers | Date | File | Evidence |
|---|---|---|---|---|---|
| M1 | Quick version on the held-out set of 200 sentences: a playable game for every sentence | 200, 200/200 | 2026-11-07 | `evals/play/p74/run-2026-11-07.json` | `"measuredOn": "2026-11-07"` `"sentences": 200,` `"playable": {` `"hit": 200,` |
| M2 | The robot player won every one of those games | 200/200 | 2026-11-07 | `evals/play/p74/run-2026-11-07.json` | `"robotWins": {` `"hit": 200,` |
| M3 | A player who does nothing lost 199 of 200 (the exception is t182, a submarine game) | 199/200 | 2026-11-07 | `evals/play/p74/run-2026-11-07.json` | `"idleLoses": {` `"hit": 199,` |
| M4 | The word check counted the verb as read in 75 of 200 sentences | 75/200 | 2026-11-07 | `evals/play/p74/run-2026-11-07.json` | `"verbRead": {` `"hit": 75,` |
| M5 | 48 of the 200 held-out sentences are not game ideas (a speech, a tax audit, laundry); all 48 became playable games the robot won and an idle player lost | 48/48 | 2026-11-07 | `evals/play/p74/run-2026-11-07.json` | `"non-game": {` `"sentences": 48,` `"hit": 48,` |
| M6 | What the non-game set is | 48/48 | 2026-09-27 | `evals/play/p30/README.md` | `outside game genres (a speech, a tax audit, laundry)` |
| M7 | Trial deployment: a new sentence became a playable quick version in a median 1.8 s, 5 of 5 sentences | 1.8 s, 5/5 | 2026-11-07 | `evals/play/p74/ai.json` | `"medianQuickMs": 1815,` |
| M8 | Same run, in the report | 1.8 s, 5/5 | 2026-11-07 | `evals/play/p74/live.md` | `Rychlá hra 5/5, medián 1,8 s` |
| M9 | Trial deployment: the AI version came back for 0 of 5 sentences (`MODEL_UNAVAILABLE`) | 0/5 | 2026-11-07 | `evals/play/p74/ai.json` | `"aiReady": 0,` `"reason": "MODEL_UNAVAILABLE"` |
| M10 | Game link to first frame, emulated phones: median 1.4 s on iPhone 15, 2.6 s on Pixel 7; all 56 games played through | 1.4 s, 2.6 s, 56/56 | 2026-11-07 | `evals/play/p74/live.md` | `medián 1,4 s iPhone, 2,6 s Pixel` `56/56 prošlo` |
| M11 | Final scene look (P77), emulated Pixel 7 with a 4× slower CPU: every one of 8 games held a median of at least 40 FPS; the fastest median was 54.6 FPS. Local production build, machine loaded by other jobs, A/B interleaved | 40 FPS, 54.6 | 2026-11-09 | `evals/play/p77/perf.md` | `výkon telefonu (9. 11. 2026)` `Medián ≥ 40: drží všech 8.` `54,6` |
| M11b | After the last scene change the two slowest games were measured again; the slowest median was 40.0 FPS (underwater race, 4 pairs) | 40.0 | 2026-11-09 | `evals/play/p77/judge.md` | `závod pod vodou (s2), 4 páry \| 44,2 \| 40,0` |
| M12 | A blind judge (an AI model shown both versions side by side without labels) preferred the scenes of 7 November over the build before for 11 of 12 sentences | 11/12 | 2026-11-07 | `evals/play/p76/vs-main.md` | `Souzeno 2026-11-07 20:58` `vyhrálo 11/12` |
| M20 | The same judge on the final scene pass (9 November) against 7 November: 13 of 24 sheets over both side orders, a tie; it chose the right-hand image 21 of 24 times, so most sheets measure the side, not the scene | 13/24, 21/24 | 2026-11-09 | `evals/play/p77/judge.md` | `obě pořadí dohromady \| – \| – \| 13/24` `z 24 listů zvolil pravou stranu 21×` |
| M21 | 60 hostile sentences outside the category (other languages, nonsense, emoji only, very long, violence, brands, prompt injection) sent through the live form: 56 of 60 became playable games, the robot won all 56, 4 ended with a clear message; 0 crashes, 0 blank screens, 0 page errors. Deployed demo, before the five fixes the run led to | 56/60, 56/56 | 2026-11-08 | `evals/play/p78/hostile.md` | `60 vět mimo naši kategorii` `56 dalo hratelnou hru, 4 skončily srozumitelnou anglickou hláškou. 0 pádů, 0 prázdných obrazovek, 0 chyb stránky.` `robot hru vyhrál \| 56 / 56` `8. 11. 2026 08:03 UTC` |
| M22 | Same run: median 2.5 s from the click to a ready scene | 2.5 s | 2026-11-08 | `evals/play/p78/hostile.md` | `od kliknutí po hotovou scénu (56 her) \| p50 2,5 s` |
| M23 | 20 visitors at once on the deployed demo, each with a different sentence, all from one IP address: 20 of 20 got a game, 0 errors; creating and opening a game took p95 8.6 s | 20/20, 8.6 s | 2026-11-08 | `evals/play/p78/load.md` | `8. 11. 2026 09:04 UTC` `Všechno šlo z jedné IP adresy.` `**20 / 20**, 0 chyb` `**p95 8,6 s**` |
| M24 | The word check, extended on 8 November to the newer game types, counts the verb as read in 100 of 200 held-out sentences; 93 of 200 without seven doubtful cases. The games did not change; the old check still gives 75 of 200 (M4) | 100/200, 93/200 | 2026-11-08 | `evals/play/p78/verb.md` | `sloveso přečtené u **100 z 200** held-out vět` `bez nich **93 z 200**` |
| M13 | Vision judge on a three-frame clip of the robot's run: verb recognised in 18 of 200 sentences, hero in 39 of 118 sentences that name one | 18/200, 39/118 | 2026-10-04 | `evals/play/p37/o8.md` | `sloveso poznané v klipu \| 18/200` |
| M14 | The hero recognised (second excerpt of M13) | 39/118 | 2026-10-04 | `evals/play/p37/o8.md` | `hrdina poznaný` `39/118` |
| M15 | The quick version read the verb in 98 of 200 sentences on 4 October, with the same word check as M4 | 98/200 | 2026-10-04 | `evals/play/p37/o8.md` | `98/200` |
| M16 | Last measured AI version on the paid production model (gpt-6-astra, OpenAI API): 12 of 12 published, median 56.7 s until it was playable | 12/12, 56.7 s | 2026-10-24 | `evals/play/p58b/director.json` | `"model": "gpt-6-astra",` `"ok": 12,` `"aiP50": 56740,` |
| M20 | Deployed demo on submission day: 7 of 7 fresh sentences got their AI version, a median 164 s after they were sent | 7/7, 164 s | 2026-11-11 | `evals/play/p85/ai-live.json` | `"aiReady": 7,` `"medianSecondsToAiVersion": 164` |
| M17 | Cost of one AI version on that run: 0.62 USD per game, an upper bound (the ledger does not see the provider's cache discount) | 0.62 USD | 2026-10-24 | `evals/play/p58b/director.json` | `"perGameCleanBatch": 0.621628,` `prices are an upper bound` |
| M19 | Model library: 1787 catalogue models – 362 CC0, 57 built by code in Blender, 32 built by code in three.js, 1336 generated offline – plus 144 rigged CC0 characters | 1787, 362, 57, 32, 1336, 144 | 2026-11-08 | `evals/play/p79/catalog.json` | `"catalogueModels": 1787,` `"cc0": 362,` `"blenderByCode": 57,` `"threeJsByCode": 32,` `"generatedOffline": 1336,` `"riggedCharacters": 144,` |

## Spend limits (configuration of the public demo)

| ID | Claim | Numbers | Date | File | Evidence |
|---|---|---|---|---|---|
| S1 | The AI director stops at a lifetime cap of 60 USD; each visitor gets 6 director calls a day (about one AI version) | 60 USD | 2026-11-06 | `scripts/cloud/env.production.example` | `WORLDSMITH_SPEND_CAP_USD=60` `PLAY_DIRECTOR_CALLS_PER_CALLER=6` |
| S2 | The cap ledger is shared by all server instances (Upstash Redis), so the cap holds on serverless hosting | – | 2026-11-08 | `src/server/spend-store.ts` | `sdílená mezi instancemi` |

## How it works (code, checked on 2026-11-08)

| ID | Claim | Numbers | Date | File | Evidence |
|---|---|---|---|---|---|
| K1 | The model writes only a GameSpec of 1–3.5 kB, never code or a world | 1–3.5 kB | 2026-11-08 | `docs/play/director.md` | `Model píše jen GameSpec (1–3,5 kB), nikdy kód ani` |
| K2 | The GameSpec chooses from a closed registry of controls | – | 2026-11-08 | `src/play/spec.ts` | `export const CONTROLS = ['tap_go', 'runner', 'platform'` |
| K3 | The director's answer is validated against a strict schema | – | 2026-11-08 | `src/play/director/answer-schema.ts` | `.strict()` |
| K4 | Arcade games step at a fixed 60 Hz | – | 2026-11-08 | `src/play/arcade/contract.ts` | `export const ARCADE_HZ = 60;` |
| K5 | Grid games step at 20 Hz | – | 2026-11-08 | `src/play/compile/adapters/timer.ts` | `export const TICKS_PER_SECOND = 20;` |
| K6 | Before publishing, the robot must win, an idle player must not win, and two replays must end in the same state hash | – | 2026-11-08 | `src/play/arcade/verify.ts` | `nečinný hráč nevyhraje` `const replayEqual = first.hash === second.hash && first.hash === bot.hash;` |
| K7 | A game whose replays differ is refused | – | 2026-11-08 | `src/app/api/play/_publish.ts` | `code: 'NOT_DETERMINISTIC'` |
| K8 | The compiler tries up to four seeds | – | 2026-11-08 | `src/app/api/play/_publish.ts` | `return [base, ...[1, 2, 3].map((attempt) => seedFrom({ base, attempt }))];` |
| K9 | A game's id is a hash of its spec and world, so a published game never changes | – | 2026-11-08 | `src/play/contracts.ts` | `createHash('sha256').update(canonical({ ...fields, spec }))` |
| K10 | A dare score counts only after the server replays the run; the browser's score is not read | – | 2026-11-08 | `src/app/api/play/games/[id]/dare/route.ts` | `scoredReplay(arcade!, inputs, patches)` |
| K11 | A scheduled GitHub Actions probe checks the demo, `/api/health`, `/play` and `/api/build-id` every 10 minutes and opens an issue when one fails | 10 min | 2026-11-09 | `.github/workflows/health-probe.yml` | `cron: '*/10 * * * *'` `opens one "Demo down" issue` |
| K12 | A published game is kept for 180 days by default; production does not override it | 180 | 2026-11-09 | `src/play/version/store.ts` | `ttlSeconds: 180 * 24 * 3600` |
| K13 | The closed registry has 31 game types | 31 | 2026-11-11 | `src/play/genre/contract.ts` | `export const GENRES = ['runner', 'platformer', 'arena'` `'drawsave', 'orrery', 'shop'] as const;` |
| K14 | One of them, `stunt`, is switched off, so 30 are on | 30 | 2026-11-11 | `src/play/genre/classify.ts` | `export const ROUTE_PENDING: ReadonlySet<GenreId> = new Set<GenreId>(['stunt']);` |
| K15 | 989 unit and integration test files and 134 browser test files, counted with `git ls-files` | 989, 134 | 2026-11-11 | `evals/play/p85b/counts.json` | `"unitTestFiles": 989,` `"browserTestFiles": 134` |
| K16 | An accepted AI answer is cached by sentence for seven days | 7 | 2026-11-11 | `src/server/answer-cache.ts` | `export const ANSWER_TTL_SECONDS = 7 * 24 * 60 * 60;` |
| P1 | The 15 sentences of `docs/submission/judge-prompts.md`, read in Node by the quick version's reader with the reading fixes of 11 November (code `6d72c34a`): every game passed the publish gate and gave the same spec and world twice | 15 | 2026-11-11 | `evals/play/p85b/prompts-check.json` | `"codeCommit": "6d72c34a"` `"gate": "pass"` `"sameTwice": true` |

## What the AI does and how AI built it (checked on 2026-11-11)

| ID | Claim | Numbers | Date | File | Evidence |
|---|---|---|---|---|---|
| A1 | The director of the deployed demo is gpt-6-astra through the paid OpenAI API | – | 2026-11-11 | `scripts/cloud/env.production.example` | `WORLDSMITH_MODEL=gpt-6-astra` |
| A2 | On the deployed demo the AI reading of the sentence runs only for the AI version | – | 2026-11-11 | `scripts/cloud/env.production.example` | `PLAY_READER_PATH=ai` `PLAY_READER_MODEL=gpt-6-astra` |
| A3 | With that setting the first game asks no model: the reading is skipped and the game is drafted from the words | – | 2026-11-11 | `src/app/api/play/games/route.ts` | `readerForAiVersion() ? Promise.resolve(null)` `draftGameSpecWithMeta(sentence, 1, { reading: sentenceReading })` |
| A4 | The code was written with Claude Code and the Codex CLI under the author's direction; these tools are not part of the product | – | 2026-11-11 | `DISCLOSURE.md` | `Claude (Anthropic, through Claude Code, mainly claude-opus-5 and claude-opus-5-5) and Codex (OpenAI, through the Codex CLI, mainly gpt-5.6-sol and gpt-6-astra)` `the demo never calls them` |
| A5 | An AI judge decides which generated 3D models enter the library; nothing it answers is written into the library or into training data | – | 2026-11-11 | `DISCLOSURE.md` | `Odpověď (jméno předmětu) rozhoduje, jestli model jde do knihovny; do knihovny ani do trénovacích dat se z ní nic nepíše.` |

## Dropped

Claims that had no file in this repository and were removed from the texts:

- "15 rigged CC0 characters" (README before P79): the lists hold 144 (M19).
- "Eleven controls": the registry has 29 control ids, 28 of them playable (K2; `stunt` is switched off).
- "28 kinds of play" (README of 8 November): the tap-to-explore scene and the shop counter were merged on 11 November; the registry now has 31 game types, 30 switched on (K13, K14).
- "AI time p50 12 s, p90 20 s" (24 September): measured through a subscription CLI, not the production model; replaced by M16.
- "From 3 November the model provider answered HTTP 429" as the reason the AI version was missing on the demo (`evals/play/p68/result.json`): a later check found the deployment's API keys were the cause. The texts now say only when the AI version was last verified (M16) and that the demo returned none on 7 November (M9).
- "Frame rate 45.3–59.6 FPS" (6 November, `evals/play/p73/sceny/perf.md`): measured on the scenes before the final look; replaced by M11 and M11b.
