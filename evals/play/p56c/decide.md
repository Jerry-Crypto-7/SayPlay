# P56C T8 – řetěz, nebo jedna hra (dev)

Změřeno 2026-10-26 `decide.measure.ts`, čtení slovníkem, `classifyGenre(věta, null)`. Od P61 T4 je větev `generic` jen neslyšená věta (první buňka 0 bodů, nebo čtení bez hratelného slovesa); práh náskoku obecné buňky (`GENERIC_MARGIN` = 3, P56C T8) zmizel – slyšená obecná buňka hraje jednu hru („a goth teenage ghost with a skateboard“, `runner.default` 2). Slyšená obecná buňka s počítaným cílem („collect three keys … while dodging ghosts“) hraje jednu hru i se dvěma slovesy.

| Rodina | AC | Výsledek |
|---|---|---|
| `multi_verb` → řetěz | ≥ 10/12 | 11/12 |
| `no_verb` + `world_only` → řetěz | ≥ 15/18 | 17/18 |
| `single_verb` → jedna hra | ≥ 8/10 | 10/10 |

| id | rodina | rozhodnutí | větve | první buňka |
|---|---|---|---|---|
| d01 | multi_verb | řetěz | multi_verb | throw.default 5 (náskok 2) |
| d02 | multi_verb | řetěz | multi_verb | platformer.default 6 (náskok 3) |
| d03 | multi_verb | jedna hra | – | quest.station 4 (náskok 4) |
| d04 | multi_verb | řetěz | multi_verb | platformer.default 5 (náskok 3) |
| d05 | multi_verb | řetěz | cue | catch.default 4 (náskok 2) |
| d06 | multi_verb | řetěz | multi_verb | voyage.race 6 (náskok 5) |
| d07 | multi_verb | řetěz | multi_verb | voyage.race 4 (náskok 2) |
| d08 | multi_verb | řetěz | multi_verb | platformer.default 6 (náskok 4) |
| d09 | multi_verb | řetěz | multi_verb, cue | quest.spatial 4 (náskok 2) |
| d10 | multi_verb | řetěz | multi_verb | voyage.race 6 (náskok 4) |
| d11 | multi_verb | řetěz | multi_verb | throw.default 5 (náskok 3) |
| d12 | multi_verb | řetěz | multi_verb | throw.default 5 (náskok 4) |
| d13 | single_verb | jedna hra | – | quest.spatial 4 (náskok 4) |
| d14 | single_verb | jedna hra | – | rhythm.default 3 (náskok 3) |
| d15 | single_verb | jedna hra | – | slice.default 4 (náskok 2) |
| d16 | single_verb | jedna hra | – | whack.default 4 (náskok 3) |
| d17 | single_verb | jedna hra | – | throw.default 8 (náskok 7) |
| d18 | single_verb | jedna hra | – | voyage.race 4 (náskok 4) |
| d19 | single_verb | jedna hra | – | arena.collect 5 (náskok 4) |
| d20 | single_verb | jedna hra | – | quest.spatial 4 (náskok 4) |
| d21 | single_verb | jedna hra | – | arena.collect 4 (náskok 4) |
| d22 | single_verb | jedna hra | – | platformer.default 4 (náskok 4) |
| d23 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d24 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d25 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d26 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d27 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d28 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d29 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d30 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d31 | no_verb | jedna hra | – | runner.default 2 (náskok 2) |
| d32 | no_verb | řetěz | generic | arena.collect 0 (náskok 0) |
| d33 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d34 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d35 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d36 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d37 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d38 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d39 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |
| d40 | world_only | řetěz | generic | arena.collect 0 (náskok 0) |

## Se čtením modelem (T17b)

150 vět, které P56A přečetl modelem gpt-oss-20b (audit-12, p30-dev, p54c-dev; uložená čtení v `evals/play/p56a/readings`). „slovník“ = tytéž věty bez čtení.

