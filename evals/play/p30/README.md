# P30 sets – `/play`

Two sets for the P30 model comparison. Tune on the dev set; open the test set once, for the final number.

## `dev.json` – 60 sentences

- the 30 sentences of `../fidelity/corpus.json`, copied unchanged;
- the frozen `../fidelity/judge-10.json`, copied unchanged;
- 20 new sentences (`source: "dev"`, ids `d01`–`d20`).

`scripts/__tests__/p30-sets.test.ts` checks the copies still equal their sources.

## `test-200.json` – 200 sentences, sealed

Written on 2026-09-27 before any P30 change, the way a juror would type them. SHA-256 (LF line endings): `7222b9b9d9020af2294f84ca0187f3f33c6ad79806f11b0381e4064e72c629a8`, pinned by the test.

| tag | sentences | meaning |
|---|---|---|
| `non-game` | 48 | outside game genres (a speech, a tax audit, laundry) |
| `unknown-verb` | 126 | the keyword draft hears nothing in the verb |
| `fantasy` | 41 | dragons, wizards, elves, trolls |

- `unknown-verb` was checked once at the freeze against the draft (`noVerbTopic` in `src/play/draft/draft.ts` on the verb and its inflections, build `fd8cd106`): 15 of the first 141 tags were verbs the draft knows (cook, deliver, pull, catch, carry …) and were dropped. The test only counts tags, so a later draft that learns a verb does not break the seal.
- No sentence, after lower-casing and dropping punctuation, is in the corpus, `judge-10`, the 200 demand sentences (`../demand/corpus.json`), the dev set or `evals/play/train/**/*.jsonl` (substring match, when that folder exists).
- The test set is not read for tuning, retrieval examples (P30A T8) or the panorama library (T4).

## Opening the test set

```
node --experimental-strip-types scripts/play-fidelity.mjs run --set test --open-test-once --run <id>
```

Without `--open-test-once` the run refuses. With it, `test-opened.json` is written (time, run id, commit, SHA-256) before the first sentence leaves, and every later opening refuses. The seal keys on the content (`source: "test"`), so a copied file or `--only` does not sidestep it. A run that dies half way cannot be resumed; the opening is spent.

## Fair model comparison (P30A T7)

```
npm run build
node --experimental-strip-types scripts/play-fidelity.mjs --models astra,oss20b --set dev [--concurrency 2] [--cap-usd 3] [--port 3331]
```

Keys and endpoints come from `.env.local`: `oss20b` from `WORLDSMITH_MODEL_*`, `astra` from `WORLDSMITH_FALLBACK_*`, both must be `openai:` endpoints. Each model runs alone on its own `next start` over the same `.next` build: no backup model, its own in-memory games, cache and spend book, so neither model sees the other's games. Every sentence goes POST → the draft page → the upgrade, which is published only after the robot check, as in production → the AI version's page. The time is from sending the sentence to a playable game in the browser (the game probe mounted and one more frame drawn), not the POST answer. The cost is the sum of the server's `[play] director call billed` lines divided by sentences and by published games; each line carries what the spend cap charged, so a call without a receipt (timeout, abort) counts at its full reservation and a model that fails more does not read cheaper. The run refuses a `.next` build older than the last commit, and re-reads the build stamp (`BUILD_ID` plus its write time, since `BUILD_ID` alone is `unbuilt`) after each model, so a rebuild between the models reads as a different build. `--cap-usd` is split evenly between the models, and the run refuses, before anything is paid, a cap under `concurrency × worst-case call × 1.5` (the calls in flight) or under `sentences × worst-case call × 1.5` (the whole run: the spend book adds up every sentence, and an empty book would refuse the rest). The worst-case call is `max output tokens × output price`, so for astra at 8,000 tokens and 10 USD per million the 60-sentence dev set needs 7.2 USD per model; lower `WORLDSMITH_FALLBACK_MAX_OUTPUT_TOKENS` or raise `--cap-usd`. `--concurrency` stops at 2: one `next start` is one instance, and its play door runs two director calls at once, so a third judge would get a draft from the door and the summary would blame the model (the slower one more, since it holds its slot longer). How five judges fare is a question about instances, not models.

Every sentence without a published AI version is booked by the cause the server logged (`[play] upgrade of <id> ended … – <detail>`): `door` (no free play slot), `cap` (the spend cap, the call cap or the caller's daily calls) or `model` (everything else). Only `model` counts as the model's failure; `door` and `cap` sentences go to their own `refused` counters and out of the publish share, fidelity and times – a published sentence that hit the door or the cap on an earlier attempt too, since its time includes the wait. One such sentence makes the run invalid: the summary carries `valid: false` with the reason, the script exits with 1, and its numbers are not cited. To keep an attempt from leaking into the next sentence, the judge's page goes to `about:blank` as soon as the upgrade ends (the draft page polls every 2 s, and a poll after a temporary failure starts a new attempt), and the script waits until the server has settled every attempt it started for that draft (`[play] upgrade attempt started|settled <id>`, at most 300 s) before the next sentence. Summary in `compare-<run>.json`, raw results and server logs in `evals/play/fidelity/runs/compare-<run>/` (not committed).

Dry run against a local mock provider on 2026-09-27 (3 sentences, 2 judges, no money): both models 3/3 published, the cost per game matched the mock's tokens exactly, and port 3331 was free after the run.

## Narrator voice without the home PC (P30A T5)

`PLAY_VOICE_ENDPOINT=openai-speech:https://api.deepinfra.com/v1/openai`, `PLAY_VOICE_MODEL=hexgrad/Kokoro-82M`, voice `af_heart`, format `opus`. DeepInfra lists Kokoro-82M at **0.62 USD per 1M characters** (model page, read 2026-09-27). The goal line is capped at 240 characters (`MAX_CHARS` in `src/app/api/play/_voice.ts`), so one game costs at most **0.00015 USD** – under the 0.001 USD target. The recording is cached under the text hash in the shared store, so a goal is paid for once, not once per play.
