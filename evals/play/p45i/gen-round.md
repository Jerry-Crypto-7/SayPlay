# P45I – kolo modelů přes noc

**Vstup:** 251 jmen z `evals/play/p45i/round-nouns.json` (skupiny a původ v `README.md`), kola 1–26 po 10 jménech v pořadí seznamu (`D:/caches/p45i/round<n>/list.json`). Po vyčerpání seznamu kola 27–36: jména kol 3–24, která se do katalogu nedostala, s novými semínky `b3,a4,b4` (`D:/caches/p45i/build-retry.mjs`). Stejná cesta jako `evals/play/p45g/gen-round.md`, RTX 3090 pod `gpu-lock.mjs`, mezipaměť `D:/claude/_gen3d-cache-p45i`. Surová data, listy a odpovědi soudce: `D:/caches/p45i/round<n>/` (mimo repo).

Kola pouštěla odpojená smyčka `node D:/caches/p45i/loop.mjs 1` (generování `D:/caches/p45i/gen.mjs`). Za kolo:

```
GEN3D_CACHE_DIR=D:/claude/_gen3d-cache-p45i node D:/claude/_shared/gpu-lock.mjs -- uv run python batch.py --from D:/caches/p45i/round<n>/list.json --precheck --attempts a2,b2,a3 --start-comfy --no-quarantine --record D:/caches/p45i/round<n>/batch.json --sheet D:/caches/p45i/round<n>/batch-sheet.png --limit 10
node scripts/p37d/judge-sheet.mjs --record D:/caches/p45i/round<n>/batch.json --out D:/caches/p45i/round<n>/judge --aliases evals/play/p37d/aliases.json --batch-out D:/caches/p45i/round<n>/catalog-batch.json
node scripts/p37d/promote-batch.mjs --batch D:/caches/p45i/round<n>/catalog-batch.json
node scripts/p45d/motion-class.mjs
npx vitest run src/assets scripts/p37d scripts/assets src/play/arcade/__tests__/models-qa.test.ts src/play/arcade/__tests__/hero-choice.test.ts src/play/assets/__tests__/catalog-entries.test.ts
```

- Generování dalšího kola běží souběžně se soudem a povýšením předchozího, karta nestála.
- Červená sada se pustí znovu po souborech; když zůstane červená jinak než časovým limitem, smyčka kolo nezapíše (HOLD) a čeká na ruční commit.
- Kolo synonym (6) šlo bez předkontroly; kola 27–36 se semínky `b3,a4,b4`.
- Poslední kolo začalo v 06:34; kolo 36 už nezačalo (po 07:00). Strop 900 volání Codexu nedošel.

## Kola

