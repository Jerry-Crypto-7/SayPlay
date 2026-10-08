# Demo walkthrough – Sayplay

State on 8 October 2026. One path through the demo, for judges and for recording the video. The public address is `demoUrl` in [submission.json](submission.json); the demo and its backend stay online until at least 31 December 2026.

## On the public address

1. Open `/play` (the root `/` redirects there). Type a sentence of your own in English, or let an idea card or **Surprise me** fill one in, and press **Make it!**.
2. Within 1–2 s the quick version is playable: a word draft built from the words of the sentence, compiled and won by a robot player that also replays it to an equal state hash. The address changes to `/play/<id>`.
3. Play it. Arcade games use arrow keys or touch, depending on the controls (runner, platform, flap, steer, arena, shooter, throw, timing, rhythm, duel); grid games move where you tap. **Show me how** in the pause menu replays the robot's winning run.
4. The hero acts out the verb of the sentence, its target reacts, and the verb appears as a short caption the first time it happens. <!-- verify-before-submit -->
5. In the background the AI director (gpt-oss-20b on a hosted provider, a larger model through the OpenAI API as a backup) picks the controls, add-ons, look, setting, roles and goal. When it is done, the page says "Full-detail version ready" with a **Play it** button; the full-detail version is a new game linked to the quick one. When the AI is unavailable, the game stays the word draft and the page says so.
6. After a win, **Dare a friend to beat it** shares or copies the link. Opened in a private window or on a phone, the link plays the same game without an account, against a ghost of the winning run, and ends with "You beat it!" or "So close." and **Dare back**.
7. The leaderboard after a win and under **About this game** lists the best verified runs of that game. <!-- verify-before-submit -->
8. After a win or a loss: play again, tap a remix chip ("Make it harder", "Swap the enemy", …) or type a remix sentence. A remix is a new game with a link back to its parent; the original never changes.
9. The feed shows games one per screen; swipe or scroll to move on.

## What the judge sees when something is missing

- **AI unavailable or the spend cap reached:** every game stays the word draft and the page says so. Nothing stops.
- **A verb the quick version does not know:** without the full-detail version the sentence becomes the nearest game it can build, most often collecting things.
- **A thing the library does not have:** the scene uses the closest catalogue model or a stand-in (a balloon becomes a ball).

## Run it locally

```powershell
npm ci
npm run build
node node_modules/next/dist/bin/next start
```

Open `http://localhost:3000/play`. Without model configuration every game is the word draft. The full-detail version needs the server variables from `.env.example` (`WORLDSMITH_BRANCH=live`, `WORLDSMITH_MODEL_ENDPOINT`, `WORLDSMITH_MODEL_KEY`, `WORLDSMITH_MODEL`, `WORLDSMITH_SPEND_CAP_USD`). Build with webpack (`npm run build`), not Turbopack: under Turbopack the game page and the API each get their own store.

More detail: [README](../../README.md), [director](../play/director.md), [arcade](../play/ARCADE.md), [feed](../play/feed.md).
