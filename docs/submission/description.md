# Sayplay – Say it. Play it.

Type one sentence and play a 3D game made from it, with rules, a goal and a win check, in the browser in a median 1.8 s. No account, no install.

**Focus kategorie:** Browser-native creative tools

## What it does

A sentence becomes a short 3D game. The first version is a word draft built on the server from the words, published only after a robot player wins it, an idle player fails to, and two replays end in the same state hash. A deterministic runtime with seeded random streams steps every game, so a link always opens the same game and a dare score counts only after the server replays the run.

In the background an AI director, gpt-6-astra through the paid OpenAI API, returns a GameSpec: choices from a closed registry of controls, looks and roles, plus a title and a goal. The model never writes code, rules or geometry; its answer passes the same compiler and robot check. When the AI director is unavailable, the game stays the word draft and the page says so. A spend cap of 60 USD, kept in shared storage, limits the director.

## Measured

On a held-out set of 200 sentences the quick version made 200/200 playable games; the robot won 200/200 and an idle player lost 199/200 (7 Nov 2026, [run file](../../evals/play/p74/run-2026-11-07.json)). The 48 sentences there that are not game ideas, such as a tax audit, all became playable games. On the deployed demo a new sentence was playable in a median 1.8 s, and a game link reached its first frame in a median 1.4 s on an emulated iPhone 15 and 2.6 s on an emulated Pixel 7, 56/56 games played through ([report](../../evals/play/p74/live.md)). The last full AI run on the production model published 12/12 games in a median 56.7 s at 0.62 USD per game (24 Oct 2026, [report](../../evals/play/p58b/director.json)).

## What this does not claim

A robot win proves a game can be won; it does not prove that the game matches the sentence. A vision judge shown three frames recognised the hero in 39/118 sentences that name one ([report](../../evals/play/p37/o8.md), 4 Oct 2026). The paid AI director has returned no version since 3 November (HTTP 429 from the provider), so judges currently play the quick version. Phones were emulated and there is no human playtest; every result is automated.

Every number links to its measurement; the full list is in [claims.md](../../evals/play/p79/claims.md). Third-party materials and the AI tools that wrote the code: [DISCLOSURE.md](../../DISCLOSURE.md). More: [README](../../README.md).