| Kolo | Jmen | Předkontrola a brána | Soud | Povýšeno | Codex (předkontrola + soud) | Výsledek |
|---|---|---|---|---|---|---|
| 1 (21:49–22:38) | 10 | 5 | 4 | 4 | 20 + 5 | ručně `81c814af` (viz níže) |
| 2 (22:27–23:19) | 9 | 7 | 4 | 3 | 14 + 7 | `e4035053` |
| 3 (22:57–23:21) | 10 | 9 | 7 | 5 | 14 + 9 | `61a37976` |
| 4 (23:19–23:37) | 10 | 5 | 5 | 5 | 20 + 5 | `8b0eaa87` |
| 5 (23:34–23:55) | 10 | 9 | 8 | 8 | 15 + 9 | `8590ef97` |
| 6 (23:53–23:59) | 3 | 3 | 1 | 1 | 0 + 3 | `015a102d` |
| 7 (23:57–00:14) | 10 | 9 | 7 | 6 | 15 + 9 | `cee22db0` |
| 8 (00:12–00:35) | 10 | 8 | 7 | 7 | 16 + 8 | `97990d0d` |
| 9 (00:32–00:50) | 10 | 10 | 8 | 8 | 12 + 10 | `8c198c88` |
| 10 (00:48–01:07) | 10 | 10 | 4 | 4 | 12 + 10 | `2ed51c95` |
| 11 (01:05–01:24) | 10 | 9 | 6 | 6 | 18 + 9 | `06a947fc` |
| 12 (01:22–01:38) | 10 | 7 | 5 | 5 | 17 + 7 | HOLD, ručně `81e27f2f` (viz níže) |
| 13 (01:36–01:52) | 10 | 9 | 3 | 3 | 13 + 9 | `37d52fca` |
| 14 (01:50–02:05) | 10 | 6 | 1 | 1 | 20 + 6 | `dd19da9e` |
| 15 (02:03–02:22) | 10 | 9 | 6 | 6 | 18 + 9 | `3d21b5cb` |
| 16 (02:20–02:38) | 10 | 10 | 8 | 8 | 11 + 10 | `774f1aab` |
| 17 (02:35–02:48) | 10 | 8 | 6 | 6 | 15 + 8 | `dafa9976` |
| 18 (02:46–03:01) | 10 | 9 | 7 | 7 | 13 + 9 | `921efb43` |
| 19 (02:59–03:14) | 10 | 9 | 7 | 6 | 12 + 9 | `c9398c52` |
| 20 (03:12–03:35) | 10 | 8 | 7 | 7 | 16 + 8 | `5e98206d` |
| 21 (03:34–03:49) | 10 | 10 | 6 | 5 | 12 + 10 | `b13bc8cc` |
| 22 (03:47–04:07) | 10 | 10 | 5 | 5 | 12 + 10 | `5c33465a` |
| 23 (04:05–04:25) | 10 | 7 | 7 | 7 | 19 + 7 | `63c70e3d` |
| 24 (04:23–04:39) | 10 | 8 | 8 | 8 | 15 + 8 | `463dc67e` |
| 25 (04:37–04:54) | 10 | 8 | 5 | 5 | 15 + 8 | `8276fba6` |
| 26 (04:52–05:09) | 9 | 5 | 5 | 5 | 18 + 5 | `415125c3` |
| **1–26, první pokus** | **251** | **207** | **147 (59 %)** | **141 (56 %)** | **382 + 207 = 589** | |
| 27 (05:08–05:16) | 10 | 10 | 2 | 1 | 4 + 10 | `258cb629` |
| 28 (05:14–05:18) | 10 | 10 | 0 | 0 | 0 + 10 | nic k zápisu |
| 29 (05:16–05:25) | 10 | 8 | 5 | 2 | 8 + 8 | `dcc2c47b` |
| 30 (05:24–05:33) | 6 | 0 | 0 | 0 | 18 + 0 | nic k zápisu |
| 31 (05:33–05:50) | 10 | 8 | 2 | 2 | 16 + 8 | `4c09dee2` |
| 32 (05:48–06:12) | 10 | 4 | 0 | 0 | 23 + 4 | nic k zápisu |
| 33 (06:11–06:15) | 2 | 1 | 0 | 0 | 4 + 1 | nic k zápisu |
| 34 (06:14–06:36) | 10 | 5 | 3 | 2 | 20 + 5 | `a58c32d4` |
| 35 (06:34–07:03) | 10 | 6 | 2 | 2 | 22 + 6 | `89747380` |
| **27–35, opakování** | **78** | **52** | **14** | **9 (12 %)** | **115 + 52 = 167** | |
| **celkem** | **329 pokusů, 251 jmen** | **259** | **161** | **150** | **497 + 259 = 756** | |

Kolo 36 (9 jmen: wine rack, city hall, ice resurfacer, pet bed, grocery shelf a další opakování) nezačalo – smyčka ho v 07:01 nepustila kvůli oknu.

- **Předkontrola a brána** – kolik jmen dostalo model, který prošel předkontrolou i bránou kvality.
- **Soud** – slepý soudce jméno poznal (top1 nebo top3). **Povýšeno** – model je v katalogu.
- **Codex** – volání předkontroly (každý pokus) + soudu.

