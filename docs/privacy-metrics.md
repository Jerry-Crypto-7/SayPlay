# What the play funnel measures

The internal `/play/stats` page counts how people move through a game and whether they come back. It uses no cookies, no third-party analytics and no new service.

## What is stored

- **Loop events** (`POST /api/play/events`): an event name from a fixed list (impression, first input, win, lose, restart, next game, share, shared-link open, bounce), the game id and a random id for the browser tab. The server rejects any body with other fields, so sentence text, names and addresses cannot ride along.
- **Visitor id** (for returning players): a random UUID the browser creates with `crypto.randomUUID()` and keeps in `localStorage`. It is derived from nothing about the player. If storage is blocked or full, no id is sent and nothing is counted.
- For each visitor id the store keeps only the day of the first visit, for 90 days. Daily counters (new players, returning players, D1, D7) live 31 days.

## What is not stored

- No IP address, user agent, location or sentence text next to the visitor id. The visitor id is left out of the event log.
- No cross-site tracking, no fingerprinting, nothing shared with other services.
- Players a game's robot or the "Show me how" demo simulates are never counted.

## How it is counted

- A visitor counts once per day (UTC): on the first day as new, on any later day as returning.
- D1 and D7: of the visitors new on a day, the share that came back exactly 1 or 7 days later. Only days whose day 1 or day 7 is over are included.
- After 90 days without the first-visit record a visitor counts as new again.

Clearing site data in the browser resets the visitor id.
