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

