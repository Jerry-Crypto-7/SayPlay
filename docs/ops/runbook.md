# Operations runbook – Sayplay demo

The public demo is https://worldstream-sigma.vercel.app (Next.js on Vercel, shared games in Upstash Redis). It must stay up until **31 December 2026**.

## How you find out

- **Health probe:** `.github/workflows/health-probe.yml` checks `/`, `/api/health`, `/play` and `/api/build-id` every 10 minutes. Any answer other than 200 opens one issue titled **"Demo down: health probe failed"** (later failures comment on it) and the run turns red. Close the issue once the probe is green again.
- **By hand:** `/api/health` returns `{"ready":true,"durabilityVerified":true}` when the instance can write and read back. `503` with `reason` (`WRITE_FAILED`, `READ_FAILED`, …) names the failing class. `/api/build-id` returns the git tree that is live.
- Scheduled workflows run only from the default branch. GitHub pauses them after 60 days without repository activity, which is after 31 December if anything is pushed in November.

## Upstash (shared game store) is down

**What players see:** creating a game still works, but the game lives only in the memory of one server instance. The `POST /api/play/games` response carries the header `x-play-store: memory`, and Share tells the player that the link stops working after a restart. Links to games made earlier fail until Upstash is back.

**What to do:**
1. Check the Upstash status page and the database in the Upstash console (same account as the Vercel integration).
2. Do not redeploy while Upstash is down – a redeploy drops every in-memory game.
3. When Upstash is back, nothing needs to be migrated. Games made during the outage are gone; games made before it come back by themselves.

**Retention:** a game expires 180 days after it was published (`PLAY_VERSION_TTL_SECONDS`, unset in production, so the default applies). A game made on 11 November 2026 lives until May 2027. `scripts/play-extend-ttl.mjs` extends games stored before a TTL change.

## The AI model provider (OpenAI) is down or out of quota

**What players see:** every sentence still gets the instant version, built from the words without the model. The AI upgrade ends with `MODEL_UNAVAILABLE` (or a provider error class) and the game simply stays the instant version. Nothing breaks.

**What to do:** check the provider status page and the API usage page. If the key was revoked or rotated, set the new key in the Vercel project environment (Production) and redeploy. Never paste a key into the repository, an issue or a log.

## The spending cap is used up

The AI director runs under a hard server-side spend cap that reserves the worst case before each call. A daily per-visitor limit applies too (`PLAY_DIRECTOR_CALLS_PER_CALLER`, default 12). Once either is reached, games stay the instant version. This is the intended behaviour, not an outage.

**What to do:** nothing, unless the cap was reached early because of abuse. Then check the Vercel logs for the busiest callers before raising anything. Raise the cap only with a new budget decision, by changing the cap variable in the Vercel environment and redeploying.

Publishing is capped at `PLAY_PUBLISH_DAILY_CAP` new games per day (default 500). Above it, `POST /api/play/games` answers `429 PUBLISH_QUOTA` until the next day. Raise the variable if a traffic spike is legitimate.

## Vercel limits

- **Function errors or timeouts:** check the Vercel project's Logs and Usage pages. The instant version needs no model call. Under 20 concurrent visitors (8 November 2026) every request succeeded and creating a game took 5.9 s p50 and 8.2 s p95.
- **Plan limits (bandwidth, invocations):** the Usage page shows how close the project is. When a limit is hit, Vercel pauses or throttles the project; upgrading the plan or waiting for the billing cycle are the only fixes.
- **Deployment blocked:** if a deployment stays in a blocked state, deploy from a clean export of the `main` branch (below) instead of the Git integration.

## Redeploy

1. Take the commit to deploy from `main` and export it into an empty folder (`git archive <commit> | tar -x -C <folder>`).
2. From that folder, with the project linked (`vercel link`), run `vercel deploy --prod`.
3. Check the live address: `/api/health` returns `ready:true` and `durabilityVerified:true`, and `/api/build-id` returns the tree of the exported commit.
4. Add a row to `docs/submission/deploy-log.md` (date, tree, source commit, deployment ID, status).

**Rollback:** in the Vercel dashboard, promote the previous deployment marked "last good" in the deploy log. Shared games are not affected by a rollback, because they live in Upstash, not in the deployment.