## Co se během noci stalo

- **Dávka 0** (`edbd7eb7`, před smyčkou): anthill a chicken leg z P45F. Soudce je přijal, pin `src/play` je nepustil kvůli slovu ve jménu (ant, chicken). Po opravě třídy v T2 (`4d6065eb`, tam i 8 modelů P45G) povýšené z mezipaměti bez generování.
- **Kolo 1:** soudce neviděl nic – list pro soud ve worktree bez vlastního `node_modules` nenačetl knihovnu `three` (404). Oprava `c4cd20fa`, kolo posouzené znovu a povýšené ručně (`81c814af`). Proto „NOTHING to commit“ v tabulce.
- **Kolo 12:** HOLD – test `scripts/p37d/__tests__/missing-nouns.test.ts` měl robbera jako příklad jména, které katalog nenakreslí, a kolo 12 ho povýšilo. Příklad přesunutý na rain (`5506831f`), kolo commitnuté ručně (`81e27f2f`).
- **Kola 27–29 soudila znovu stejné modely.** `batch.py` vezme model z mezipaměti dřív, než zkusí nová semínka. Jméno, které dřív prošlo generováním, ale ne soudem nebo povýšením, tak dostalo tentýž model: 22 jmen, 22 volání soudu. Od kola 30 jsou jejich záznamy odsunuté do `D:/claude/_gen3d-cache-p45i/_superseded/<jméno>-r<kolo>` (33 jmen, `D:/caches/p45i/uncache.mjs`) a opakování generuje nový model – v kole 31 tak prošly battering ram a notebook.
- **Soudce není úplně stálý:** ze 22 stejných modelů posouzených podruhé jeden změnil výsledek – ballot box z „no“ (foil package) na top3 (package, ve výčtu wrapped box) a povýšil se. Rock cairn: šachový pěšec → dopravní kužel, oba „broken“.
- **Sady pod zátěží karty:** po kole 1 `external-import.test.ts` a `promote.test.ts`, po kole 8 `external-import.test.ts` – červené pod zátěží, samy zelené. Zapsané v těle commitu dávky.

## Konečný stav jmen

Každé z 251 jmen podle posledního pokusu (`D:/caches/p45i/final.mjs`): **150 povýšených, 101 ne.**

