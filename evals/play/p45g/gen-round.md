# P45G – kolo rekvizit pro prostředí

**Vstup:** 159 jmen z `evals/play/p45g/kit-nouns.json` (8 nezpracovaných jmen P45F, pak 151 rekvizit pro 74 prostředí) s ručním znakem v `ops/gen3d/features.toml`, dávky po 10 v pořadí seznamu (`D:/caches/p45g/round<n>/list.json`). Stejná cesta jako `evals/play/p45e/gen-round.md`, RTX 3090 pod `gpu-lock.mjs`, nová mezipaměť `D:/claude/_gen3d-cache-p45g`. Surová data, listy a odpovědi soudce: `D:/caches/p45g/round<n>/` (mimo repo).

```
GEN3D_CACHE_DIR=D:/claude/_gen3d-cache-p45g node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from D:/caches/p45g/round<n>/list.json --precheck --start-comfy --no-quarantine --record D:/caches/p45g/round<n>/batch.json --sheet D:/caches/p45g/round<n>/batch-sheet.png --limit 10
node scripts/p37d/judge-sheet.mjs --record D:/caches/p45g/round<n>/batch.json --out D:/caches/p45g/round<n>/judge --aliases evals/play/p37d/aliases.json --batch-out D:/caches/p45g/round<n>/catalog-batch.json
node scripts/p37d/promote-batch.mjs --batch D:/caches/p45g/round<n>/catalog-batch.json
node scripts/p45d/motion-class.mjs
```

Generování další dávky běží souběžně se soudem a povýšením předchozí. Úloha na pozadí Claude Code končí po 10 minutách – zabije jen obal skriptu, dávka pod `gpu-lock` běží dál; proto se dávky spouští jako odpojený proces (`Start-Process`).

| Dávka | Jmen | Předkontrola a brána | Soud | Povýšeno | Codex (předkontrola + soud) |
|---|---|---|---|---|---|
| 1 (14:07–14:27) | 10 | 6 | 4 | 4 | 19 + 6 |
| 2 (14:23–14:58) | 10 | 9 | 7 | 6 | 14 + 9 |
| 3 (14:56–15:11) | 10 | 9 | 8 | 8 | 12 + 9 |
| 4 (15:10–15:28) | 10 | 10 | 10 | 8 | 10 + 10 |
| 5 (15:24–15:42) | 10 | 10 | 6 | 5 | 11 + 10 |
| 6 (15:40–15:56) | 10 | 8 | 7 | 6 | 14 + 8 |
| 7 (15:52–16:21) | 10 | 7 | 5 | 4 | 20 + 7 |
| 8 (16:18–16:42) | 10 | 9 | 8 | 8 | 17 + 9 |
| 9 (16:40–17:00) | 10 | 7 | 6 | 3 | 17 + 7 |
| 10 (16:54–17:11) | 10 | 8 | 5 | 5 | 14 + 8 |
| 11 (17:09–17:38) | 10 | 7 | 7 | 5 | 20 + 7 |
| 12 (17:35–18:05) | 10 | 8 | 5 | 4 | 14 + 8 |
| 13 (18:01–18:17) | 10 | 6 | 5 | 5 | 19 + 6 |

**Dávka 1** (8 jmen P45F, ice fishing hole, ice fishing hut):
- Povýšeno (4): top1 swing („swing set“); top3 singer („woman“, female singer ve výčtu), torpedo („bomb“), ice fishing hut („shack“, hut ve výčtu).
- Soudce poznal něco jiného: tablet: crate · tape: ring sculpture.
- Předkontrola odmítla všechny tři obrázky: space station: satellite ×3 · tea: teacup ×3, označený jako rozbitý · ice fishing hole: **ice fishing hole** ×3 – správné jméno, ale obrázek označený jako rozbitý (díra v ledu není samostatný předmět).
- Bránou kvality neprošel: rhino (3× `inconsistent face winding`).