| sada | řetěz se čtením | řetěz slovníkem | `generic` se čtením | `generic` slovníkem | `multi_verb` se čtením | `multi_verb` slovníkem |
|---|---|---|---|---|---|---|
| audit-12 | 0/12 | 2/12 | 0/12 | 0/12 | 0/12 | 2/12 |
| p30-dev | 15/59 | 18/59 | 9/59 | 7/59 | 5/59 | 10/59 |
| p54c-dev | 11/79 | 17/79 | 0/79 | 1/79 | 11/79 | 16/79 |
| vše | 26/150 | 37/150 | 9/150 | 8/150 | 16/150 | 28/150 |

**Rozhodnutí (T17b, 2026-10-22; práh zrušil P61 T4): práh `GENERIC_MARGIN` = 3 zůstává i pro čtení.** Větev `generic` není u čtení vzácnější kvůli prahu – kde čtení přistane na obecné buňce, má náskok ≥ 7 jen u vět s jasným slovesem čtení (běžec „hedgehog rolls … avoiding foxes“); práh 7 (= 3 + bonus čtení 4) by přepnul jen a09 a x13, obě slovník už řetězem posílá. Rozdíl „řetěz se čtením / slovníkem“ dělá `multi_verb`: model u „chef catches eggs … while avoiding bombs“, „squash the bugs“, „tower defense against robots“ slyší jedno hlavní sloveso s vlastním žánrem – podle pravidla správně jedna hra; slovník z „avoid“ dělá druhé sloveso. Skutečná díra byla jinde: bonus čtení dělá z každé věty „slyšenou“, takže věta bez hratelného slovesa („purple elephants doing taxes“, „grandpa fixing his old car“ – sloveso `idle`, žánr `quest`) šla do jedné hry. Oprava v `decide.ts`: se čtením je věta neslyšená, když čtení nemá hratelné sloveso a první buňka není mikrohra řetězu – „wizard defends his tower“ (`idle`, ale `defense.default`) zůstane jednou hrou. Slovníková cesta se nemění.

Věty, kde čtení rozhodne jinak než slovník (35):

