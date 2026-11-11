# Evidence map – Sayplay

Each claim in the [README](../../README.md), with the file and line that holds it and one command or one click to check it. Commands run from the repository root after `npm ci`, with no API keys. Every number here also has a row, with its date and an exact excerpt, in [claims.md](../../evals/play/p79/claims.md); `node evals/play/p85b/check-evidence.mjs` checks that every path on this page exists.

## Why it matters

| Claim | Where | Check it |
|---|---|---|
| A new sentence is a playable game in a median 1.8 s on the deployed demo, 5 of 5 sentences (7 Nov 2026) | `evals/play/p74/ai.json:7` | `git grep -n medianQuickMs evals/play/p74/ai.json` |
| Held-out set of 200 sentences: 200/200 playable, the robot won 200/200, an idle player lost 199/200 (7 Nov 2026) | `evals/play/p74/run-2026-11-07.json:14` | `node -p "JSON.stringify(require('./evals/play/p74/run-2026-11-07.json').quick.summary)"` |
| 48 of those sentences are not game ideas (a tax audit, laundry); all 48 became games | `evals/play/p74/run-2026-11-07.json:65` | `node -p "JSON.stringify(require('./evals/play/p74/run-2026-11-07.json').quick.byTag['non-game'])"` |
| A game link reaches its first frame in a median 1.4 s on an emulated iPhone 15 and 2.6 s on an emulated Pixel 7; 56/56 games played through | `evals/play/p74/live.md:57` | `git grep -n "56/56" evals/play/p74/live.md` |
| All 8 measured games hold a median of at least 40 FPS on an emulated Pixel 7 with a 4× slower CPU (9 Nov 2026) | `evals/play/p77/perf.md:23` | `git grep -n "Medián" evals/play/p77/perf.md` |
| The first game calls no model, so it costs nothing per play; the AI version cost 0.62 USD per game, an upper bound (24 Oct 2026) | `src/app/api/play/games/route.ts:155`, `evals/play/p58b/director.json:207` | `git grep -n perGameCleanBatch evals/play/p58b/director.json` |
| 31 game types in one closed registry, 30 of them switched on | `src/play/genre/contract.ts:63`, `src/play/genre/classify.ts:692` | `git grep -n -e "export const GENRES" -e "export const ROUTE_PENDING" src/play/genre` |

## What the AI does in the product

| Claim | Where | Check it |
|---|---|---|
| The director of the deployed demo is gpt-6-astra through the paid OpenAI API, with no fallback model | `scripts/cloud/env.production.example:24`, `DISCLOSURE.md:13` | `git grep -n -e "^WORLDSMITH_MODEL=" -e "^WORLDSMITH_FALLBACK" scripts/cloud/env.production.example` |
| The director writes only a GameSpec of 1–3.5 kB – registry choices, a title and a goal – never code, rules or geometry | `docs/play/director.md:5`, `src/play/spec.ts:270` | `git grep -n "Model píše jen GameSpec" docs/play/director.md` |
| Its answer must pass a strict schema: all keys required, no extra keys | `src/play/director/answer-schema.ts:102` | `npx vitest run src/play/__tests__/director-answer-schema.test.ts` |
| The AI reading of the sentence runs only for the AI version; the first game is drafted from the words without a model call | `scripts/cloud/env.production.example:56`, `src/app/api/play/games/route.ts:155` | `npx vitest run src/app/api/play/__tests__/create-reader.test.ts` |
| An AI answer that is not a playable game is refused, and the quick game stays | `src/app/api/play/_publish.ts:269` | `npx vitest run src/app/api/play/__tests__/upgrade-rejected.test.ts` |
| Spend cap: 60 USD lifetime for the director and 6 director calls per visitor a day (about one AI version) | `scripts/cloud/env.production.example:28`, `scripts/cloud/env.production.example:39` | `npx vitest run src/server/__tests__/spend-cap.test.ts` |
| The cap ledger is shared by every server instance, so it holds on serverless hosting | `src/server/spend-store.ts:2` | `npx vitest run src/server/__tests__/spend-store.test.ts` |
| An accepted AI answer is cached by sentence for seven days, so the same sentence gets the same AI version without a new call | `src/play/director/cache.ts:9`, `src/server/answer-cache.ts:73` | `npx vitest run src/play/__tests__/director.test.ts -t cache` |
| When the AI version does not come, the page says "The quick version is the one to play." | `src/components/play/UpgradeBanner.tsx:240` | `npx vitest run src/components/play/__tests__/upgrade-banner.test.ts` |

## How AI helped build it