**Dávka 2** (frozen lake, highway, supermarket, underwater):
- Povýšeno (6): top1 ice floe, toll booth, highway sign („directional sign“), checkout counter, shopping basket; top3 sea anemone („coral“, sea anemone ve výčtu).
- Přijatý, nepovýšený: sea urchin (top3 „cactus“, sea urchin ve výčtu) – `normalize: LOD1 cannot be made lighter than LOD0 at the same size` (stejná třída jako dynamite v P45E).
- Soudce poznal něco jiného: overpass: trampoline · diving bell: hanging lantern.
- Předkontrola odmítla všechny tři obrázky: grocery shelf: store shelf ×3, označený jako rozbitý (vizuálně správně – synonymum by ho pustilo).

**Dávka 3** (deep sea, haunted mansion, mall, tavern):
- Povýšeno (8): top1 candelabra, grandfather clock, chandelier, escalator, mannequin, clothing rack („clothes rack“), tavern sign; top3 tankard („beer mug“).
- Soudce poznal něco jiného: giant clam: bowl.
- Předkontrola odmítla všechny tři obrázky: bar counter: **bar counter** ×3 – správné jméno, obrázek označený jako rozbitý.

**Dávka 4** (animal shelter, bakery, burned forest, burning tree, canyon):
- Povýšeno (8): top1 pet carrier, bread oven („pizza oven“), cake stand, baguette, burnt tree („dead tree“), charred log („log“, charred log ve výčtu), burning tree („tree“, burning tree ve výčtu), rock arch („stone arch“).
- Přijaté, nepovýšené (2): **dog bowl** (top1), **dog kennel** (top3 „doghouse“) – `scripts/assets/p32-manifest.mjs` jim podle slova „dog“ dal třídu animal a záznam v `src/play/assets/entries/catalog.json`, pin počtu v `src/play/assets/__tests__/catalog-entries.test.ts` zčervenal (263 místo 261) → `--drop` (stejná třída jako anthill a chicken leg v P45F). Modely v `D:/claude/_gen3d-cache-p45g/`.

**Dávka 5** (canyon, castle gate, cellar, city hall, cliff, cloud castle):
- Povýšeno (5): top1 mesa, castle gate, flagpole, rope bridge; top3 portcullis („iron gate“).
- Přijatý, nepovýšený: cloud castle (top1 „castle“) – `normalize: LOD1 cannot be made lighter than LOD0`.
- Soudce poznal něco jiného: wine rack: coal crate · cellar door: wooden barricade · city hall: temple · rocky cliff: rock pillar.

**Dávka 6** (cloud castle, college, concert hall, crooked tower, dentist office, desert canyon):
- Povýšeno (6): top1 diploma, music stand, crooked tower („tower“), crooked house („house“), dentist chair („dental chair“); top3 lecture podium („lectern“).
- Přijatý, nepovýšený: **cow skull** (top1 „bull skull“) – manifest P32 mu podle slova „cow“ dal třídu animal, pin počtu zčervenal → `--drop`.
- Soudce poznal něco jiného: stage curtain: puppet theater.
- Předkontrola odmítla všechny tři obrázky: cloud platform: cloud / UFO / … · tooth model: tooth ×3 (vizuálně správně – zub; slovo „model“ předkontrola nebere).

**Dávka 7** (desert canyon, desert temple, diner kitchen, driveway, farm market, fireplace):
- Povýšeno (4): top1 obelisk, fruit crate, vegetable basket, garden hose.
- Přijatý, nepovýšený: fireplace (top1) – `normalize: LOD1 cannot be made lighter than LOD0`.
- Soudce poznal něco jiného: sphinx: dog · garage door: crate.
- Předkontrola odmítla všechny tři obrázky: diner booth, griddle – obojí se správným jménem, obrázky označené jako rozbité.
- Bránou kvality neprošel: tumbleweed (`inconsistent face winding`, pivot mimo střed – řídký chuchvalec větviček).

