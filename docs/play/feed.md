# PLAY feed – contract

The feed on `/play` lists published games that anyone may scroll through. It is built from
`VersionStore.recent()` (the newest `RECENT_CAP` = 200 authored versions) and `diversify()`.
Code: `src/play/version/feed.ts`, door: `src/app/api/play/games/route.ts`.

## Request

```
GET /api/play/games?recent=N[&cursor=C]
```

- `recent` – page size, a whole number from 1 to 48, no leading zero.
- `cursor` – optional, exactly the `next` value of the previous page. Opaque: clients never build or
  read it.
- Any other parameter, a repeated parameter, or a cursor this feed did not give out → `400 BAD_REQUEST`.
  A broken cursor is a 400, never a crash. The cursor carries a checksum and an offset below
  `RECENT_CAP`, so a random or edited one is refused before the list is read (and cannot mint new
  edge-cache keys). The checksum is not a signature: a caller who reads the code can compute it, and
  the per-caller rate limit (`admit()`) is what bounds that.

## Response

```json
{ "games": [{ "versionId", "title", "archetype", "createdAt", "parentId", "remixes" }], "next": "…" | null }
```

- Newest first; in every block of eight at most three games of one archetype (`diversify`). Once no
  other archetype is left to mix in, the remaining games follow newest first without that rule –
  they are never dropped.
- `next` is the cursor of the following page, `null` on the last one. An empty store is
  `{ "games": [], "next": null }`.
- `?recent=N` without a cursor returns the first page in the same shape as before, plus `next`.
- `x-play-store: memory` – production without a shared store: games vanish with the process
  (P27B T1).

## Paging guarantees

The first page remembers the newest row of the list (`top`); the cursor carries `top` and how many
games were already handed out. Every later page recomputes the same ordered, diversified list from
rows no newer than `top`. So:

- **Pages never overlap and never skip.** A game published between two requests sits above `top`
  and does not move anything below it; the reader sees it on the next fresh load.
- Only the oldest end can shift: a game that expires (TTL, 180 days) or falls off the 200-row cap
  between two pages drops out.
- Games stored before the TTL went from 60 to 180 days keep their old expiry until
  `node scripts/play-extend-ttl.mjs --prefix <prefix> --apply` runs against the shared store; until
  then such a game can still show as a card after its key expired.

## Who gets into the feed

`feedEligible(game, hidden)` decides, separately from "can be opened by link":

- `publishEligible` – the game passed the publish gate;
- `relation === 'upgrade'` – only the director's authored version, never a word draft, a hand-written
  spec or a remix (their titles are written by the caller);
- not on the hide list `PLAY_FEED_HIDE` (comma-separated `versionId`s, read per request).

On top of that, per list:

- one family, one entry – of several authored versions of one draft (same `parentId`) only the
  newest is shown;
- one title, one entry – titles equal after lower-casing and stripping punctuation appear once.

**A hidden or ineligible game still opens by its link**: `GET /api/play/games/<id>` and `/play/<id>`
answer 200 as long as the game is stored.