| id | věta | se čtením | slovníkem | žánr čtení | slovesa čtení | první buňka se čtením |
|---|---|---|---|---|---|---|
| audit-12/a07 | a goalkeeper saves penalty kicks in a packed stadium | jedna hra | multi_verb | defense.default | timing | defense.default 4 (náskok 0) |
| audit-12/a09 | an astronaut dodges asteroids to reach the space station | jedna hra | multi_verb | arena.escape | melee | arena.escape 5 (náskok 3) |
| p30-dev/s022 | A tiny robot climbs a tower of moving platforms to reach its charger | jedna hra | multi_verb | platformer.default | platform | platformer.default 13 (náskok 12) |
| p30-dev/s021 | obby game with lava and spinning bars | multi_verb | jedna hra | platformer.default | platform timing | platformer.default 8 (náskok 7) |
| p30-dev/s056 | A pizza delivery scooter races through traffic to deliver before the pizza gets cold | jedna hra | multi_verb | runner.default | runner | runner.default 6 (náskok 2) |
| p30-dev/h01 | a cat stealing fish from a market while dodging the fishmonger | jedna hra | multi_verb | arena.escape | move_free move_free | arena.escape 12 (náskok 11) |
| p30-dev/h03 | defend a castle from dragons by throwing snowballs | jedna hra | multi_verb | throw.default | throw | throw.default 8 (náskok 4) |
| p30-dev/h06 | I want a game where a tiny astronaut repairs a broken spaceship by collecting glowing crys | jedna hra | multi_verb | arena.escape | move_free move_free move_free move_free | arena.escape 12 (náskok 7) |
| p30-dev/j09 | a dragon burns down villages and dodges arrows from knights | multi_verb | jedna hra | arena.escape | move_free timing | arena.escape 7 (náskok 6) |
| p30-dev/d07 | my grandpa fixing his old car in the garage | generic | jedna hra | quest.spatial | idle | quest.spatial 5 (náskok 0) |
| p30-dev/d08 | a mermaid collects pearls while avoiding jellyfish | jedna hra | multi_verb | arena.collect | move_free | arena.collect 5 (náskok -3) |
| p30-dev/d09 | stack cheese wheels into a wobbly tower at a farm market | multi_verb | jedna hra | merge.default | manipulate build_place | merge.default 4 (náskok -2) |
| p30-dev/d12 | a goldfish swims through a sunken city dodging sharks | jedna hra | multi_verb | arena.escape | move_free | arena.escape 5 (náskok -1) |
| p30-dev/d13 | write a thank-you letter to my teacher | generic | jedna hra | – | – | arena.collect 4 (náskok 0) |
| p30-dev/d20 | a knight rides a unicorn to rescue a prince from a cloud castle | jedna hra | multi_verb | quest.spatial | steer | quest.spatial 9 (náskok 5) |
| p54c-dev/c05 | a chef catches eggs dropping into the kitchen while avoiding bombs | jedna hra | multi_verb | catch.default | timing | catch.default 8 (náskok 5) |
| p54c-dev/c06 | move the mine cart to catch gold nuggets falling from the ceiling | multi_verb | jedna hra | catch.default | move_free timing | catch.default 8 (náskok 4) |
| p54c-dev/c08 | a kid on a skateboard catches presents dropping from santa's sleigh | jedna hra | multi_verb | catch.default | timing | catch.default 8 (náskok 6) |
| p54c-dev/w05 | squash the bugs that pop up from the kitchen drains | jedna hra | multi_verb | whack.default | timing | whack.default 8 (náskok 6) |
| p54c-dev/f02 | tower defense against robots attacking the city wall | jedna hra | multi_verb | defense.default | timing | defense.default 10 (náskok 7) |
| p54c-dev/s02 | a ninja slices fruit tossed in the air but avoids the bombs | multi_verb | jedna hra | slice.default | timing move_free | slice.default 8 (náskok 6) |
| p54c-dev/o02 | crossy road with a frog hopping over traffic and river logs | jedna hra | multi_verb | runner.default | timing | runner.default 4 (náskok -2) |
| p54c-dev/o05 | frogger in a neon city with flying cars | jedna hra | multi_verb | platformer.default | – | platformer.default 4 (náskok -2) |
| p54c-dev/r02 | a crowd of stickmen runs through plus and times gates to beat the giant | jedna hra | multi_verb | crowd.default | runner | crowd.default 8 (náskok 4) |
| p54c-dev/r06 | a swarm of bees grows through flower gates and attacks the bear | multi_verb | jedna hra | crowd.default | move_free melee | crowd.default 8 (náskok 6) |
| p54c-dev/r07 | pick the right gates to make your zombie horde bigger and break the wall | multi_verb | jedna hra | crowd.default | tap_go manipulate timing | crowd.default 8 (náskok 7) |
| p54c-dev/r08 | run with a growing crowd of kids through gates to beat the teacher | jedna hra | multi_verb | crowd.default | runner | crowd.default 8 (náskok 4) |
| p54c-dev/m06 | drop candies in a jar and merge matching candies | multi_verb | jedna hra | merge.default | tap_go move_free | merge.default 8 (náskok 7) |
| p54c-dev/m07 | drop gems into the bowl and fuse matching gems into crowns | multi_verb | jedna hra | merge.default | tap_go manipulate | merge.default 8 (náskok 6) |
| p54c-dev/x03 | chop wood and build a cabin in the forest | multi_verb | jedna hra | – | timing build_place | arena.collect 4 (náskok 0) |
| p54c-dev/x04 | a frog hops between lily pads to reach the island | jedna hra | multi_verb | platformer.default | platform | platformer.default 11 (náskok 11) |
| p54c-dev/x06 | push crates onto switches to open the door | jedna hra | generic | push.default | move_free | push.default 4 (náskok 2) |
| p54c-dev/x07 | throw a ball for the dog to catch | jedna hra | multi_verb | throw.default | throw | throw.default 11 (náskok 10) |
| p54c-dev/x10 | a cat catches mice running around the barn | jedna hra | multi_verb | quest.spatial | move_free | quest.spatial 4 (náskok -4) |
| p54c-dev/x13 | a rabbit hops over fences on a long meadow run | jedna hra | multi_verb | runner.default | runner | runner.default 8 (náskok 3) |

