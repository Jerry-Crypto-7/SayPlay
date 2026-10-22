# P56C T14 – zapečetěná sada: řetěz proti jedné hře

Sada `holdout.json` (40 vět nezávislého autora, SHA `f8197a6c…`) otevřena jednou 2026-10-21 na `979d49bf` (`holdout.measure.ts`); slepý soud `judge.mjs` na `979d49bf`. Nic se podle ní neladilo a dál je to jen dev sada.

## Výsledek

| Brána | Cíl | Výsledek | |
|---|---|---|---|
| slepý soud: řetěz vyhraje z rozhodnutých párů | ≥ 0.7 | 27/27 = 1 | splněno |
| ≥ 3 ovládání v řetězu | ≥ 80 % řetězů | 27/27 (100 %) | splněno |
| `verifyChain` bez chyby | 100 % | 27/27 | splněno |
| délka 30–90 s | 100 % | 27/27 | splněno |

Soud: 27 párů, řetěz 27, jedna hra 0, remíza 0; řetěz ze všech párů 1 (remíza jako nevýhra). Levý sloupec vyhrál 0.444 rozhodnutých párů (poziční zkreslení soudce).

## Podíl vět poslaných do řetězu (`chainOrSingle`)

| Rodina | řetěz |
|---|---|
| `multi_verb` | 7/12 |
| `single_verb` | 2/10 |
| `no_verb` | 10/10 |
| `world_only` | 8/8 |
| `all` | 27/40 |

## Co z toho plyne

**Fakta:**

- Všech 27 zdůvodnění soudce stojí na pestrosti („more varied activities“) a strana jedné hry je u 25 z 27 vět obecná buňka (`arena.collect` 17, `runner.default` 4, `arena.escape` 2, `voyage.race` 2) – přesně díra, na kterou řetěz míří.
- `multi_verb` šlo do řetězu 7/12 (dev 11/12): h01, h04, h07, h09 a h11 zůstaly jedné hře, protože pahýl čtení (slovník, `readForChain`) u nich nenašel dvě slovesa s různým ovládáním. `single_verb` šlo do řetězu 2/10 (h20, h21 – klasifikátor nenašel žádnou buňku, skóre 0).
- Soudce u řetězů popisuje silnice s auty a řeky (`hop`), číselné brány (`crowd`) a dráhy s míčky (`timing`, `rhythm`) – h02: „from a forest run to traffic-and-river crossing“.

**Odvozeno (neověřeno dalším měřením):**

- Otázka spojuje „radši bych hrál dál“ s „víc různých her“ a druhá půlka řetězu nahrává už svou stavbou. 27/27 tedy říká hlavně, že řetěz čte jako několik různých her a ne jako zmatek; neříká, že je každé kolo zábavnější než jedna hra – hloubku kol osm statických snímků neukáže. To zůstává na HALT se skutečným telefonem.
- Kola `hop` a `crowd` kreslí vlastní kulisy (silnice, řeka, brány), takže „stejný svět“ drží `theme.look` a hrdina, ne celá scéna. Kandidát na další práci, ne laděno podle této sady.
- Pět víceslovesných vět mimo řetěz je práce pro čtení modelem (T17, P56A), ne pro práh `GENERIC_MARGIN`.

## Páry

