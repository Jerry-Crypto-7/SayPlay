# WORLDSTREAM PLAY – Imagine a game. Play it.

Write one sentence and play a short 3D game made from it within about two seconds, in the browser, with no account and no install. An AI-directed version of the same idea follows in the background. Every game has its own link, the feed shows them one per screen, and anyone can remix a game with a sentence of their own.

**Focus kategorie:** procedural worlds

**Submission draft, 29 September 2026.** The public numbers below come from the latest automated runs (26–27 September) and will be replaced by one run on the hosted director before submission. Third-party libraries, models, assets and APIs are listed in [DISCLOSURE.md](../../DISCLOSURE.md).

## What the judge does

The judge opens `/play`, types a sentence or picks one of eight starters, and presses **Play it**. One sentence becomes a short 3D game within one to two seconds: first a word draft, built on the server from the words of the sentence, compiled, checked by a robot player and published in about 0.2 s. The judge can play it at once – tap-to-go on a grid, or one of ten arcade controls such as runner, platform, flap, steer, shooter, throw or duel.

Meanwhile the AI director reads the same sentence and chooses the control, add-ons, look, setting, roles and goal. The model writes only a GameSpec, a set of choices from a closed registry plus a title and a goal line, and never writes code, rules or geometry. The same compiler and the same robot check run on its choice, and the page offers the result as the AI version, a new game linked to the draft. When the AI director is unavailable the game stays the word draft and the page says so.

After a win or a loss the judge can replay, tap a remix chip such as "Make it harder" or "Swap the enemy", or type a remix sentence. Every remix is a new game with a link back to its parent; the original never changes. Games can be shared by link with a preview image, and the feed shows AI-directed games one per screen.

## How it works

A deterministic runtime steps every game: arcade games at a fixed 60 Hz, the grid at 20 Hz, with seeded random streams and no wall-clock time inside the hashed state. Nothing unwinnable is published: the compiler tries up to four seeds, the robot must win the game and replay it to an equal state hash, and a game that does nothing when left alone is refused. A game's id is a hash of its spec, world, seed and component versions, so a published game is never edited in place.

The scene draws from a library of 783 catalogue models – 363 CC0 models, 56 built by code in Blender, 32 built by code in three.js and 332 generated offline from text through an image and mesh pipeline recorded per model – plus 15 rigged CC0 characters. Every game plays generated music and sound effects chosen by its look.

The director is gpt-oss, an open-weight model, on a hosted inference provider, with gpt-6-astra through the OpenAI API as a backup. Both paths sit behind a server-side spend cap kept in shared storage, so the cap holds across serverless instances. The demo and its backend stay online until at least 31 December 2026.

## Measured so far

Measured on 27 September 2026 over a 30-sentence corpus with checklists written before any run ([losses.md](../../evals/play/p30b/losses.md)): a vision judge looking at one screenshot of each AI-directed game recognised the hero in 9/18 sentences, the named items in 16/38 and the setting in 15/24. A verb shows only as motion, and a single frame recognised it in 5/30; a separate state check now proves verbs in play instead. On ten sentences a juror might type, frozen before tuning, the hero was recognised in 1/5 cases. The AI version reached the screen at a median of 17 s in the live run of 26 September.

## What this does not claim

A robot win and an equal replay hash prove that a game can be won and replays exactly; they do not prove that the game matches the sentence. The word draft ignores verbs it does not know, so without the AI version such a sentence becomes a collect game with default items. The setting was not recognisable in 9 of 24 first frames. All results above are automated; there is no human playtest yet. The running cost, about a tenth of a cent per AI version on the hosted director, is an estimate from provider prices, not a measured bill.

[README](../../README.md) · [Director](../play/director.md) · [Arcade](../play/ARCADE.md) · [Third-party disclosures](../../DISCLOSURE.md)
