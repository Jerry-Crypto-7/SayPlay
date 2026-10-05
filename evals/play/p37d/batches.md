# P37D T4 – dávky modelů do knihovny PLAY

Rozhodnutí z T2 (`pilot.md`): všech 201 zbylých jmen z `missing.json` (pořadí 21–221), 4 dávky po ≤ 110 min GPU.
Každá dávka: výroba `ops/gen3d/batch.py` (semínka 1, 2, 3; `gpu-lock`) → `quality_gate` → slepý soudce
`scripts/p37d/judge-sheet.mjs` se synonymy `aliases.json` (astra přes předplatné, vývojové měření, nikdy trénovací
data) → prohlédnutí přehledového listu (smí jen vyřadit, ne přijmout) → `scripts/p37d/promote-batch.mjs` →
license-gate. Soubory výroby a listy leží mimo repo v `D:/caches/p37d/b<N>/`.

## Souhrn

| Dávka | Jména | Vyrobeno (brána) | Soudce přijal | Do PLAY | Hrdinů | GPU |
|---|---|---|---|---|---|---|
| pilot (T2/T3) | 1–20 | 20/20 | 10 | 10 | 3 | 40 min |
| 1 | 21–75 | 54/55 | 33 (top1 24) | 31 | 6 | 101 min |
| 2 | 76–130 | 55/55 | 37 (top1 28), po prohlédnutí 33 | 33 | 1 | ~95 min |
| 3 | 131–185 | 55/55 | 31 (top1 25), po prohlédnutí 29 | 29 | 0 | 73 min |
| 4 | 186–221 | 36/36 | 26 (top1 23) | 26 | 0 | 47 min |
| **celkem** | | **220/221** | **131** | **129** | **10** | ~6 h |

**Výsledek T4:** z 221 chybějících jmen má knihovna nově 129 modelů (58 %); 92 jmen zůstává bez modelu
(seznamy „zahodil“ u dávek níž). Odhad z T2 byl ~145. Repo narostlo o 22 MB (`gen3d-p37d`), strop ~150 MB.

## Dávka 1 – pořadí 21–75 (4. 10. 2026)

- **Brána:** 54 z 55 prošlo; `wolf` neprošel ani na třetím semínku (potrhaná síť).
- **Soudce přijal 33** – police officer, sun, fireball, moose, peacock, goose, seagull, shrimp, minotaur, kraken,
  angel, gnome, cashier, athlete, police car, fisherman, fire truck, satellite, kayak, yacht, excavator, forklift,
  wheelchair, unicycle, roller skate, wagon, lemon, pear, peach, potato, onion, taco, burrito.
- **Soudce zahodil 21:**
  - nepoznal (18): pollen (tree), pin (sword), vegetable (flower), spellbook (bread slice), rhino (skull),
    cyclops (cabbage), centaur (horse), genie (warrior), golem (gorilla), caveman (man), spy (soldier),
    mailman (security guard), sailor (security guard), singer (man), captain (police officer), orange (tree stump),
    noodle (tree trunk), spaghetti (coiled rope);
  - poškozené (3): hippo, lizard, demon.
- **Prohlédnutí** nic nevyřadilo. Hraniční: peach (soudce: „apple“, peach druhý) a onion („pumpkin“, onion
  druhý) – rozhodne druhý soud v T5.
- **Povýšení vynechalo 2:** peacock a fire truck – LOD1 nejde zjednodušit při stejné velikosti (tenká pera,
  žebřík). Model z výroby má vlastní LOD1 z gltfpack; použít ho jako náhradu je otevřená možnost.
- **Do PLAY 31**, z toho hrdinové: police officer, goose, seagull, police car, kayak, yacht (manifest 254 → 260).
- **Velikost:** LOD0 max 113 KB (strop 141 KB), `public/assets/worldstream/gen3d-p37d` celkem 6,3 MB.
- **Co nejde:** role lidí v obyčejném oblečení (spy, mailman, sailor, singer, captain, caveman) – soudce je
  bez rekvizity nerozezná; mytická stvoření podobná zvířeti (centaur → horse, golem → gorilla).

## Dávka 2 – pořadí 76–130 (4. 10. 2026)