| id | rodina | větve | kola řetězu | jedna hra | vlevo | vítěz | proč (soudce) |
|---|---|---|---|---|---|---|---|
| h02 | multi_verb | multi_verb | runner.default → hop.default → whack.default → timing.stack → shooter.default.boss | runner.default | chain | chain | Game A looks more engaging and varied, moving from a forest run to traffic-and-river crossing, a mallet-and-holes game, platforms, and target shooting. Game B mostly stays on the same forest road, adding hoops, barriers, coins, and robot enemies. |
| h03 | multi_verb | multi_verb | catch.default → platformer.default → timing.stack → shooter.default → duel.default.boss | arena.collect | chain | chain | Game A shows more varied activities: catching floating balls, crossing raised platforms, exploring among domes, and interacting with a launcher. Game B mostly stays in one overhead arena with pickups and enemies, so A looks more varied and more appealing to keep playing. |
| h05 | multi_verb | multi_verb | catch.default → platformer.default → runner.default → crowd.default → duel.default.boss | voyage.race | single | chain | Game B shows more varied play: jumping between rock platforms, running through a canyon, choosing numbered gates, and interacting with a large swinging obstacle. Game A mostly repeats the same hazy construction course with orange hoops, so B looks more engaging to keep playing and shows more different games. |
| h06 | multi_verb | multi_verb, cue | runner.default → crowd.default → whack.default → timing.stack → duel.default.boss | runner.default | chain | chain | Game A shows more varied play: a canyon run, number gates, a five-hole target challenge, and a platform encounter with a spider and swinging objects. Game B mainly repeats the same canyon track with hurdles, rings, spiders, and other runners, so A looks more appealing to keep playing. |
| h08 | multi_verb | generic | runner.default → crowd.default → platformer.default → rhythm.default → defense.default.boss | runner.default | single | chain | Game B looks more engaging and varied, switching from a forest runner to arithmetic gates, platform jumps, colored lanes, and a button-lined obstacle. Game A stays on the same forest road with changing blocks, coins, and small robot obstacles. |
| h10 | multi_verb | multi_verb | platformer.default → flap.default → timing.precision → rhythm.default → defense.default.boss | platformer.default | chain | chain | Game A shows more varied activities: island jumping, green obstacle gates, a multicolored lane course, and a tabletop game with balls and paddles. Game B mostly repeats jumps across tropical islands, so A looks more varied and more appealing to keep playing. |
| h12 | multi_verb | multi_verb | whack.default → timing.stack → crowd.default → duel.default → shooter.default.boss | quest.station | chain | chain | Game A shows more varied activities: a mallet over holes, an obstacle scene, number gates, a close-range encounter, and aiming across an open area. Game B stays at the same counter with changing pans and targets, so A looks more varied and more appealing to keep playing. |
| h20 | single_verb | generic | crowd.default → flap.default → catch.default → rhythm.default → shooter.default.boss | arena.collect | chain | chain | Game A shows varied activities: numbered gates, obstacle sections, falling bombs, colored lanes, and aiming at targets, making it more appealing to keep playing. Game B mostly stays in the same grassy arena with rocks, collectibles, and an enemy encounter, showing less variety. |
| h21 | single_verb | generic | catch.default → platformer.default → runner.default → crowd.default → shooter.default.boss | arena.collect | single | chain | Game B looks more inviting to keep playing and shows more variety: floating-platform jumps, a forest road, numbered gates, and aiming at distant targets. Game A stays in a similar grassy arena, with coins, rocks, and robot enemies. |
| h23 | no_verb | generic | catch.default → flap.default → hop.default → runner.default → duel.default.boss | arena.collect | single | chain | Game B shows varied challenges with overhead green obstacles, roads with cars, rivers with logs, a boardwalk run, and a robot encounter, making it more appealing to keep playing. Game A stays in the same sandy arena with scattered blocks and a larger enemy appearing near the end. |
| h24 | no_verb | generic | hop.default → shooter.default → platformer.default → runner.default → duel.default.boss | arena.escape | single | chain | Game B shows traffic and train crossings, rooftop platforming, street obstacles, and close-up combat, offering more variety that I'd want to keep exploring. Game A stays in the same grassy arena, mostly moving around rocks, collecting glowing items, and fighting enemies. |
| h25 | no_verb | generic | timing.precision → whack.default → platformer.default → flap.default → shooter.default.boss | arena.escape | single | chain | Game B shows more variety: a fox with a mallet over holes, jumping between cliff platforms, hanging targets, and aiming across a field. Game A stays in the same overhead grassy arena chasing or fighting enemies, so B looks more appealing to keep playing. |
| h26 | no_verb | generic | hop.default → platformer.default → duel.default → shooter.default → defense.default.boss | arena.collect | chain | chain | Game A looks more engaging and shows more variety: traffic dodging, rooftop jumping, street combat with a giant enemy, and a lane-based challenge. Game B stays in the same dark grassy arena with scattered pickups and a few enemies. |
| h27 | no_verb | generic | rhythm.default → hop.default → timing.precision → flap.default → defense.default.boss | arena.collect | chain | chain | Game A looks more appealing to keep playing and shows more variety: city obstacle lanes, traffic and river crossings, green barriers, and a bowling-like lane setup. Game B stays in the same grassy arena, with collectibles, rocks, and enemies appearing later. |
| h28 | no_verb | generic | duel.default → rhythm.default → crowd.default → platformer.default → defense.default.boss | arena.collect | single | chain | Game B looks more engaging and varied, showing a punching target, rooftop platforming, numbered gates, and a lane-and-ball challenge. Game A mostly repeats the same grassy arena with scattered yellow pickups and occasional enemies. |
| h29 | no_verb | generic | catch.default → platformer.default → hop.default → runner.default → duel.default.boss | arena.collect | single | chain | Game B looks more engaging and varied, showing platform jumps, traffic dodging, a path run, and close-up encounters with large obstacles. Game A stays in a similar grassy arena throughout, with scattered pickups, blocks, and occasional enemies. |
| h30 | no_verb | generic | duel.default → hop.default → flap.default → platformer.default → defense.default.boss | arena.collect | single | chain | Game B looks more engaging and shows more different games: a two-character timing challenge, traffic dodging, rooftop platforming, and a lane-based ball game. Game A stays in the same green arena, with scattered coins, rocks, and occasional enemies. |
| h31 | no_verb | generic | runner.default → defense.default → crowd.default → rhythm.default → shooter.default.boss | arena.collect | chain | chain | Game A looks more engaging and varied, moving from a forest coin run to a button platform, numbered gates, obstacle lanes, and aiming at distant targets. Game B shows mostly the same grassy arena throughout, with coins and increasing numbers of enemies. |
| h32 | no_verb | generic | defense.default → platformer.default → duel.default → flap.default → shooter.default.boss | arena.collect | single | chain | Game B looks more engaging and varied, showing a lane board, separated platforms, a training dummy with a changing health bar, green obstacles, and aimed shooting. Game A mostly stays in the same grassy arena, with movement and combat against pink enemies. |
| h33 | world_only | multi_verb, generic | runner.default → crowd.default → flap.default → whack.default → shooter.default.boss | voyage.race | single | chain | Game B looks more engaging and varied, showing a canyon runner, ×2/+2 gates, green obstacles, a hammer over holes, and aiming/shooting scenes. Game A stays on a similar red-railed running track with scattered pickups throughout. |
| h34 | world_only | generic | platformer.default → hop.default → runner.default → flap.default → shooter.default.boss | arena.collect | chain | chain | Game A shows platform jumping, traffic dodging, a jungle run, pipe obstacles, and aiming scenes, offering more variety and reasons to keep playing. Game B stays in a similar green arena throughout, with scattered pickups and an enemy encounter. |
| h35 | world_only | generic | runner.default → platformer.default → defense.default → crowd.default → shooter.default.boss | arena.collect | chain | chain | Game A shows varied activities: a canyon obstacle course, jumping across lava pillars, a green lane challenge, numbered gates, and laser aiming. Game B mostly repeats the same dark arena with scattered coins, blocks, and robots, so A looks more varied and more appealing to keep playing. |
| h36 | world_only | generic | shooter.default → timing.precision → hop.default → platformer.default → defense.default.boss | arena.collect | single | chain | Game B shows varied scenes: a moonlike landscape, traffic and river crossings, pillar jumping, and a lane-based ball game. Game A stays in the same rocky arena with scattered glowing pickups and robot enemies, so B looks more varied and more appealing to keep playing. |
| h37 | world_only | generic | whack.default → timing.stack → rhythm.default → crowd.default → shooter.default.boss | arena.collect | single | chain | Game B looks more engaging and shows more varied games: holes with a hammer, stacked spinning obstacles, colored lanes, number gates, and aiming and shooting. Game A stays in the same brick courtyard with scattered blocks and a few changing characters or effects. |
| h38 | world_only | generic | platformer.default → flap.default → timing.precision → runner.default → defense.default.boss | arena.collect | single | chain | Game B shows varied challenges with stepping platforms, hanging obstacles, a road, and a green lane board with red bumpers. Game A stays in a similar rocky arena with scattered glowing pickups and blocks, so B looks more varied and more appealing to keep playing. |
| h39 | world_only | generic | hop.default → catch.default → platformer.default → crowd.default → shooter.default.boss | arena.collect | chain | chain | Game A shows traffic dodging, platform jumping, a gate-choice runner, and target aiming, giving me more varied activities to keep playing. Game B stays in the same grassy arena, with coins and robot enemies appearing as the fox moves around. |
| h40 | world_only | generic | hop.default → catch.default → runner.default → crowd.default → shooter.default.boss | arena.collect | single | chain | Game B looks more engaging and varied, showing traffic crossing, platform jumping, a wooded running path, numbered gates, and target aiming. Game A stays in the same dark arena with glowing pickups, crates, and enemies. |

