# P45G – rekvizity pro prostředí, která knihovna neumí

Plán: P45G (interní). Větev převzala fast-forwardem lokální `features/P45F-dogenerovani-modelu-2026-10-09` (`53f24c81`) – slučuje se **po P45F**, ten po P45E.

## Odkud jsou jména

- **8 nezpracovaných jmen P45F** (dávka 6 nespuštěná kvůli oknu): rhino, singer, space station, swing, tablet, tape, tea, torpedo. Ruční znak v `ops/gen3d/features.toml` mají z P45F, seznam v `D:/caches/p45f/round6/list.json`.
- **Prostředí** z `evals/play/p45d/missing.json` → `settings`: 85 prostředí, která porotci píšou a knihovna nemá čím nakreslit, dohromady 101 vět (frozen lake a highway po 4, supermarket a underwater po 3, birthday party, deep sea, haunted mansion, mall, tavern, winter po 2, zbytek po 1). Pro každé prostředí 2–4 typické rekvizity, podle kterých ho hráč pozná (supermarket: nákupní vozík, regál, pokladna).
- **Proč prostředí, ne zbytek jmen:** zbylých 80 chybějících předmětů pokrývá jen 54 vět a nese šum („mar“, „electricity bill“).
- Mimo: kód generátoru, `src/play/**`, `src/components/**`, placená API, zapečetěné sady.

## Seznam a znaky (T2)

- `kit-nouns.json` – **159 jmen**: nejdřív 8 nezpracovaných jmen P45F (znak mají z P45F), pak **151 rekvizit pro 74 prostředí** v pořadí `missing.json` (podle počtu vět). Každé jméno nese třídu (`bodyOfNoun` ze `scripts/p45d/motion-class.mjs`), prostředí, ke kterým patří, a součet jejich vět. Rekvizita pro víc prostředí je v seznamu jednou (rock arch: canyon + desert canyon; grocery shelf a checkout counter: supermarket + grocery store; candelabra: haunted mansion + haunted castle; rope bridge: cliff + rocky river; tire stack: garage + junkyard garage; burnt tree: burned forest + burning tree).
- **Bez rekvizit, které katalog už má** (tag, id nebo „seen:“ štítek soudce): kontrola proti `src/assets/catalog.json` vyřadila mimo jiné traffic cone, road barrier, road sign, shopping cart, seaweed, anchor, coral, cobweb, anglerfish, jellyfish, bar stool, croissant, iceberg, hospital bed, stretcher, armchair, floor lamp, sofa, television, crystal ball, spellbook, cauldron, mine cart, seesaw, hay bale, stepping stone, sled, snowman, circus tent, fountain, treehouse, wedding cake, kangaroo, koala. Prostředí, kterým tak zbyla jediná nová rekvizita: jungle hospital (medical tent), living room (coffee table), mushroom village (mushroom house), rocky river (beaver dam vedle sdíleného rope bridge).
- **Třída opravená ručně** u 20 jmen, kde ji `bodyOfNoun` určí podle slova špatně: dog kennel, dog bowl, cow skull → prop (ne quadruped), car jack, rooftop water tank → prop (ne vehicle), wizard tower → prop (ne biped), emu → prop (šablona bipeda kreslí postavu, quadrupeda čtyři nohy); hearse, ice resurfacer, planet rover → vehicle, dingo → quadruped; zbytek prop. Plochou šablonu (`flat`) mají cedule, dveře, opona, žebřík, věnec a nástěnka (8).
- **bellows → grindstone:** dávka „bellows“ zkrátí na „bellow“ (`cache.normalize`, množné číslo), soudce by dostal jiné slovo; kovárnu ukáže brus.
- `ops/gen3d/features.toml` – ruční znak (10–20 slov, tvar a barva) pro všech 151 nových jmen, oddíl „P45G“. Kontrola: každé jméno po `cache.normalize` má znak a délku 10–20 slov.
- **Vyřazená prostředí (6):**
  - winter – roční období, ne místo; sníh a mráz kreslí scéna, žádný předmět ho neoznačí.
  - vacation – abstraktum, dovolená je situace, ne místo ani věc.
  - family reunion – setkání lidí, žádný předmět ho nepozná od pikniku nebo oslavy.
  - zoom meeting – videohovor na obrazovce; notebook katalog má, schůzku žádný předmět neukáže.
  - green hill, hillside – tvar terénu; kopec a svah kreslí zem scény, samostatný předmět by soudce viděl jako kámen.
