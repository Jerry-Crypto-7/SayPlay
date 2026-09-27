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

## Narrator voice without the home PC (P30A T5)

`PLAY_VOICE_ENDPOINT=openai-speech:https://api.deepinfra.com/v1/openai`, `PLAY_VOICE_MODEL=hexgrad/Kokoro-82M`, voice `af_heart`, format `opus`. DeepInfra lists Kokoro-82M at **0.62 USD per 1M characters** (model page, read 2026-09-27). The goal line is capped at 240 characters (`MAX_CHARS` in `src/app/api/play/_voice.ts`), so one game costs at most **0.00015 USD** – under the 0.001 USD target. The recording is cached under the text hash in the shared store, so a goal is paid for once, not once per play.
