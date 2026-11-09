# P79 T4 – blind judge of the README

Judge: Codex (`codex exec`, reasoning high, read-only, no web) as a hackathon judge, given only the two READMEs as `a.md` and `b.md` in an empty temporary directory, plus the brief and the seven focus categories (`scripts/readme-judge.mjs`). Which side is the new README is drawn from the seed; the judge never sees the key.

## Round 1 – 2026-11-08 06:33, seed 7901

Old README: `origin/main:README.md`; new README: working tree at `4848243b`. New = `a.md`. **Winner: new.** A provides a live entry point, a practical judging sequence, explicit coverage of the brief, and stronger explanations of engineering choices and tradeoffs. Its dated, linked measurements are easier to assess than B's inconsistent status narrative, although the unavailable AI director and weak prompt fidelity materially limit both entries.

| | clarity | persuasiveness | technical depth | credibility | total |
|---|---|---|---|---|---|
| new | 9 | 7 | 9 | 8 | 33/40 |
| old | 6 | 5 | 7 | 6 | 24/40 |

**new – would score lower:**
- The deployed AI director returned 0/5 versions; the opening promise of two versions overstates current availability.
- Playable output does not establish prompt fidelity: only 75/200 verbs were recognised, and current visual fidelity remains unmeasured.
- The closed registry limits creative scope; unfamiliar requests become existing mechanics rather than the requested working system.
- Invisible projectiles and keyboard handling that interferes with remix typing undermine core interactions.
- There are no human playtests or physical-phone measurements, and deployed generation latency covers only five prompts.
- The last successful AI run took a median 56.7 seconds and cost $0.62 per game; daily and lifetime caps further restrict judging.

**new – claims without evidence:**
- a shooter with waves that get faster
- A dare link replays the winner's run as a ghost
- Show me how replays the robot's winning run inside the game.
- the page swaps it in when it is ready
- the check is older than several of the newer games
- so part of that gap is the check
- Spawned projectiles are not drawn
- game keys listen on the whole window
- typing a remix sentence on a shared link can lose letters
- No human playtest yet
- under Turbopack the game page and the API get separate in-memory stores

**old – would score lower:**
- No live demo URL is provided; opening /play is insufficient for a judge without the deployment address.
- The opening says an AI-directed version follows, but the final-build deployment produced 0/5 AI versions.
- The 5 November status says measurements are from September and await replacement, despite November final-build results appearing below.
- Unknown verbs become collect games with default items; out-of-category prompt handling is neither demonstrated nor explained against the brief.
- Visual recognition is weak: 26/110 items and 1/24 settings, with no current measurement showing improvement.
- Invisible projectiles, interfering keyboard handlers and the absence of human playtests weaken confidence in the actual playing experience.

**old – claims without evidence:**
- no account, no install
- the root `/` redirects there
- let an idea card or Surprise me fill one in
- every remix is a new game with a link back to its parent
- Each game has a link (`/play/<id>`) with a preview image
- Every game plays generated music and sound effects chosen by its look
- an optional voice reads the objective
- The director runs under a server-side spend cap and a daily count per visitor
- once either is reached, games stay the instant draft
- sentences whose verb the draft does not know become a collect game with default items
- Spawned projectiles are not drawn
- Game keys listen on the whole window
- typing a remix sentence on a shared link can lose letters
- No human playtest yet
- the page says the AI is not available
- under Turbopack the game page and the API get separate in-memory stores
- the end-to-end suite rewrite a few committed measurement files with new timings
- its app has been removed and remains in the git history

## Round 2 – 2026-11-08 06:51, seed 7902

Old README: `origin/main:README.md`; new README: working tree at `d3347dfa`. New = `b.md`. **Winner: new.** B provides a direct demo, a clear judging walkthrough, explicit engineering tradeoffs and substantially more specific evidence links. Its unavailable AI director and weak prompt fidelity still limit the entry, but its presentation makes the working system easier to understand and assess within ten minutes.

| | clarity | persuasiveness | technical depth | credibility | total |
|---|---|---|---|---|---|
| new | 9 | 8 | 9 | 8 | 34/40 |
| old | 7 | 5 | 8 | 7 | 27/40 |

**new – would score lower:**
- The deployed AI director is unavailable, and this decisive limitation appears late despite earlier promises of two versions.
- Out-of-category success measures whether a game runs, not whether it fulfils the request; a poem or explanation becomes a fallback game.
- Semantic fidelity remains weak: only 75/200 draft verbs were recognised, while the visual-fidelity evidence predates the current scenes.
- The measured AI version takes 56.7 seconds and costs $0.62; the $60 lifetime cap and roughly daily visitor limit constrain judging access.
- Robot playthroughs, emulated phones and AI preference judgments provide no direct evidence of human playability or enjoyment.
- The video is a placeholder, and an uptime-monitor link does not establish the promised future availability.

**new – claims without evidence:**
- No account
- a downhill runner: dodge, jump, reach the finish
- a shooter against the asteroids
- A remix chip
- a remix sentence makes a new game with a link back to its parent
- Every model records its source and licence in the catalogue
- Anything in English
- "A cat delivering pizzas across rooftops while avoiding seagulls" works as well as
- Instead of an error you get the nearest game it can build
- Without model configuration every game is the quick version

**old – would score lower:**
- No public demo URL is supplied; the concrete setup instructions require local installation, leaving browser-only access and a live backend unestablished.
- The final deployment produced AI versions for 0/5 prompts, undermining the central AI workflow.
- Prompt fidelity is weak: the draft recognised verbs in 75/200 prompts, and the vision evaluation recognised settings in 1/24 cases.
- Invisible projectiles and keyboard handling that interferes with remix typing threaten the judge's actual experience.
- The 5 November status says measurements are from September, despite subsequent rows reporting 6–7 November final-build measurements.
- All testing is automated; emulated-phone performance and robot wins do not establish human usability or enjoyment.

**old – claims without evidence:**
- no account
- the root `/` redirects there
- let an idea card or **Surprise me** fill one in
- a one-tap remix chip
- every remix is a new game with a link back to its parent
- Each game has a link (`/play/<id>`) with a preview image
- Every game plays generated music and sound effects chosen by its look
- an optional voice reads the objective
- without Upstash the server keeps games in memory and says so
- The director runs under a server-side spend cap and a daily count per visitor
- sentences whose verb the draft does not know become a collect game with default items
- Spawned projectiles are not drawn
- Game keys listen on the whole window
- typing a remix sentence on a shared link can lose letters
- No human playtest yet
- Work in progress is planned in the repository's internal plans
- Without model configuration every game is the instant draft
- the page says the AI is not available
- under Turbopack the game page and the API get separate in-memory stores
- The full unit suite (`npm run test`) and the end-to-end suite rewrite a few committed measurement files
- Sayplay grew out of an earlier world compiler built in this repository
- its app has been removed and remains in the git history