- **Brána:** 55 z 55. Výroba se zastavila s koncem session na 49 jménech (03:09) a stejný příkaz dojel zbytek.
- **Soudce přijal 37** (top1 28, top3 9). Na druhou volbu: chocolate („block“), suitcase („crate“), glove
  („hand“), mask („human head“), arcade machine („arcade cabinet“), hockey puck („cake“), seashell („hooded
  chair“), crystal ball („snowball“), reindeer („deer“).
- **Soudce zahodil 18:** nepoznal 17 – marshmallow (lollipop), pie (orange slice), milk (mayonnaise jar),
  tea (mug), juice (drink cup), cape (crystal), orb (ball), statue (surgeon), sign (tree), playing card
  (cheese block), golf ball (egg), snowboard (skateboard), swing (hurdle), coffin (trash bin), jack o lantern
  (pumpkin), broomstick (broom), sleigh (lounge chair); poškozený 1 – ornament.
- **Prohlédnutí vyřadilo 4 přijaté** (`D:/caches/p37d/b2/viewed.json`): scarf (vypadá jako džíny), suitcase
  (zmačkaný pytel), mask (hlava mimozemšťana), seashell (béžová hrouda).
- **Do PLAY 33**, hrdina jen gingerbread man (manifest 260 → 261). Povýšení nic nevynechalo.
- **Velikost:** LOD0 max 113 KB, `gen3d-p37d` celkem 12 MB.
- **Co nejde:** nápoje v obyčejné nádobě (milk, tea, juice – soudce vidí sklenici nebo hrnek), věci, které
  od příbuzné nejde odlišit bez měřítka (golf ball → egg, snowboard → skateboard, broomstick → broom).

## Dávka 3 – pořadí 131–185 (4. 10. 2026)

- **Brána:** 55 z 55.
- **Soudce přijal 31** (top1 25, top3 6: easter egg „avocado“, soap „sponge“, microwave „television“, smartwatch
  „wristwatch“, briefcase „suitcase“, ribbon „banner“).
- **Soudce zahodil 24:** nepoznal 23 – firework (pom-pom), pinecone (conifer tree), pinata (lantern), pebble
  (bottle), anthill (dog bowl), comet (seashell), coral (bear trap), vine (sapling), flower pot (potted plant),
  net (crystal), dynamite (bottle), torpedo (bottle), crossbow (rifle), boomerang (pickaxe), towel (block),
  blanket (safe), keyboard (light bar), printer (armchair), tablet (radio), joystick (dropper bottle),
  newspaper (ice cube), magazine (safe), earring (tabletop mirror); poškozený 1 – receipt.
- **Prohlédnutí vyřadilo 2 přijaté:** microwave a dishwasher – krabice jako zmačkaný alobal.
- **Do PLAY 29**, žádný hrdina (manifest zůstává 261).
- **Velikost:** LOD0 max 113 KB, `gen3d-p37d` celkem 17 MB.
- **Co nejde:** ploché věci a papír (towel, blanket, newspaper, magazine, receipt, keyboard, tablet) – výroba
  z nich dělá kvádr; zbraně a nástroje s tenkou částí (crossbow, boomerang, dynamite).

## Dávka 4 – pořadí 186–221 (4. 10. 2026)

- **Brána:** 36 z 36.
- **Soudce přijal 26** (top1 23, top3 3: space suit „astronaut“, energy drink „soda can“, dumpling „garlic bulb“).
- **Soudce zahodil 10**, všechny nepoznané: tape (washer), glue (barrel), canvas (recycling bin), notebook (book),
  jetpack (paper bag), space station (proximity mine), moon rover (quad bike), fuel can (oil drum), drill (fuse),
  chicken leg (tree stump).
- **Prohlédnutí** nic nevyřadilo.
- **Do PLAY 26.** Manifest z nich nejdřív udělal 4 hrdiny podle slova ve jméně – cat tree (kočka), fish tank
  (ryba), hamster wheel (křeček), robot arm (robot); věta „a cat chases a mouse“ by tak mohla dostat škrabadlo
  za hrdinu. Všechny čtyři jsou v `CLASS_OF_MODEL` vyřazené (`p32-manifest.mjs`), manifest zůstává 261.
- **Velikost:** LOD0 max 113 KB, `gen3d-p37d` celkem 22 MB.
