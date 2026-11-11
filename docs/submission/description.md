# Sayplay – Say it. Play it.

Type one sentence and play a short 3D game made from it, with rules, a goal and a win a robot has proved, in the browser in a median 1.8 s. For anyone with a game idea and no game engine: no account, no install, no code.

**Focus kategorie:** Browser-native creative tools

## Why it matters

A new sentence was a playable game in a median 1.8 s on the deployed demo ([report](../../evals/play/p74/ai.json)). On a held-out set of 200 sentences the quick version made 200/200 playable games; the robot won 200/200 and an idle player lost 199/200 (7 Nov 2026, [run file](../../evals/play/p74/run-2026-11-07.json)). The 48 sentences there that are not game ideas, such as a tax audit, all became playable games. A game link reached its first frame in a median 1.4 s on an emulated iPhone 15 and 2.6 s on an emulated Pixel 7, 56/56 games played through ([report](../../evals/play/p74/live.md)). The first game calls no model; the AI version cost 0.62 USD per game in the last full run, an upper bound (24 Oct 2026, [report](../../evals/play/p58b/director.json)).

## What the AI does in the product

A sentence becomes a short 3D game in two steps. First a word draft, built on the server from the words with no model call, is published only after a robot player wins it, an idle player fails to, and two replays end in the same state hash. A deterministic runtime with seeded random streams steps every game, so a link always opens the same game and a dare score counts only after the server replays the run.

In the background an AI director, gpt-6-astra through the paid OpenAI API, reads the same sentence and returns a GameSpec: choices from a closed registry of controls, looks and roles, plus a title and a goal. The model never writes code, rules or geometry; its answer passes the same compiler and robot check, so an unwinnable answer never reaches a player. When the AI director is unavailable, the game stays the word draft and the page says so. A spend cap of 60 USD, kept in storage shared by every server instance, limits the director, with about one AI version per visitor a day.

## How AI helped build it

The code, tests and documents were written with Claude Code and the Codex CLI under the author's direction; the author set the goals, reviewed the results and decided what was merged, and the demo never calls these tools. 1336 of the 1787 catalogue models were generated offline with FLUX.2-klein-4B and TRELLIS.2-4B; an AI judge chose which ones enter the library, and nothing it answered went into the library or into training data ([DISCLOSURE.md](../../DISCLOSURE.md)).

## Try it

Open the demo and type a sentence. Fifteen sentences with the start card each one gives, three of them outside the scope, are in [judge-prompts.md](judge-prompts.md); every claim here, with a file and a command to check it, is in [evidence.md](evidence.md).

## What this does not claim

A robot win proves a game can be won; it does not prove that the game matches the sentence. A vision judge shown three frames recognised the hero in 39/118 sentences that name one ([report](../../evals/play/p37/o8.md), 4 Oct 2026). The AI version was last verified end to end on 24 October; on 7 November the deployed demo returned it for 0/5 sentences ([report](../../evals/play/p74/ai.json)), and whenever it does not come, judges play the quick version. Phones were emulated and there is no human playtest; every result is automated.

Every number links to its measurement; the full list is in [claims.md](../../evals/play/p79/claims.md). Third-party materials and the AI tools that wrote the code: [DISCLOSURE.md](../../DISCLOSURE.md). More: [README](../../README.md).
