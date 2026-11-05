# Sayplay – Say it. Play it.

Type one sentence and play a short 3D game made from it within about two seconds, in the browser, with no account and no install. A full-detail version directed by AI follows in the background. Every game has its own link, can be sent to a friend as a dare and can be remixed with a sentence of your own.

**Focus kategorie:** Browser-native creative tools

**Submission draft, 8 October 2026.** The TODO(measure) lines are filled in from one run on the hosted director before submission. Third-party libraries, models, assets and APIs, and the AI tools that wrote the code, are listed in [DISCLOSURE.md](../../DISCLOSURE.md).

## What the judge does

The judge opens `/play`, types a sentence or lets an idea card or **Surprise me** fill one in, and presses **Make it!**. Within one to two seconds the quick version is on screen: a word draft built on the server from the words of the sentence, compiled into a game, won by a robot player and published in about 0.2 s. The judge plays it at once with arrow keys or touch – runner, platform, flap, steer, arena, shooter, throw, timing, rhythm or duel – or, on a grid, by tapping where to go. **Show me how** replays the robot's winning run.

The hero acts out the verb of the sentence where the judge can see it, the target of the action reacts, and the verb appears as a short caption the first time it happens. <!-- verify-before-submit -->

Meanwhile an AI director reads the same sentence and picks the controls, add-ons, look, setting, roles and goal. It answers with a GameSpec, a set of choices from a closed registry plus a title and a goal line; the model never writes code, rules or geometry. The same compiler and the same robot check run on its answer, and the page offers it as the full-detail version, a new game linked to the quick one. When the AI director is unavailable, the game stays the word draft and the page says so.

After a win the main button is **Dare a friend to beat it**. The friend opens the link without an account, races a ghost of the winning run and gets "You beat it!" or "So close.", with **Dare back** one tap away. Each game keeps a leaderboard of its best runs, and the server replays every run before it counts, so a score sent by a browser is never trusted. <!-- verify-before-submit --> After a win or a loss the player can also tap a remix chip such as "Make it harder" or "Swap the enemy", or type a remix sentence. Every remix is a new game with a link back to its parent; the original never changes. The feed shows games one per screen.

## How it works

A deterministic runtime steps every game: arcade games at a fixed 60 Hz, the grid at 20 Hz, with seeded random streams and no wall-clock time inside the hashed state. Nothing unwinnable is published: the compiler tries up to four seeds, the robot must win the game and replay it to an equal state hash, and a game that a player who does nothing would win is refused. A game's id is a hash of its spec, world, seed and component versions, so a published game is never edited in place.

The scene draws from a library of 783 catalogue models – 363 CC0 models, 56 built by code in Blender, 32 built by code in three.js and 332 generated offline from text through an image and mesh pipeline recorded per model – plus 15 rigged CC0 characters. Every game plays generated music and sound effects chosen by its look.

The director is gpt-6-astra through the paid OpenAI API. It sits behind a server-side spend cap kept in shared storage, so the cap holds across serverless instances. <!-- verify-before-submit --> The demo and its backend stay online until at least 31 December 2026.

## Measured so far

On 200 sentences that were sealed before any tuning and opened once on 4 October 2026 ([report](../../evals/play/p37/o8.md)), the quick version alone, without the AI director, produced a playable game for 200/200 sentences; the robot won 200/200 and a player who does nothing lost 200/200. A blind vision judge looking at a three-frame clip of the robot's run recognised the verb in 18/200 sentences and the hero in 39/118 of the sentences that name one. The quick version read the verb from the words in 98/200 sentences.

TODO(measure): verb and hero recognised by the same judge on a fresh sealed set once the on-screen action and hero work is merged.

TODO(measure): median time until the full-detail version is on screen, from one run on the hosted director.

TODO(measure): cost per full-detail version from the provider's bill for that run.

## What this does not claim

A robot win and an equal replay hash prove that a game can be won and replays exactly; they do not prove that the game matches the sentence. The quick version turns a verb it does not know into the nearest game it can build, most often collecting things, so without the full-detail version such a sentence plays as a different game than the one described. All results above are automated; there is no human playtest yet.

[README](../../README.md) · [Director](../play/director.md) · [Arcade](../play/ARCADE.md) · [Third-party disclosures](../../DISCLOSURE.md)
