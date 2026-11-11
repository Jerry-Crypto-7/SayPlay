# Driving Sayplay with an automated browser

The whole path from sentence to shared link can be driven and read from the DOM: find elements by `data-testid` and read their `data-*` attributes. Nothing needs pixels from the canvas, and no step needs a fixed wait.

**How long each step takes** (one run of `e2e/p85-automation.spec.ts` on a local production build, 11 November 2026): `play-create` to the game page 3.8 s, game page to `data-state="ready"` 0.2 s, shared link in a fresh browser to `ready` 3.8 s. Allow up to 60 s for each on a slow network.

## The path, marker by marker

1. **Sentence.** On `/play`, fill `play-sentence`. Once the page is interactive, `play-counter` reads `<length>/140`; then press `play-create` (or Enter).
2. **Building.** `play-loading` covers the page; its steps in `play-status` carry `data-state="done|active|todo"`. A sentence that cannot become a game shows `play-create-error` and the page stays on `/play`.
3. **Game page.** The address becomes `/play/<id>`. The game is `play-game`: `data-version-id` is `<id>` and `data-state` is the game state (table below).
4. **Start.** At `data-state="ready"`, press an arrow key or click the stage (`arcade-stage`, in grid games `play-grid-stage`). Escape, R and M pause, restart and mute.
5. **Play.** During `running`, single games expose `play-tick` with `data-tick` (60 ticks a second, 20 in grid games), and every HUD counter is `hud-counter-<label>` with `data-count`.
6. **Result.** The run ends with `data-state="won"` or `"lost"`; within a second the result card `play-outcome` appears with `data-outcome="won|lost"`. It holds `play-score` and `play-stars` (`data-stars`) when the game has them, and `play-replay` (Play again / Try again).
7. **Share.** On the result card, `play-share` shares and `play-copy-link` copies; during play, `play-share` in the HUD opens a sheet with `play-share-dare` and `play-copy-link`. The link that was sent is then in `data-share-url` – on the card on the button pressed, in the HUD on `play-share`. After a win, `play-share` stays disabled until the server has replayed the run; its link then adds `&dare=` (a plain link if that check fails).
8. **Shared link.** In a fresh browser the link opens the same `play-game` with the same `data-version-id`. With a dare, single games show the score to beat in `play-dare-strip`.

## Game state: `data-state` on `play-game`

| Value | Meaning | Next step |
|---|---|---|
| `loading` | scene code or physics still arriving, or a grid world still being built | wait |
| `ready` | clock stopped on tick 0, waiting for the first input | press an arrow key |
| `running` | the run is on | play, or wait for the end |
| `paused` | pause card `play-paused` open, or the tab or window lost focus | `play-resume`, or a key when no card is open |
| `demo` | the robot's verified run is replaying; its end is not your result | `play-demo-stop`, or `play-demo-yours` when it ends |
| `won`, `lost` | the run ended | read `play-outcome` |

A chain of microgames goes `ready` → `running` once per round; the round card in between counts as `running`.

## Typing the same sentence again

- The quick game is built from the words with a seed derived from the sentence, never at random, and its id is a hash of the game's content (rules, world, seed, builder version), not of the time.
- So the same sentence gives the same id, the same `/play/<id>` and the same game; the server answers `200` instead of `201` when it already stores it. Spaces at the ends are trimmed; any other change, case included, gives another seed and so another id.
- The id can still change with a new server build that changes the builder, or where the server first reads sentences with a language model: a cached reading (kept 7 days) gives the same game, a fresh or timed-out one may not.
- Before the first input, a game made from a sentence can swap itself once for a version built from the model's reading: the address and `data-version-id` change. After the first input it never changes by itself.
- The AI full-detail version is a separate game with its own id: `upgrade-state` reports `data-kind` (`working`, then `ready` or `final`), and `upgrade-action` opens it.
- Nothing needs resetting. Compare `data-version-id` to know whether you got the same game; change the sentence to get another one.