- **Povýšeno (150):** snowshoe · snowy lamppost · clock tower · notice board · rope ladder · snow globe · zoo gate · cloud castle · fireplace · rhino · timber house · mushroom house · bar counter · diner booth · griddle · hockey goal · coffee table · grooming table · pill bottle · horseshoe · ballot box · rock pillar · theater seat · toothpaste tube · pharaoh mask · recycling bin · firewood basket · dingo · lake buoy · funeral urn · ice spike · cereal box · water heater · antenna tower · tiki mask · picnic basket · hay cart · water wheel · kangaroo sign · mortar and pestle · saddle · tomato plant · snowy stump · deep sea diver · oil lamp · potato sack · beanstalk · floating island · deep fryer · napkin dispenser · mushroom lantern · fairy door · grooming dryer · fire · paper · karaoke machine · greenhouse · clothes iron · mop · whistle · hairbrush · robber · peacock · centaur · comet · keyboard · notebook · moon rover · drill · ammo · golf ball · boomerang · dynamite · ice auger · gas pump · pearl oyster · battering ram · honey jar · trail sign · forge tong · open grave · stilt hut · salt shaker · magic mirror · marble bust · weather vane · stone column · anubis statue · wood stove · drip stand · butterfly net · didgeridoo · pharmacy sign · merry go round · lasso · compost bin · amphora · bandstand · gingerbread house · diving bell · cellar door · sphinx · wooden dock · laundry cart · tribal drum · display case · tool chest · suit of armor · deli counter · porthole · sunken cannon · haunted portrait · mall kiosk · rolling pin · flour sack · ancient vase · thin ice sign · castle banner · diner sign · fireplace screen · sword rack · dungeon door · fuse box · flower garland · sugar bowl · record player · water pump · milk can · medicine bottle · spring rider · branding iron · frozen fountain · circus cannon · street clock · hammock · ring box · champagne tower · ice lantern · nutcracker · parcel scale · ore crusher · lifebuoy · pinwheel · price tag · scarab statue · oil drum · soda fountain · message in a bottle · statue head · bread basket.
- **Přijaté soudem, nepovýšené (7)** – `normalize: LOD1 cannot be made lighter than LOD0 at the same size`: wedding arch, sea urchin, wildflower, snowy pine tree, gargoyle, city hall, stagecoach. Stagecoach selhal stejně i na novém modelu z kola 34 – chyba je v normalizaci, ne v náhodě generování; další opakování nepomůže.
- **Soudce viděl něco jiného (51)**, v závorce co: shipwreck (shipwreck, rozbitý) · stalagmite (traffic cone) · zip line (windlass) · ticket booth (mailbox) · hearse (van) · sea mine (flail) · car wreck (car) · tooth model (tooth) · woodpile (rock) · engine hoist (transmission jack) · scoreboard (loudspeaker) · red cross flag (sign) · drilling rig (oil derrick) · monkey bar (towel rack) · rock cairn (traffic cone, rozbitý) · bathysphere (lantern) · hubcap (wheel) · radiator (lantern) · magazine rack (bookshelf) · ceiling fan (floor lamp, rozbitý) · pet shampoo (soap dispenser) · snowball bucket (trash can) · toboggan (suitcase) · puddle (frisbee) · bandage (toilet paper) · tunnel (fireplace) · dam (metal barricade) · blanket (pillar) · newspaper (metal panel) · magazine (vending machine) · tablet (computer monitor) · tape (ring sculpture) · receipt (tower fan) · mahjong tile (gravestone) · poacher (thief) · pinata (horse) · freezer chest (washing machine) · beer keg (soda can, rozbitý) · mailbag (backpack) · overpass (pool table) · wine rack (metal grate) · ice resurfacer (pickup truck) · pet bed (swim ring) · wanted poster (cheese block) · postage stamp (aquarium) · mile marker (road sign) · egg basket (basket, rozbitý) · mossy boulder (cabbage, rozbitý) · dog leash (fire hose) · graduation gown (robe) · fossil display (gravestone).
- **Předkontrola odmítla všechny obrázky (36)**, v závorce co viděla:
  - správné nebo skoro správné jméno, obrázek označený jako rozbitý (13): broken column (column) · trapeze · tire stack · scrap pile (rubble pile) · dumpling (steamed dumpling) · financial advisor (businesswoman) · laundry basket · ore pile · grocery shelf (store shelf) · guestbook (guest book) · tool wall (tool board) · mushroom ring (fairy ring) · party streamer (party streamers).
  - jiný předmět (23): gold pile (trophy, rozbitý) · chopping block (axe, rozbitý) · tightrope (limbo set) · ice sculpture (swan figurine) · tumbleweed (wicker ball) · ice fishing hole (washer) · pinecone (pine cone) · pebble (mirror) · frisbee (trophy) · passport (book) · marshmallow (sheep) · broomstick (double-ended broom) · hydrothermal vent (chess king) · alphorn (didgeridoo) · golden idol (baby figurine) · giant clam (rock golem) · duck decoy (duck) · mushroom stool (mushroom) · snow plow (front loader) · fishing shanty (wooden cabin) · windpump (windmill) · brick pile (brick pallet) · pill organizer (alphabet blocks, rozbitý).
  - Pinecone → „pine cone“ (a v kole 23 snow plow → „snowplow“) je pravopis, ne jiný předmět – synonymum v předkontrole by je pustilo k soudu.
- **Brána kvality – `inconsistent face winding` (7):** snowy cottage, bouquet, golem, towel, mole, egg carton, frozen waterfall.
