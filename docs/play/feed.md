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
{ "games": [{ "versionId", "title", "archetype", "createdAt", "parentId", "remixes", "goal", "mood" }], "next": "…" | null }
```

- `goal` is the spec's `tutorial.goalLine` and `mood` its `theme.mood`, written into the list row
  at publish so a card shows them without fetching the game. Rows written before that carry `null`.

- Ranked by the loop (P36B T9): games people finish, send as a dare and remix go up, games people
  skip go down. Heat = finishes + 3 × dares + 3 × remixes − ½ × skips (never below 0), halved for
  every day a game is older than the newest one in the snapshot (`top`), so the same snapshot and
  counters always give the same order. Every third place goes to the newest game not shown yet, so a
  new game with no history still shows within the first three. With no counters the order is newest
  first, as before.
- The counters live in the store (`<prefix>:play:loop:<finish|dare|skip>:<versionId>`) and grow when
  `POST /api/play/events` reports `win`/`lose`, a `share` with `dare: true`, or `next_game` – only for
  a game that exists in the store, so a made-up id creates no key. Remixes are the version's children.
  A caller can still inflate a real game within the events door's own rate limit; the feed is a
  showcase, not a leaderboard.
- In every block of eight at most three games of one archetype (`diversify`), taken in the ranked
  order. Once no other archetype is left to mix in, the remaining games follow in that order without
  the rule – they are never dropped.
- `next` is the cursor of the following page, `null` on the last one. An empty store is
  `{ "games": [], "next": null }`.
- `?recent=N` without a cursor returns the first page in the same shape as before, plus `next`.
- `x-play-store: memory` – production without a shared store: games vanish with the process
  (P27B T1).

## Paging guarantees

The first page remembers the newest row of the list (`top`); the cursor carries `top` and how many
games were already handed out. Every later page recomputes the same ordered, diversified list from
rows no newer than `top`. So:

- **Pages never overlap and never skip while the counters stand still.** A game published between
  two requests sits above `top` and does not move anything below it; the reader sees it on the next
  fresh load.
- Counters that move between two pages can move the ranked order: a later page may repeat a game the
  reader already has (`FeedPager` drops it) or miss one that rose above the reader's position (it
  shows on the next fresh load).
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

## On `/play`

`FeedPager` shows one game at a time: full screen on a phone (≤ 700 px), with the list of more games
on the right on a wide screen. Only one game is mounted (one WebGL canvas); the next game's detail is
fetched ahead, its canvas mounts on the move. `?g=<versionId>` follows the game on screen and Back
returns the previous one. Move with `Next game` / `Previous game`, with ↑/↓ when the game itself does
not use those keys, or with a vertical swipe on the edge rail – never on the game, where a swipe is a
jump or an aim. A game less than half on screen or in a hidden tab pauses and resumes on the
player's first key or tap.

## Sharing and the link preview

`Share` sits in the game HUD while it runs and after it ends; it shares `/play/<versionId>` – the
immutable version on screen – through the browser's share sheet, or copies it.

The link preview (`GET /api/play/games/<id>/og`, PNG 1200×630) is a **cover image** drawn from the
game's data: its title, its setting, one controls line and the hero's catalog thumbnail (a target icon
when the hero has none), on a palette picked from the mood or setting. It is not a screenshot of the
game – there is no GPU on the server. It is cached per version (`immutable`); if drawing fails, the
older mood-palette image is served with `x-og-fallback: 1` and a one-hour cache.

## Visibility

**A hidden or ineligible game still opens by its link**: `GET /api/play/games/<id>` and `/play/<id>`
answer 200 as long as the game is stored.
