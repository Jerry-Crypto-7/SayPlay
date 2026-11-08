# Demo walkthrough – Sayplay

State on 8 November 2026, checked on the public demo that day. One path through the demo, for judges and for recording the video. The public address is `demoUrl` in [submission.json](submission.json); the demo and its backend stay online until at least 31 December 2026.

## On the public address

1. Open `/play` (the root `/` redirects there). Under "Say it in one sentence", type a sentence of your own in English, or let an idea card or **Surprise me** fill one in, and press **Make it!**.
2. The quick version is playable in a median 1.8 s on the deployed demo ([measurement](../../evals/play/p74/ai.json)). It is built on the server from the words of the sentence and published only after a robot player has won it, an idle player has failed to win it, and two replays have ended in the same state hash. The address changes to `/play/<id>`.
3. Play it with arrow keys or touch; grid games move where you tap. Right after your first move a short caption names the action from the sentence, for example "Throw at the targets!". **Show me how** in the pause menu plays the robot's winning run and ends with "Demo finished".
4. While you play, the page says "Quick version · the full-detail one is on its way": the AI director (gpt-6-astra through the paid OpenAI API) reads the same sentence and picks the controls, add-ons, look, setting, roles and goal. When it answers, the page says "Full-detail version ready" with a **Play it** button; the full-detail version is a new game linked to the quick one.
5. **On the demo today the AI director does not answer.** Since 3 November the model provider refuses its calls (HTTP 429), so after a few seconds the page says "Couldn't make the full-detail version right now. Keep playing the quick one." Every game you make is the quick version. The last full run of the AI version is in the [director measurement](../../evals/play/p58b/director.json).
6. After a win ("You did it!"), **Dare a friend to beat it** shares or copies the link. Opened in a private window or on a phone, the link says "A friend dares you: beat" and the score, plays the same game without an account against a ghost of the winning run labelled "Friend", and ends with "You beat it!" or "So close." and **Dare back**. The server replays the friend's inputs before the score counts ([dare route](../../src/app/api/play/games/[id]/dare/route.ts)).
7. After a win or a loss: play again, or press **Remix it** and tap a remix chip ("Make it harder", "Swap the enemy", …) or type a remix sentence. A remix is a new game with a link back to its parent; the original never changes.
8. Back on `/play`, the feed sits under the sentence field: on a phone one game per screen, swipe to move on; on a desktop one large game with "Up next" beside it.

## What the judge sees when something is missing

- **AI unavailable or the spend cap reached:** every game stays the quick version and the page says so. Nothing stops.
- **A verb the quick version does not know:** the sentence becomes the nearest game it can build, most often collecting things.
- **A thing the library does not have:** the scene uses the closest catalogue model or a simple stand-in shape.

## Run it locally

```powershell
npm ci
npm run build
node node_modules/next/dist/bin/next start
```

Open `http://localhost:3000/play`. Without model configuration every game is the quick version. The full-detail version needs the server variables from `.env.example` (`WORLDSMITH_BRANCH=live`, `WORLDSMITH_MODEL_ENDPOINT`, `WORLDSMITH_MODEL_KEY`, `WORLDSMITH_MODEL`, `WORLDSMITH_SPEND_CAP_USD`). `npm run build` builds with webpack ([package.json](../../package.json)); under Turbopack the game page and the API each get their own in-memory store.

More detail: [README](../../README.md), [director](../play/director.md), [arcade](../play/ARCADE.md), [feed](../play/feed.md).