## Jak se měřilo

- Obě strany z téhož buildu a serveru (`next start`). Řetěz = `POST {sentence}` (rozhodne server). Jedna hra = `chainOrSingle` přebité na `single`: `draftGameSpecWithMeta(věta, 1)` jako v route, publikované `POST {spec}` – semínko světa se tak bere z hashe specu místo věty.
- Klip: 8 snímků jen plátna na stranu, hraje robot publikace. Jedna hra rovnoměrně přes celý běh robota, řetěz přes všechna kola úměrně délce kola, aspoň jeden snímek na kolo. Karty se slovesem a HUD jsou skryté.
- Soudce Codex přes `ask` (`scripts/p37d/judge-sheet.mjs`): prázdný `mkdtemp` jen se `sheet.png`, strana vlevo losem `pure-rand` xoroshiro128plus(56014). Otázka: „The attached image shows two small 3D video games side by side, each played by the same robot player. Game A is the left column, game B the right column. Rows go down in time: eight frames spread evenly from the start to the end of each game's play. Page text is hidden, so judge only what the 3D scenes show. Which one would you rather keep playing, and which shows more different games? Pick the game that wins on both together; answer "tie" only when neither is better. Reply only with the JSON the schema asks for: winner = "A", "B" or "tie"; why = one or two sentences naming what you see in each game.“