| Claim | Where | Check it |
|---|---|---|
| The code, tests and documents were written with Claude Code (claude-opus-5, claude-opus-5-5) and the Codex CLI (gpt-5.6-sol, gpt-6-astra) under the author's direction | `DISCLOSURE.md:11` | `git grep -n "through the Codex CLI" DISCLOSURE.md` |
| Those tools are not part of the product; the demo never calls them | `DISCLOSURE.md:11` | `git grep -n "the demo never calls them" DISCLOSURE.md` |
| 1336 of the 1787 catalogue models were generated offline (FLUX.2-klein-4B image, TRELLIS.2-4B mesh, Blender finishing) | `evals/play/p79/catalog.json:9`, `DISCLOSURE.md:15` | `git grep -n -e "catalogueModels" -e "generatedOffline" evals/play/p79/catalog.json` |
| An AI judge decides which generated models enter the library; nothing it answers goes into the library or into training data | `DISCLOSURE.md:3116` | `git grep -n "trénovacích dat" DISCLOSURE.md` |
| Music, sounds and the video voice are AI-generated and labelled as such | `DISCLOSURE.md:15`, `DISCLOSURE.md:21` | `git grep -n "Submission video" DISCLOSURE.md` |
| Every AI model and tool, with its licence or terms, is in one registry that the licence gate checks | `disclosure.json`, `scripts/license-gate.mjs` | `npm run gate:license` |
| Results measured by robots and AI judges are labelled as automated, not human | `README.md:79` | `git grep -n "Every result above is automated" README.md` |

## How it is built

| Claim | Where | Check it |
|---|---|---|
| Arcade games step at a fixed 60 Hz with seeded random streams; physics gives the same hash twice | `src/play/arcade/contract.ts:19` | `npx vitest run src/play/arcade/physics/__tests__/determinism.test.ts` |
| Before publishing, the robot must win, an idle player must not, and two replays must end in the same state hash | `src/play/arcade/verify.ts:716` | `npx vitest run src/play/__tests__/verify.test.ts` |
| A game whose replays differ is refused; the compiler tries up to four seeds first | `src/app/api/play/_publish.ts:269`, `src/app/api/play/_publish.ts:68` | `git grep -n -F -e "NOT_DETERMINISTIC" -e "[1, 2, 3]" src/app/api/play/_publish.ts` |
| Same sentence, same game: a game's id is a hash of its spec and world, so a link always opens the same game | `src/play/contracts.ts:144` | `git grep -n "export function gameVersionId" src/play/contracts.ts` |
| A dare score counts only after the server replays the inputs | `src/app/api/play/games/[id]/dare/route.ts:164` | `npx vitest run src/app/api/play/__tests__/dare.test.ts` |
| Every number in the README and the submission texts has a dated measurement with an exact excerpt | `evals/play/p79/claims.md`, `scripts/readme-claims.mjs` | `node scripts/readme-claims.mjs` |
| Measured sets: 200 held-out sentences, 60 hostile sentences, 20 visitors at once | `evals/play/p30/test-200.json`, `evals/play/p78/hostile.md:3`, `evals/play/p78/load.md:19` | `git grep -n -e "20 / 20" -e "56 dalo" evals/play/p78` |
| 989 unit and integration test files and 134 browser test files (11 Nov 2026) | `evals/play/p85b/counts.json` | `git ls-files "*.test.ts" "*.test.tsx" "e2e/*.spec.ts"` |
| Licences: every library, model, asset and API with source, author, licence and notices | `DISCLOSURE.md`, `disclosure.json` | `npm run gate:license` |

## Try it

| Claim | Where | Check it |
|---|---|---|
| The demo is public, no account | `docs/submission/submission.json` | [Open /play](https://worldstream-sigma.vercel.app/play) |
| The backend answers during judging | `src/app/api/health/route.ts` | [Open /api/health](https://worldstream-sigma.vercel.app/api/health) |
| A scheduled probe checks the demo every 10 minutes and opens an issue when it fails | `.github/workflows/health-probe.yml:9` | `npx vitest run scripts/__tests__/health-probe-workflow.test.ts` |
| The card before the start says how the game read the sentence: you, against, place, game type | `src/components/play/StartRead.tsx:18` | Make any game on the demo and read the card |
| A sentence outside the scope becomes the nearest game and the card says what was swapped | `src/play/draft/unsupported.ts:173` | `npx vitest run src/play/__tests__/draft-unsupported.test.ts` |
| 56 of 60 hostile sentences (other languages, nonsense, emoji only, prompt injection) became games, 4 got a clear message, 0 crashes | `evals/play/p78/hostile.md:3` | `git grep -n "0 pádů" evals/play/p78/hostile.md` |
| A dare opened in a private window plays the same game against a ghost of the winning run | `src/components/play/arcade/Ghost.tsx` | Win a game, press **Dare a friend to beat it**, open the link in a private window |
| A game is kept for 180 days, so a link sent today still opens | `src/play/version/store.ts:387` | `git grep -n "ttlSeconds: 180" src/play/version/store.ts` |