**Dávka 8** (fireplace, foggy lake, forest hut, forest path, forge, funeral):
- Povýšeno (8): top1 rocking chair, cattail („cattails“), fallen log („hollow log“), hiking backpack, grindstone, forge furnace („furnace“), funeral wreath („wreath“); top3 wooden hut („wooden cabin“).
- Soudce poznal, ale označil jako rozbitý: wooden dock („wooden bridge“, dock ve výčtu) – nepovýšen.
- Předkontrola odmítla všechny tři obrázky: chopping block – správné jméno, obrázky označené jako rozbité.

**Dávka 9** (funeral, garage, glacier, graveyard, haunted castle, hotel basement):
- Povýšeno (3): top1 ice cave, angel statue; top3 mausoleum („shrine“).
- Přijaté, nepovýšené (3): **car jack** (top1 „floor jack“), **luggage cart** (top1) – manifest P32 jim podle slov „car“ a „cart“ dal třídu vehicle, pin počtu zčervenal → `--drop`; hearse (top3 „car“) – `normalize: LOD1 cannot be made lighter than LOD0`.
- Soudce poznal něco jiného: ice wall: ice block.
- Předkontrola odmítla všechny tři obrázky: tool chest: tool cabinet ×3, označený jako rozbitý · tire stack – správné jméno, obrázky označené jako rozbité · suit of armor: armored knight ×3 (prázdné brnění vypadá jako rytíř).

**Dávka 10** (hotel basement, ice rink, icy moon, jungle festival, jungle hospital, jungle river):
- Povýšeno (5): top1 ice skate, planet rover („space rover“), tiki torch („torch“), medical tent („tent“), jungle vine („hanging vine“).
- Soudce poznal něco jiného: laundry cart: trash bin · ice resurfacer: floor scrubber · tribal drum: log.
- Předkontrola odmítla všechny tři obrázky: hockey goal – správné jméno, obrázky označené jako rozbité · ice geyser: ice spike ×3.

**Dávka 11** (jungle river, junkyard garage, kitchen table, living room, magic tower, meadow):
- Povýšeno (5): top1 mangrove tree, fruit bowl, potion bottle, dandelion; top3 pepper mill („pepper grinder“).
- Přijaté, nepovýšené (2): **wizard tower** (top1) – manifest P32 mu podle slova „wizard“ dal třídu humanoid, pin počtu zčervenal → `--drop`; wildflower (top1 „wildflowers“) – `normalize: LOD1 cannot be made lighter than LOD0`.
- Předkontrola odmítla všechny tři obrázky: car wreck: car / wrecked car (vizuálně správně – synonymum by ho pustilo) · scrap pile – správné jméno, obrázky označené jako rozbité · coffee table: coffee table / table, označené jako rozbité.

**Dávka 12** (medieval town, mining colony, mountain village, museum hall, mushroom village):
- Povýšeno (4): top1 pillory, mining helmet, stone bridge; top3 velvet rope („rope barrier“).
- Přijatý, nepovýšený: **dinosaur skeleton** (top1) – manifest P32 mu podle slova „dinosaur“ dal třídu monster, pin počtu zčervenal → `--drop`.
- Soudce poznal něco jiného: mining drill: drilling rig · alpine chalet: house · display case: trash can.
- Bránou kvality neprošly: timber house, mushroom house (`inconsistent face winding`).

**Dávka 13** (outback, pet salon, pharmacy, playground, post office):
- Povýšeno (5): top1 medicine cabinet, playground slide, post box, parcel; top3 emu („ostrich“, emu ve výčtu).
- Soudce poznal něco jiného: pet bed: fire pit.
- Předkontrola odmítla všechny obrázky: dingo: dog / fox / dog (vizuálně správně – dingo je pes; třetí pokus neprošel bránou kvality) · grooming table, pill bottle, sandbox – správné jméno, obrázky označené jako rozbité.
