# P32 acceptance set – `/play`

The sentences every P32 genre track is judged on. Fixed on 2026-09-29, before any genre code was written.

## `sentences.json`

- `sentences` – 9 open sentences. Each one names the expected genre and mode (`runner`, `quest.spatial` …, from `src/play/genre/contract.ts`), the hero and the goal-carrying verb. When a sentence has more than one verb, the one that carries the goal wins (the firefighter extinguishes; jumping over logs is an obstacle).
- `sealed` – empty for now. The controlling session adds 3 sentences in O10, written blind by astra without seeing the code. They cover the platformer, which no open sentence does.

The open sentences may be used for tuning. The sealed ones may not.

## Metrics

| metric | definition |
|---|---|
| time to a playable game | from the click to the first tick that accepts input |
| FPS | median over 20 s in the Pixel 7 profile with the CPU slowed 4× |
| hero / verb recognisable | a blind verdict by astra: the judge sees the game and is not told which hero or verb was expected |

Check the count:

```
node -e "const s=require('./evals/play/p32/sentences.json');if(s.sentences.length!==9)process.exit(1)"
```
