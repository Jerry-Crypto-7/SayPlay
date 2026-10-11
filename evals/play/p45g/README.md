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
