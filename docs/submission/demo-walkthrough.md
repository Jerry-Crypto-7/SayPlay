# Demo walkthrough – Sayplay

State on 11 November 2026, written against the code of that day. One path through the demo, for judges and for recording the video. The public address is `demoUrl` in [submission.json](submission.json); the demo and its backend stay online until at least 31 December 2026.

- **Why it matters:** an idea becomes a game you can play and share before it goes cold – a median 1.8 s from a new sentence to a playable game on the deployed demo ([ai.json](../../evals/play/p74/ai.json)).
- **What the AI does in the product:** an AI director (gpt-6-astra through the paid OpenAI API) reads the sentence and picks the controls, add-ons, look, setting, roles and goal from a closed registry. It never writes code, and a robot must win every game before it is published.
- **How AI helped build it:** Claude Code and the Codex CLI wrote the code, tests and documents under the author's direction ([DISCLOSURE.md](../../DISCLOSURE.md)); the demo never calls them.
- **Proof:** every claim with a file and a command to check it is in [evidence.md](evidence.md); sentences to try, with the start card each one gives, are in [judge-prompts.md](judge-prompts.md).

## On the public address

1. Open `/play` (the root `/` redirects there). Under "Say it in one sentence", type a sentence of your own in English, or let an idea card or **Surprise me** fill one in, and press **Make it!**. Three sentences to start with, from [judge-prompts.md](judge-prompts.md):
   - `A goalkeeper penguin blocks snowballs thrown by a polar bear until the whistle blows` – you are the penguin and catch snowballs in five lanes.
   - `An aquarium where tapping a fish makes it swim to the surface and blow a bubble` – a tap-to-explore aquarium.
   - `A bakery where I pack twelve cupcakes into boxes of four and it shows how many boxes are full` – a collecting game with a count to 12.
2. The quick version is playable in a median 1.8 s on the deployed demo ([measurement](../../evals/play/p74/ai.json)). It is built on the server from the words of the sentence and published only after a robot player has won it, an idle player has failed to win it, and two replays have ended in the same state hash. The address changes to `/play/<id>`. The start card names you, the opponent, the place and the game type, and says what was swapped when the sentence asks for something the quick version cannot do, for example "Packing isn't here yet – here's a collecting game."
3. Play it with arrow keys or touch; grid games move where you tap. **Show me how** in the pause menu plays the robot's winning run and ends with "Demo finished".
4. While you play, the page says "Quick version · the full-detail one is on its way" (or its place in the queue): the AI director reads the same sentence. When it answers, the page says "Full-detail version ready" with a **Play it** button; the full-detail version is a new game linked to the quick one.
5. **If the AI director does not answer**, the page says "The quick version is the one to play." with a **Try again** button, and the game stays the quick version. That is what the demo did on 7 and 8 November ([report](../../evals/play/p78/ai-live.md)); on 11 November, after a fix, 7 of 7 fresh sentences got their AI version in a median 164 s ([report](../../evals/play/p85/ai-live.json)), so give your own sentence a few minutes. For the three sentences in step 1 it is already made and appears seconds after the quick version. The AI version was last verified end to end on 24 October ([director measurement](../../evals/play/p58b/director.json)).
6. After a win ("You did it!"), **Dare a friend to beat it** shares or copies the link. Opened in a private window or on a phone, the link says "A friend dares you: beat" and the score, plays the same game without an account against a ghost of the winning run labelled "Friend", and ends with "You beat it!" or "So close." and **Dare back**. The server replays the friend's inputs before the score counts ([dare route](../../src/app/api/play/games/[id]/dare/route.ts)).
7. After a win or a loss: play again, or press **Remix it** and tap a remix chip ("Make it harder", "Swap the enemy", …) or type a remix sentence. A remix is a new game with a link back to its parent; the original never changes.
8. Back on `/play`, the feed sits under the sentence field: on a phone one game per screen, swipe to move on; on a desktop one large game with "Up next" beside it.

## What the judge sees when something is missing

- **AI unavailable or the spend cap reached:** every game stays the quick version and the page says so. Nothing stops.
- **A verb the quick version does not know:** the sentence becomes the nearest game it can build, and the start card says what was swapped.
- **A thing the library does not have:** the scene uses the closest catalogue model or a simple stand-in shape.

## Run it locally

```powershell
npm ci
npm run build
node node_modules/next/dist/bin/next start
```

Open `http://localhost:3000/play`. Without model configuration every game is the quick version. The full-detail version needs the server variables from `.env.example` (`WORLDSMITH_BRANCH=live`, `WORLDSMITH_MODEL_ENDPOINT`, `WORLDSMITH_MODEL_KEY`, `WORLDSMITH_MODEL`, `WORLDSMITH_SPEND_CAP_USD`). Build with webpack, as `npm run build` does ([package.json](../../package.json)), not Turbopack.

More detail: [README](../../README.md), [director](../play/director.md), [arcade](../play/ARCADE.md), [feed](../play/feed.md).