- **Prostředí, jejichž rekvizity katalog už má (5):** birthday party (birthday cake, party hat, gift box, balloon), brick wall (brick wall, stone wall), lawn (lawn mower, garden gnome, sprinkler), mushroom hill (mushroom, toadstool), treasure island (treasure map, palm tree, shovel). Jestli se ve hře objeví, ukáže T4.

## Okno a strop

- Karta RTX 3090 sdílená s P45B, každý běh přes `node D:/claude/_shared/gpu-lock.mjs -- <příkaz>`. Cache `D:/claude/_gen3d-cache-p45g`, záznam dávek `D:/caches/p45g/round<n>/`.
- Po **11. 10. 2026 18:45** se nová dávka nespouští; rozběhnutá se dokončí, hotové se povýší, zbytek se zapíše do `gen-round.md`. Souhrn hotový nejpozději v 19:15.
- Codex na předplatné (předkontrola + slepý soud v prázdném adresáři, jen `sheet.png`): strop celého P45G **400 volání**. Vyčerpaný limit = zbylá jména „čeká na soud“, běh končí. Výstupy soudce nikdy do trénovacích dat.
- Povýšení nesmí změnit výsledek testů v `src/play`; když zčervenají, jméno jde ven přes `promote-batch.mjs --drop` a zapíše se jako zjištění.

## Souhrn kola (11. 10. 2026, 14:07–18:38)

| | Jmen | Předkontrola a brána | Slepý soud | Povýšeno |
|---|---|---|---|---|
| P45G, 14 dávek po 10 | 140 | 110 | **87 (62 %)** | **74 (53 %)** |
| P45F, 5 dávek po 10 | 50 | 37 | 18 (36 %) | 15 (30 %) |

- **Úspěšnost:** soud 62 % proti 36 % v P45F, povýšeno 53 % proti 30 %. Generátor, soudce i ruční znak stejné jako v P45F. *Odhad, neměřeno:* rozdíl dělá hlavně seznam – P45F zkoušel znovu jména, která už jednou neprošla, P45G nové běžné předměty (pult, budka, regál).
- **Cíl ≥ 25 modelů splněn: 74 nových modelů** v knihovně, každý s licencí a původem v `disclosure.json`. Po dávkách a jménech `gen-round.md`.
- **Cíl ≥ 2 rekvizity na zpracované prostředí splněn jen u 20 ze 64:** frozen lake, highway, supermarket, haunted mansion, mall, tavern, bakery, burned forest, burning tree, canyon, castle gate, college, crooked tower, farm market, forest path, forge, graveyard, jungle river, kitchen table, post office. Jednu novou rekvizitu má 33 prostředí, žádnou 11 (deep sea, cellar, cloud castle, diner kitchen, garage, junkyard garage, hotel basement, living room, mushroom village, pet salon, snow fort). Počítané jen nové modely – rekvizity, které katalog už měl (T2), sem nepatří.
- **Přijaté soudem, nepovýšené (13):**
  - 8 kvůli pinu v `src/play` – dog kennel, dog bowl, cow skull, car jack, luggage cart, wizard tower, dinosaur skeleton, rooftop water tank. `scripts/assets/p32-manifest.mjs` jim podle slova ve jménu (dog, cow, car, cart, wizard, dinosaur, tank) dá záznam zvířete, vozidla nebo postavy v `src/play/assets/entries/catalog.json` a pin počtu v `src/play/assets/__tests__/catalog-entries.test.ts` zčervená. Ruční třída prop z `kit-nouns.json` do manifestu nedojde. Modely leží v `D:/claude/_gen3d-cache-p45g/`.
  - 5 kvůli `normalize: LOD1 cannot be made lighter than LOD0` – sea urchin, cloud castle, fireplace, hearse, wildflower.
- **Co zbylo (85 ze 159 jmen):**
  - 19 nespuštěných kvůli oknu – dávky 15 a 16 (`D:/caches/p45g/round15/list.json.held`, `round16/list.json`), znak mají.
  - 53 zkoušených a neprošlých: soudce viděl něco jiného (23), předkontrola odmítla všechny obrázky (25), brána kvality – `inconsistent face winding` (5: rhino, tumbleweed, timber house, mushroom house, snowy pine tree).
  - U 13 z těch 25 předkontrola řekla správné jméno, ale obrázek označila jako rozbitý (ice fishing hole, bar counter, diner booth, griddle, chopping block, tire stack, hockey goal, scrap pile, coffee table, grooming table, pill bottle, sandbox, horseshoe). U 3 dalších viděla blízké slovo bez označení „rozbitý“ – synonymum by je pustilo k soudu: car wreck → wrecked car, dingo → dog, tooth model → tooth.
