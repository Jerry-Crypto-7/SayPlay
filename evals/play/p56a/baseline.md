# P56A – výchozí čísla (T1, 21. 10. 2026)

**Co to znamená:** na rychlé cestě bez čtečky hra z věty skoro nikdy neukáže, kdo v ní hraje. Na větách nezávislého autora P55 trefí žánr jen 20 z 60, v 32 z 80 her hraje liška, kterou věta nejmenuje, a 68 z 80 názvů je šablona „<Postava> Run|Quest|…“. Větu do hratelné hry v prohlížeči dostane v mediánu za 2,0 s.

Měřeno na tipu P55 `72665fdc` skriptem `baseline.measure.ts` (`P56A_OUT=baseline`, cesta jako produkce s `reading: null`, semínko 1) a `latency.mjs`; řádek po řádku v `baseline.json` (celé pořadí `classifyGenre`, hrdina a protivník s modelem a úrovní volby, sada vzhledu, název, cílový řádek).

## Žánr z věty

| Sada | Cíle hrají svůj žánr | Pasti / rušivé zůstanou mimo nové žánry |
|---|---|---|
| p55 holdout-opened (80: 60 cílů, 20 rušivých) | **20/60** | 18/20 |
| p54c dev (80: 64 cílů, 16 pastí) | 64/64 | 16/16 |
| p54c holdout-opened (80: 60 cílů, 20 rušivých) | 59/60 | 20/20 |
| p30 dev (60, bez očekávaného žánru) | – (pořadí v `baseline.json` je zlatý vzor T5) | – |
| audit-12 (ruční štítky) | 7/12 | – |

Shoduje se s `evals/play/p55/final.md` (zapečetěná sada P55 20/60); p54c sady jsou od P55 dev a slovník se na nich doladil.

## Obsazení, svět a název

| Sada | Liška hrdinou bez slova „fox“ | Hrdina bez modelu (`fallback`) | Název je šablona | Různých názvů | Sada `meadow` |
|---|---|---|---|---|---|
| p55 holdout-opened (80) | **32** | 6 | **68** | 55 | 39 |
| p54c dev (80) | 33 | 0 | 58 | 59 | 46 |
| p54c holdout-opened (80) | 33 | 3 | 56 | 56 | 45 |
| p30 dev (60) | 4 | 2 | 43 | 57 | 16 |
| p43 panel (30) | 2 | 2 | 19 | 30 | 11 |
| audit-12 (12) | 3 | 1 | 12 | 12 | 5 |

p43 panel, sloty kontrolního seznamu: hrdina v popisku hrdiny **22/23 (0,957)**, role v popisku hrdiny nebo obsazení **22/30 (0,733)**.

## 12 vět auditu

| # | Věta (štítek žánru) | Hra | Název | Hrdina → model | Protivník → model | Sada | Cílový řádek |
|---|---|---|---|---|---|---|---|
| a01 | frog catching flies (catch) | voyage.race | frog drive | frog → race-car (fallback) | fly → housefly | meadow | Catch the fly. Reach the finish line. |
| a02 | zombies attack my farm (defense) | arena.fight | Zombie Duel | zombie → q-zombie | **bee** → bee | graveyard | Knock out 5 waves of bees. |
| a03 | ninja slicing fruit (slice) | slice | Ninja Slice | ninja → rogue-hooded | – | meadow | Slice 30 fruits. Not the bombs! |
| a04 | racing a shark (voyage.race) | voyage.race | submarine race | submarine | shark → shark | underwater | Beat the rival vehicles to the finish. |
| a05 | stack pizzas to the moon (timing.stack) | timing.stack | Moon Stack | **moon** → moon-rock | – | space | Stack 36 pizzas. Each one swings faster. |
| a06 | my cat defends the couch (defense) | defense | Cat Defense | cat → pet-cat | vacuum robot → roomba | **castle** | Hold the couch! Stop every vacuum robot. |
| a07 | goalkeeper saves penalty kicks (catch) | throw | goalkeeper score | goalkeeper | goalkeeper | meadow | Score in every goal. |
| a08 | match three gems (merge) | quest.spatial | Fox Quest | **fox** | shadow → blocky-robot (fallback) | meadow | Use all 5 chests, 3 rounds. |
| a09 | astronaut dodges asteroids (runner) | runner | Astronaut Run | astronaut | asteroid | space | Reach the station. Jump, slide and switch lanes. |
| a10 | chef flips pancakes (quest.station) | quest.station | Chef Quest | chef → q-chef | **cat** → pet-cat | supermarket | Cook all 2 pancakes, 10 rounds. |
| a11 | drum to the beat (rhythm) | rhythm | Fox Beat | **fox** | – | meadow | Tap each lane as its note hits the line. |
| a12 | escape a haunted mansion (arena.escape) | runner | Fox Run | **fox** | ghost → graveyard-ghost | graveyard | Escape the mansion. Reach the finish line. … |

Inference: mince a auto, které viděl audit u žáby a kočky, jsou vykreslení (P56B) – spec nese žábu i kočku s modelem; tady je vidět, že u a01 žába dostane model auta, protože závod chce vozidlo.

## Latence rychlé cesty (čtečka vypnutá, `PLAY_READER=`)

30 vět (audit-12 + prvních 18 z p30 dev), `npm run build` + `next start` na `127.0.0.1:3112`, každý průchod na čerstvě spuštěném serveru (studená věta: první publikace s ověřením robotem).

| Měření | p50 | p95 | max |
|---|---|---|---|
| server: `POST /api/play/games` (Node, wall-clock) | **590 ms** | 3 158 ms | 3 847 ms |
| prohlížeč: odeslání → `window.__playShell` na `/play/<id>` | **1 974 ms** | 7 113 ms | 10 985 ms |

Žádná `pageerror`. Nejpomalejší jsou běžci a přeskákání (a12 3,8 s na serveru, s003, s008), kde robot ověřuje dlouhou trať. Server `draftReadyMs` ven nedává (zapíše ho jen upgrade režiséra), proto se měří wall-clock POST.

Inference: dřívější běh téhož skriptu (prohlížeč za POST na témž serveru) dal na serveru p50 1 393 ms – dva běhy na vytíženém stroji se liší víc než 2×, takže srovnání latence (T13) jde jen prokládaně A,B,A,B, ne proti tomuhle číslu.
