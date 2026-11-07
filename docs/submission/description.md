# Sayplay – Say it. Play it.

Type one sentence and play a short 3D game made from it within seconds, in the browser, with no account and no install. A full-detail version directed by AI follows in the background. Every game has its own link, can be sent to a friend as a dare and can be remixed with a sentence of your own.

**Focus kategorie:** Browser-native creative tools

**Submission draft, 7 November 2026.** Numbers dated 7 November 2026 come from the final build ([run file](../../evals/play/p74/run-2026-11-07.json)). Third-party libraries, models, assets and APIs, and the AI tools that wrote the code, are listed in [DISCLOSURE.md](../../DISCLOSURE.md).

## What the judge does

The judge opens `/play`, types a sentence or lets an idea card or **Surprise me** fill one in, and presses **Make it!**. Within seconds the quick version is on screen: a word draft built on the server from the words of the sentence, compiled into a game, won by a robot player and published. The judge plays it at once with arrow keys or touch – runner, platform, flap, steer, arena, shooter, throw, timing, rhythm or duel – or, on a grid, by tapping where to go. **Show me how** replays the robot's winning run.

The hero acts out the verb of the sentence where the judge can see it, the target of the action reacts, and the verb appears as a short caption the first time it happens. <!-- verify-before-submit -->

Meanwhile an AI director reads the same sentence and picks the controls, add-ons, look, setting, roles and goal. It answers with a GameSpec, a set of choices from a closed registry plus a title and a goal line; the model never writes code, rules or geometry. The same compiler and the same robot check run on its answer, and the page offers it as the full-detail version, a new game linked to the quick one. When the AI director is unavailable, the game stays the word draft and the page says so.

After a win the main button is **Dare a friend to beat it**. The friend opens the link without an account, races a ghost of the winning run and gets "You beat it!" or "So close.", with **Dare back** one tap away. Each game keeps a leaderboard of its best runs, and the server replays every run before it counts, so a score sent by a browser is never trusted. <!-- verify-before-submit --> After a win or a loss the player can also tap a remix chip such as "Make it harder" or "Swap the enemy", or type a remix sentence. Every remix is a new game with a link back to its parent; the original never changes. The feed shows games one per screen.

## How it works

A deterministic runtime steps every game: arcade games at a fixed 60 Hz, the grid at 20 Hz, with seeded random streams and no wall-clock time inside the hashed state. Nothing unwinnable is published: the compiler tries up to four seeds, the robot must win the game and replay it to an equal state hash, and a game that a player who does nothing would win is refused. A game's id is a hash of its spec, world, seed and component versions, so a published game is never edited in place.

The scene draws from a library of 1787 catalogue models – 362 CC0 models, 57 built by code in Blender, 32 built by code in three.js and 1336 generated offline from text through an image and mesh pipeline recorded per model – plus 15 rigged CC0 characters. Every game plays generated music and sound effects chosen by its look.

The director is gpt-6-astra through the paid OpenAI API. It sits behind a server-side spend cap kept in shared storage, so the cap holds across serverless instances. <!-- verify-before-submit --> The demo and its backend stay online until at least 31 December 2026.

## Measured so far

On a held-out set of 200 test sentences scored on 4 October 2026 ([report](../../evals/play/p37/o8.md)), the quick version alone, without the AI director, produced a playable game for 200/200 sentences; the robot won 200/200 and a player who does nothing lost 200/200. A blind vision judge looking at a three-frame clip of the robot's run recognised the verb in 18/200 sentences and the hero in 39/118 of the sentences that name one. The quick version read the verb from the words in 98/200 sentences.

On 7 November 2026 the same 200 held-out sentences went through the quick version again on the final build, offline and without the vision judge ([run file](../../evals/play/p74/run-2026-11-07.json)): 200/200 playable, the robot won 200/200 and a player who does nothing lost 199/200 (the exception is a submarine game, t182). The word check now counts the verb as read in 75/200 sentences, against 98/200 on 4 October. That check is older than several of the newer games: "sort recycling on a fast conveyor belt at the dump" now becomes a sorting game and still counts as not read, so part of the drop comes from the check, not from the game.

On the trial deployment on 7 November 2026, the quick version answered a new sentence in a median 1.8 s (5/5 sentences, [ai.json](../../evals/play/p74/ai.json)), and a game link loaded to its first frame in a median 1.4 s on an emulated iPhone 15 and 2.6 s on an emulated Pixel 7, 28 games on each phone, all 56 played through by the robot ([phones.json](../../evals/play/p74/phones.json)). On 6 November 2026 the emulated Pixel 7 with a four times slower CPU held a median 45–60 FPS in each of 8 games ([report](../../evals/play/p73/sceny/perf.md)). Both phones are emulated on a desktop PC; no real phone was measured.

The full-detail version was not measured on the final build. On 7 November 2026 the trial deployment returned it for 0/5 sentences (`MODEL_UNAVAILABLE`, the director key was not accepted), and the local run had no director key, so no time until it is on screen and no cost per version could be taken; the run spent 0 USD. The last measurement is from 24 September 2026: the full-detail version for 30/30 sentences, AI time p50 12 s and p90 20 s ([report](../../evals/play/fidelity/README.md)).

The stunt game is switched off in this build and is not part of the submission.

## What this does not claim

A robot win and an equal replay hash prove that a game can be won and replays exactly; they do not prove that the game matches the sentence. The quick version turns a verb it does not know into the nearest game it can build, most often collecting things, so without the full-detail version such a sentence plays as a different game than the one described. All results above are automated; there is no human playtest yet.

[README](../../README.md) · [Director](../play/director.md) · [Arcade](../play/ARCADE.md) · [Third-party disclosures](../../DISCLOSURE.md)
