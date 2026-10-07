# P41 human acceptance — pending

No human acceptance has been performed. Automated replay, witnesses and emulated
phone performance do not establish that the game feels good on a real phone.

The frozen held-out result does **not** meet the P41 acceptance targets:
30/64 sentences preserve all actions on all five seeds (target >=80%);
105 silent missing triples affect 17 sentences; environment matches 65.38%
(target >=90%). Hero matching is 93.02%, build/replay success 100%, quick p95
1.109 seconds. The verified baseline preserves 10/64 sentences. These findings
must remain visible during the owner's assessment; green unit tests do not
establish successful sentence preservation. See `final.json` and `final.md`.

Known details to inspect during acceptance: the landing target is static even
when a sentence says “moving ship”; named glide hazards currently use the course
frames, so arrows, sharks and mines do not yet have distinct motion or explosion
behavior. Delivery currently completes one pickup and one destination. Record
whether those limits make the generated game fail to express the owner's sentence.
The historical regression corpus also exposes a requested 90-second survival
game capped at 80 seconds. Action-triple scores alone do not certify every count,
duration, ordering, scale or fragility clause; check those details while playing.

Use the verified production build corresponding to the measurement revision in `final.md`.
Record its build ID and URL below. Play each sentence
on desktop and on a physical phone. Record the actual generated game/version and
whether every essential action from the sentence was recognizable while playing.
The five owner sentences must be supplied by the owner, without developer coaching.

| Sentence | Device | Game/version | Recognized (yes/no) | Fun (1–5) | Missing action or problem |
| --- | --- | --- | --- | --- | --- |
| game in a car with shooting and racing | Desktop | Pending | Pending | Pending | |
| game in a car with shooting and racing | Phone | Pending | Pending | Pending | |
| Swim underwater and collect pearls while escaping a shark | Desktop | Pending | Pending | Pending | |
| Swim underwater and collect pearls while escaping a shark | Phone | Pending | Pending | Pending | |
| A mouse collects cheese in a maze while avoiding a guard | Desktop | Pending | Pending | Pending | |
| A mouse collects cheese in a maze while avoiding a guard | Phone | Pending | Pending | Pending | |
| Play football and score goals past a goalkeeper | Desktop | Pending | Pending | Pending | |
| Play football and score goals past a goalkeeper | Phone | Pending | Pending | Pending | |
| Owner sentence 1 — not yet supplied | Desktop | Pending | Pending | Pending | |
| Owner sentence 1 — not yet supplied | Phone | Pending | Pending | Pending | |
| Owner sentence 2 — not yet supplied | Desktop | Pending | Pending | Pending | |
| Owner sentence 2 — not yet supplied | Phone | Pending | Pending | Pending | |
| Owner sentence 3 — not yet supplied | Desktop | Pending | Pending | Pending | |
| Owner sentence 3 — not yet supplied | Phone | Pending | Pending | Pending | |
| Owner sentence 4 — not yet supplied | Desktop | Pending | Pending | Pending | |
| Owner sentence 4 — not yet supplied | Phone | Pending | Pending | Pending | |
| Owner sentence 5 — not yet supplied | Desktop | Pending | Pending | Pending | |
| Owner sentence 5 — not yet supplied | Phone | Pending | Pending | Pending | |

Verified production source: `f17a4a9c`.
Build ID: `3689fcf0b36e82ee1135c2c714f879bc1e4ddc80` (Git tree).
Build evidence: `.claude/scratchpads/p41-acceptance-build.log` — PASS.
Measurement revision: `1b450542` (the additional change only repairs the offline
baseline helper and its tests; application source remains `f17a4a9c`).
Desktop: <http://127.0.0.1:3141/play> — HTTP 200 verified.
Phone on the same local network: <http://10.1.100.45:3141/play> — physical-phone
connectivity and play remain unverified. No firewall rules were changed.
Preview uses a separate local `p41-acceptance-store`; model branches are off.

Owner: pending. Date: pending. Phone/browser: pending. Desktop/browser: pending.
Decision and unresolved findings: pending.

The separate blind quick-versus-director preference study is recorded by the T32
measurement protocol. Its missing ratings must not be replaced by these rows or
by automated win rates.