- **Codex:** 333 ze 400 volání (223 předkontrol + 110 soudů), limit nedošel.

## Sady (T4, 11. 10. 2026 18:37–18:40)

- Po každé dávce prošly `src/assets`, `scripts/p37d`, `models-qa`, `hero-choice` a `catalog-entries` (po dávce 14 1184/1184).
- `evals/play/catalog-coverage.json` po nových modelech zastaral (967 → 1041 modelů) – přegenerováno `node scripts/assets/cc0/coverage.mjs`, pokrytí jmen beze změny, test pokrytí prošel.
- `npx vitest run src/assets scripts src/play/arcade/__tests__` + test pokrytí, v klidu (CPU 25 %, generování doběhlo): 142 souborů, **3152 z 3153 testů prošlo**. Jediný červený je `scripts/__tests__/submission-check.test.ts`, který čte gitignorovaný `plans/P8-odevzdani.md` – worktree ho nemá, s P45G nesouvisí. `loader.test.ts` a `p32-heavy.test.ts`, v P45F červené pod cizí zátěží, prošly.

## Objeví se nová rekvizita ve hře? (T4)

Měřeno na `npm run build` + `next start` (build `a6b8892d`, dávky 1–8): věta poslaná přes `/api/play/games`, hra otevřená v headless Chromiu, zapsané všechny načtené GLB a snímky obrazovky (`D:/caches/p45g/t4/`).

- **Věta, která jmenuje jen prostředí, novou rekvizitu nenačte.** Tři prostředí s nejvíc větami:
  - „ice fishing on a frozen lake“ – načte iceberg, tučňáka a hvězdu; ice floe ani ice fishing hut ne.
  - „race cars on the highway“ – načte městskou sadu (taxi, hydrant, zastávka, semafor, dům); toll booth ani highway sign ne.
  - „a cat runs through a supermarket“ – načte sadu supermarketu (regály, lednice, pokladna, vozík); checkout counter ani shopping basket ne.
- **Věta, která rekvizitu jmenuje jako součást hry, ji ukáže.** „dodge toll booths on the highway“ dá mýtnou budku jako překážku: na snímku po 6 s hraní stojí na silnici budka se závorami, stejná jako náhled v katalogu (`D:/caches/p45g/t4/toll-6s.png`).
- **Kdo vybírá scenérii** (vstup pro další plán), vše v `src/play/arcade/look/index.ts`:
  - `KEYWORDS` – pevná tabulka slov, která prostředí přiřadí jednu ze 17 sad (highway → city, frozen lake → snow, haunted mansion → graveyard); nic nesedí → meadow.
  - `LOOKS` – pevný seznam rekvizit každé sady.
  - `SCENERY_MODELS` – seznam modelů, které smí být scenérie (id → výška); rozmisťuje je `src/components/play/arcade/look/Scenery.tsx`. Pin `src/play/__tests__/look.test.ts` hlídá, že každé id z něj je v katalogu.
  - Štítky katalogu výběr scenérie neovlivní.
- *Odhad, neověřeno:* aby se kity P45G ukázaly i ve větě jen s prostředím, musí další plán buď doplnit nové sady a jejich rekvizity do `KEYWORDS`/`LOOKS`/`SCENERY_MODELS`, nebo vybírat scenérii z katalogu podle prostředí – mapu prostředí → rekvizity už má `kit-nouns.json`.

## Doporučení

1. **Další plán na `src/play`:** výběr scenérie podle prostředí z `kit-nouns.json` – bez něj 74 nových modelů uvidí hráč jen ve větě, která je jmenuje.
2. **Oprava třídy v `scripts/assets/p32-manifest.mjs`** (brát ruční třídu, ne slovo ve jménu) vrátí 8 přijatých modelů z mezipaměti bez nového generování.
3. **Dávky 15–16** (19 jmen) jsou připravené; odhadem ~40 minut GPU a ~50 volání Codexu.
4. **Předkontrola se synonymy** by pustila k soudu aspoň 3 jména (car wreck, dingo, tooth model).

## Slučování

Slučuje se **po P45F** (větev P45G na ní stojí). Konflikt v `src/assets/catalog-motion.json` a `evals/play/catalog-coverage.json` se neřeší ručně: vzít libovolnou stranu a znovu spustit `node scripts/p45d/motion-class.mjs` a `node scripts/assets/cc0/coverage.mjs`. `src/play` a `src/components` P45G nemění.
