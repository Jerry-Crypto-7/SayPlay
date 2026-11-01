# P68 – předání k zapojení: kategorie `vozidla-sport` (P68-V)

Hry `stunt` a `minigolf`. Každá hra má vlastní sekci podle `../integration-template.md` (popis, věty, narážky, assety,
požadované změny kontraktu, fixture spec) a vlastní značku `p68-ready: <id>` (HTML komentář), přidanou až když je hra
hotová. P68-I zapne každou hru zvlášť, jakmile její značka dorazí do `origin/main`.

## Hry a id

| id | Stage (`stage-registry.ts`) | vstup | pohled (`P68_VIEWS`) | stav |
|---|---|---|---|---|
| `stunt` | `scene: 'stunt'` | `steer` | `chase` | hotová – e2e 12/12 (T5), `p68-ready: stunt` |
| `minigolf` | `scene: 'minigolf'` | `throw-rig` | `shoulder` | hotová – e2e 12/12 (T9), `p68-ready: minigolf` |

Kostra P68-I (`origin/main` `15c81e6a`) dala oběma hrám vstup, který plán čeká.

## Popisky HUD

Nové popisky počítadel, které `HUD_COUNTER_LABELS` (`e2e/hud-labels.ts`) nezná: `hud-labels-request.ts`
(`smash`, `air`, `strokes`, `par`). Prosba: dopsat je do sdíleného seznamu při zapojení her.

## Projekty Playwright

Kostra dopsala `play-stunt` a `play-minigolf` do `testMatch` projektů `pixel7-touch` i `iphone-touch`
(`playwright.config.ts`). Vlastní konfigurace pruhu není potřeba.

## Přednačtení fyziky

- `stunt`: bedny v hromadách jsou tělesa Rapieru (`FLAG.physics`) od tiku 0, takže klient Rapier přednačte podle světa
  (`worldHasPhysics`). **Server ale podle specu ne:** `specNeedsPhysics` zná `stunt` až po zápisu – do té doby první
  `POST /api/play/games` po startu serveru může vrátit 422 („fyzika nenačtená“). Prosba: doplnit `stunt` do
  `specNeedsPhysics` (zjištěno v T3). Hráč-auto zůstává kinematické.
- `minigolf`: Rapier se nenačítá vůbec. Spike T6 (50 ran, síly 15/35/60): koule Rapieru s celočíselným útlumem se do
  180 tiků zastavila jen 21/50 (útlum brzdí posun, ne rotaci; tření ji dál tlačí), celočíselné kutálení v jádře 50/50
  (nejdéle 119 tiků), obě verze replay 50/50 shodně. Míček se kutálí v jádře, těla dráhy jsou nepevná.

## Požadavky na sdílené soubory (souhrn)

- **Montáž dotykového adaptéru pro `steer` / `throw-rig`.** `GENRE_TOUCH` montuje adaptér jen vstupu `genre`.
  `stunt` chce vlastní palec (tah kdekoli ve spodní polovině = osa, tlačítko brzdy) a `minigolf` natažení zpět od
  míčku. Do zapojení je scéna vykreslí sama jako DOM vrstvu (`StuntTouch` v `StageOverlay` scény, `MinigolfTouch`
  vlastním React rootem – drei `Html` se skryje, když je počátek světa za kamerou); prosba: registr i pro tyto dvě hry
  (`GENRE_TOUCH[control]` bez podmínky `input === 'genre'`, nebo vstup `genre`). Obě komponenty berou props registru
  (`{ session }`). **Při montáži přes registr smazat vlastní montáž ve scéně**, jinak se ovládání ukáže dvakrát.
  `throw-rig` mimo VR dnes klávesnici ani dotyk nemá, `steer` poslouchá celou plochu – palec `stunt` proto zastaví
  vlastní pointer události. Test: `stunt-touch.test.ts` / `minigolf-touch.test.ts` (gesto = tentýž `ArcadeInput` jako
  klávesnice).
- **Počítadla HUD obou her.** `hudCountersOf` / `progressLabel` v `ArcadePlay.tsx` staví jen shots, ammo, lives, Dare
  a collected, takže `smash` / `air` (`stunt`, tělo 1, `STUNT_SLOTS`) ani `strokes` (`ammo`) / `par` (`reserve`)
  (`minigolf`) sdílený HUD neukáže. Do zapojení je kreslí scény samy jako náhradní pilulku vlevo dole
  (`hud-counter-smash`, `hud-counter-air`, `hud-counter-strokes`, `hud-counter-par`, každé s `data-count`). Prosba:
  počítadla do sdíleného HUD s popisky z `hud-labels-request.ts`, pak smazat `StuntCounters` a pilulku v `MinigolfTouch`
  (jinak jsou test id dvakrát).
- **`FreshCamera` nemaže posun pohledu** (`setViewOffset`), který na výšku nechá předchozí scéna (`SurvivorScene`).
  Scéna `stunt` si ho maže sama; čistá oprava patří do `FreshCamera`.
- **Sdílený otřes z `Effects`** přidá k nárazu `stunt` svých 150 ms navíc a nejde vypnout bez sdílené změny (drobnost).

- **Stream PRNG `stunt` v `src/sim/rng.ts`.** Prosba: připsat `'stunt'` na konec `SUBSYSTEMS` (za `rounds`). Do té
  doby si jádro `stunt` tentýž stream odvozuje samo (`jump()` od seedu hry), takže po zápisu do sdíleného seznamu se
  otisk nezmění. Test: `stunt.test.ts` („the same seed builds the same track and scatter table“) a `stunt-replay.test.ts`.
- **VR a `throw-rig`:** vstup `throw-rig` ve VR posílá `HOLD` bez osy míření, což minigolfu vrátí míření rovně. VR
  minigolf P68V neplánuje; při zapojení do VR (`XR_MODES`) je potřeba osa i ve VR.

- **Štítek ducha „Best run“ chytá dotyk** (`Ghost.tsx`, sdílený). `<Html pointerEvents="none">` drei použije jen
  v režimu `transform`; bez něj zůstane `span.sp-world-tag` klikatelný. Duch přehrává ověřený běh, takže při hraní
  stopou robota štítek leží nad míčkem – přesně tam, kde hráč minigolfu začíná tah. Naměřeno v T9: na `iphone-touch`
  trefil stisk druhé rány `play-ghost-tag` místo vrstvy natažení (test pak začne o 10 % výšky níž). Prosba:
  `style={{ pointerEvents: 'none' }}` na `Html` ducha (nebo `pointer-events: none` na štítku). Test: stisk na místě
  štítku → `elementFromPoint` je pod ním ležící vrstva.

- **Řádky do `e2e/play-perf.spec.ts`.** Obě hry si FPS měří samy (`fps-stunt.json`, `fps-minigolf.json`: 10 s ukázky
  robota, medián ≥ 40 FPS, p95 ≤ 33,3 ms na `chromium`). Prosba: přidat `stunt` (fixture `p68-stunt-spec.json`) a
  `minigolf` (`p68-minigolf-spec.json`) do sdíleného měření, ať hlídá i budoucí změny scén. Minigolf trvá 4,7 s, okno
  10 s proto zachytí i scénu po výhře.
- **Nové druhy efektů v `contract.ts`:** žádné. Náraz `stunt` jde přes `spawn` / `despawn` / `damage`, minigolf efekty nemá.

## Žebřík zjednodušení a co je nesplněné

| hra | stupeň | co to znamená |
|---|---|---|
| `stunt` | 0 – plný rozsah | skoky z ramp, brzda, trosky z kontaktů s rozpočtem, poškození, cíl |
| `minigolf` | 1 – celočíselné kutálení místo koule Rapieru | spike T6: Rapier zastavil 21/50 ran do 180 tiků, kutálení 50/50; pohyblivá překážka i odrazníky zůstaly |

**Nesplněné:**
- ~~`stunt` na telefonu na šířku: auto sedí těsně nad dolní lištou HUD a stín skoku pod ní mizí; rampa vypadá jako
  plochá dlaždice, prach místy kryje auto~~ – splněno v T4-R1 (1. 11. 2026): kamera na šířku sklopí pohled nad dolní
  pás, rampa má pruhy napříč nájezdem a tmavou hranu, prach je menší a kratší; `play-stunt` 12/12, snímky prohlédnuté.
- Štítek ducha „Best run“ chytá dotyk nad míčkem (sdílený `Ghost.tsx`, výš) – **nesplněné**, mimo soubory pruhu.
- Fyzický telefon neměřen (FPS jen hostitel a emulace); WebKit na Windows kreslí prázdné plátno, iPhone je ověřený
  sondou záběru a DOM, ne okem.

## `stunt`

### Popis pro režiséra a čtečku

Krátký kaskadérský závod (~30–35 s): hráč řídí vozidlo z věty po trati se zatáčkami, najíždí na rampy a skáče,
prorazí hromady věcí z věty, před ostrou zatáčkou brzdí; náraz do mantinelu stojí život (3), vyhrává průjezd cílem
před limitem trati, prohrává tři nárazy nebo limit.

Řádek pitche pro režiséra (anglicky, `GENRE_PITCH.stunt`): *short stunt race – steer a vehicle over ramps for big
jumps, smash through piles of things, brake for sharp bends, reach the finish before time runs out; hitting the
barrier costs a life*.

Co z věty kam (`compileStunt` v `src/play/genre/stunt.ts`):
- **hrdina** = vozidlo, model hráče `modelOf(hero)` → `tuning.vehicle` (jinak `car`); třídy hrdiny vehicle, animal,
  humanoid, robot. Čtečka: hrdina je to, co jede („a stunt rider on a motorbike“ → motorbike).
- **první věc obsazení, která není cíl** = věc v hromadách → role `pile` (`target`); jinak `crate`.
- **věc s `reach`** = popisek cíle (role `finish`, `exit`); jinak „finish line“.
- **místo** → `theme.look` (`lookFor`).
- **parametry** (`params`, celá čísla): `ramps` 2–4 (výchozí 3), `piles` 2–4 (3), `lengthM` 200–360 (340; okruh
  řízení před vložením triků, výsledná trať ~300–580 m), `difficulty` 1–3 = easy / normal / hard (šířka a zatáčky).
  Počty rolí (`COUNT_PARAMS.stunt`) žádné.

### Věty pro klasifikátor

Mají skončit ve `stunt` (1–10 = dev věty pruhu `dev.json`, 11–20 nové):

1. a monster truck jumps the ramp into a tower of crates in a desert
2. a police car smashes through a wall of barrels on a frozen lake
3. a pizza delivery scooter jumps the canal and crashes into a stack of boxes in venice
4. a red sports car drifts down the canyon road and smashes a pile of cones
5. a school bus flies off a ramp into a heap of watermelons at the county fair
6. a dune buggy jumps the sand hills and crashes into a wall of tires on the beach
7. a tractor jumps the hay bales and plows through a fence on the farm
8. an ice cream truck crashes through a pyramid of crates on a rooftop in new york
9. a garbage truck smashes a tower of trash cans and jumps the bridge in the city
10. a stunt rider on a motorbike jumps three ramps through a junkyard full of old cars
11. a fire truck launches off a ramp over the river and smashes into a pile of crates at the docks
12. a go-kart jumps three ramps on a moon base and crashes into a tower of space barrels
13. a skateboarding dog ramps over the fountain and knocks down a stack of paint cans in the park
14. a delivery van does a stunt jump over the train tracks and plows through a wall of pumpkins
15. an ambulance jumps the broken bridge and smashes through a stack of hay bales in the village
16. a quad bike flies off the sand dune ramp and crashes into a pyramid of coconuts on the island
17. a taxi does daredevil jumps between skyscraper rooftops and smashes through a wall of boxes
18. a toy car races over ramps on the kitchen table and knocks over a tower of cups
19. a snowmobile jumps the ice ramp and smashes into a heap of snowmen in the mountains
20. a monster truck ramps over a row of old buses and crashes into a pile of tires in the stadium

**Nesmí** skončit ve `stunt` (podobná slova, jiná hra):
- obyčejný závod bez skoku a bourání → `voyage`: „race a sports car around the city“, „drive a rusty van through
  a rainy harbor“ (`test-200`), „a speedboat races between islands“;
- „a jellyfish drifts upward avoiding fishing nets“ (`test-200`) – proto „drift“ není narážka;
- „draw a ramp so the rolling apple does not fall into the river“ (dev P68 `drawsave`) – „ramp“ dá stuntu +1,
  `drawsave` musí vyhrát svým slovesem kreslení;
- „a frog jumps over logs to reach the pond“ → `platformer` („jump over“ proto není narážka).
- Hraniční: „a monster truck crushes cars in a mud arena“ (`test-200`) má narážku „monster truck“ – bourání do věcí
  sem patří; rozhodne P68-I při zapojení podle `route-before.json`.

### Narážky

`STUNT_CUES` v `src/play/genre/stunt.ts`: `stunt`, `ramp`, `jump the`, `jumps the`, `crash into`, `crashes into`,
`crash through`, `crashes through`, `smash through`, `smashes through`, `plows through`, `monster truck`,
`daredevil`, `demolition`, `race over`, `races over`. `cuePattern` ohýbá jen poslední slovo, proto obě osoby slovesa.
Nad starými sadami (`p30/test-200`, `p30/dev`, `p66/dev`) zasáhnou jen „monster truck“ v jedné větě `test-200`
(viz hraniční výše); v dev P68 cizí hry jen „ramp“ v jedné větě `drawsave`. Dokud je `stunt` v `ROUTE_PENDING`,
narážky výběr nemění (`routing-guard.test.ts` zelený, `stunt-module.test.ts` ověřuje, že klasifikátor stunt neřadí
ani na jeho vlastních dev větách).

### Parametry a meze

`STUNT_PARAM_BOUNDS`: `ramps` 2–4, `piles` 2–4, `lengthM` 200–360, `difficulty` 1–3. Mimo meze `readGenreSpec`
odmítne (test). Generátor `stunt_track` bere navíc `boxes` 3–6 (modul ho nevystavuje, výchozí 5).

### Assety

Nic nového v `public/**`. Vozidla dev vět mají model katalogu (`modelOf`: monster truck, police car, scooter, race
car, school bus, ride, tractor, garbage truck, motorbike), rampa `gen3d-ramp`, krabice `crate`.

| Soubor | Licence | Zdroj | Poznámka |
|---|---|---|---|
| – | – | – | žádný nový soubor v `public/**`; vozidla, `gen3d-ramp`, `crate` z dnešního katalogu |
| kandidát: Kenney Car Kit (45 souborů) | Creative Commons CC0 (stránka kitu, 1. 11. 2026) | https://kenney.nl/assets/car-kit | low-poly vozidla navíc (dodávka, sanitka, hasiči z vět 11–20); licenci před přidáním ověřit po souborech v archivu |
| kandidát: Kenney Racing Kit (110 souborů) | Creative Commons CC0 (stránka kitu, 1. 11. 2026) | https://kenney.nl/assets/racing-kit | rampa jako klín, mantinely, brána cíle, pneumatiky do hromad místo procedurálních |
| kandidát: Quaternius Cars Pack (8 modelů, FBX/OBJ/Blend) | CC0 (stránka balíku, 1. 11. 2026) | https://quaternius.com/packs/cars.html | závodní a městská auta; po souborech neověřeno |

Procedurální ve scéně: trať, mantinely, hromady (bedny `crate` v mřížce), prach a jiskry. Náhrada `nearest`: vozidlo,
které katalog nezná, dostane `car` (`tuning.vehicle`).

### Požadované změny sdíleného kontraktu

1. **Zapojení („zapoj stunt“).** V registru je `stuntGenre` pořád kostra (`staged`, `compile` hází), aby držel blok
   „a skeleton does not compile“ v `p68-staged.test.ts`. Hotový modul je `stuntLiveGenre` ve `stunt.ts`. Kroky:
   `stuntGenre = stuntLiveGenre` (soubor pruhu, jedna řádka – nebo import v `genre/index.ts`), odebrat `stunt`
   z `ROUTE_PENDING`, `DIRECTOR_PENDING`, `READER_PENDING` a `STAGED_CONTROLS`, buňku `stunt.default` ze
   `STAGED_PRESETS` do `PRESETS`, smazat stunt z bloku „skeleton does not compile“. Test: `stunt-module.test.ts`
   (první blok se po zapojení obrátí na `ready` + překlad).
2. **Přednačtení Rapieru podle specu.** `specNeedsPhysics` (`src/play/arcade/compile.ts`) zná `ball`, `merge`,
   `push` a věci s fyzikou, ne `stunt` – `preloadPhysics` pro stunt Rapier nenačte a `compileArcade` vrátí
   `PHYSICS_NOT_LOADED`, pokud ho nenačetl nikdo dřív (`_publish.ts` ho načítá při importu, takže hlavně první
   požadavek po startu). Prosba: `spec.control === 'stunt'` do `specNeedsPhysics`. Test: stunt spec →
   `specNeedsPhysics` true; `publishReadSpec` na čerstvém procesu projde.
3. **Věc hromad přes `tuning`** (volitelné). `tuning` nese jen čísla, booleany a řetězce do 40 znaků, generátor chce
   pole `things` → hromady jsou ve světě `crate` a věc z věty nese role `pile`. Buď pruh přidá skalární `thing`
   do `stuntTrackParams`, nebo P68-I povolí v `tuning` pole řetězců.
4. Stream `stunt` v `SUBSYSTEMS` a popisky `smash` / `air` – viz souhrn nahoře (T2, T1).

### Fixture spec

Vzorek (T3): `stunt-evidence.json` → `fixture` – `POST /api/play/games` s tělem `{ "spec": <fixture.spec>,
"seed": 1 }` (monster truck, bedny, poušť; projde branou na semínkách 1–10).

`e2e/fixtures/p68-stunt-spec.json` (T5) – týž spec, seed 1. Hraje ho `e2e/play-stunt.spec.ts` bez zapojení hry:
12/12 na `chromium`, `pixel7-touch` a `iphone-touch` (1. 11. 2026, `6272a38a`). Herní aserce z `assertions.json`
(`crosses-finish`, `one-jump`, `debris-hit` + robot vyhraje, nečinný a slabý robot prohrají) drží `stunt-bot.test.ts`
nad `stunt-trace.ts`; otisk replaye prohlížeč = Node `ec27fd3c` (`stunt-hash.json`), FPS `fps-stunt.json`.

<!-- p68-ready: stunt -->

## `minigolf`

### Popis pro režiséra a čtečku

Jedna jamka minigolfu: hráč míří, drží pro sílu a pustí – míček se kutálí po dráze s mantinely, odráží se od překážek
a zastaví se. Vyhraje, když míček spadne do jamky do limitu ran (par + 3); prohraje, když rány dojdou nebo uběhne 90 s.
Pohled přes rameno za míčkem.

Co z věty jde kam (modul `src/play/genre/minigolf.ts`, `draftFill` + `compileMinigolf`):
- **hrdina** je vždy míček (`golf ball`, model `gen3d-golf-ball`) – postava z věty („a penguin plays mini golf“) jen do
  popisku, nehraje;
- **místo** (`setting`) za `in / inside / on / at / under / across` bez golfových slov na konci („in a museum mini golf
  course“ → `museum`), jinak místo ze slovníku;
- **překážky** = věci za `with / past / around / between / through / over / behind / beside / under` (víc spojí čárka
  nebo „and“), `does: 'scenery'`. Odrazníky dostanou model první věci, kterou katalog zná (`sceneModelOf`): „cannon
  barrels“ → `cc0-barrel`, „craters and a rocket“ → `rocket`;
- **pohyblivá překážka** = věc, kterou věta hýbe („spinning windmill“, „sliding snake“, „moving coffin“, `moving /
  sliding / spinning / swinging / rolling / rotating / turning / sweeping …`) → `patrol: true` v obsazení, `params.moving 1`
  a její model;
- **tvar a par**: „L“, „zigzag“ ani „par 3“ modul ze slov nečte – nese je režisér v `params` (`bends`, `par`); bez nich
  tvar a počet odrazníků losuje stream jamky.

Pro čtečku: jedna věc obsazení s `patrol` = pohyblivá překážka; ostatní věci = odrazníky; jamka, vlajka, míček, hůl,
„course“ a „green“ nejsou věci dráhy (modul je zahodí).

### Věty pro klasifikátor

Mají skončit v `minigolf` (1–10 = `dev.json` pruhu, 11–20 nové):

1. mini golf through a volcano with lava bumpers
2. putt the golf ball past a spinning windmill on a candy island
3. a mini golf hole inside a pirate ship with cannon barrels as bumpers
4. putt a ball around the dinosaur bones in a museum mini golf course
5. minigolf on the moon with craters and a rocket blocking the hole
6. putt the ball through a castle gate and over the drawbridge
7. a crazy golf course in the jungle with logs and a sliding snake
8. sink a hole in one on a mini golf green under the sea between coral rocks
9. mini golf in a haunted house with pumpkins and a moving coffin
10. putt a golf ball across a snowy hill past the penguins to the flag
11. putt a glowing ball through a neon arcade past spinning fans
12. a par 3 mini golf hole in a candy factory with gumdrop bumpers
13. minigolf inside a space station with floating crates and a swinging robot arm
14. putt around the hay bales on a farm mini golf course
15. hole in one challenge in a toy store between wooden blocks and a rolling train
16. mini golf through a dragon cave with treasure chests in the way
17. putt the ball between snowmen at a winter mini golf park
18. a zigzag mini golf hole in a jungle temple with stone statues
19. golf ball through a haunted graveyard past tombstones and a swinging gate
20. a mini golf course on a rooftop with flower pots and a sliding air vent

NESMÍ skončit v `minigolf` (podobná slova, jiná hra):

| věta | patří | proč |
|---|---|---|
| kick the ball past the goalkeeper into the goal | míč (`ball`) | kop do branky, ne rána do jamky |
| throw the basketball into the hoop before time runs out | `throw` | hod do koše |
| shoot hoops at the fair and sink three in a row | `throw` | „sink“ bez golfu je koš |
| bonk the moles popping out of the golf course | `whack` (holdout P66 `p66-27`) | „golf course“ je tu jen místo – narážka `golf course` mu přidá bod, `whack` musí vyhrát slovesem |
| a golfer drives a cart across the golf course collecting lost balls | sbírání (`arena` collect) | jízda a sběr; totéž riziko narážky `golf course` |
| a monster truck jumps the ramp into a tower of crates | `stunt` | |
| bowl a strike down the lane | (P69C bowling) | koule do kuželek, ne jamka |

### Narážky

`cues` modulu (zatím jen seznam, klasifikátor je díky `ROUTE_PENDING` nečte; `routing-guard` pruhu zelený):
`mini golf`, `minigolf`, `putt`, `golf course`, `hole in one`, `golf ball through`.

Proč nekradou: v 200 větách `p30/test-200.json` ani v dev sadách P30 a P66 se žádná z nich nevyskytuje (sken textu
sad pod `evals/play`; v `p68/dev.json` jsou jen věty minigolfu d09–d15). Výskyty jinde, které P68-I při zapojení přepočítá:
- `p66/holdout.json` `p66-27` „bonk the moles popping out of the golf course“ (`whack`) – `golf course` dá minigolfu
  bod, sloveso `bonk` + `moles` musí dál vyhrát;
- `p62/holdout-b.json` `b20` „A golfer chips balls past sand traps and ponds on a seaside golf course“ (dnes `throw`,
  `p66/route-main.json`) – po zapojení nejspíš `minigolf`, což sedí, ale změní snímek směrování;
- `p54c/holdout.json` `h80` „mini golf in a haunted castle, sink the ball in as few shots as possible“ je tam
  `distractor` s `genre: null` (hra tehdy nebyla) – po zapojení patří `minigolf`, očekávání sady je potřeba přepsat;
- `demand/corpus.json`, `p36/depth.json`: „mini golf with windmills and loops“ – po zapojení `minigolf`.

### Parametry a meze

`paramBounds` (celá čísla v `GenreSpec.params`; `compileMinigolf` je převede na `tuning` generátoru `minigolf_course`):

| parametr | meze | do `tuning` | poznámka |
|---|---|---|---|
| `bends` | 0–2 | `shape`: 0 `straight`, 1 `L`, 2 `S` | bez něj tvar losuje stream |
| `obstacles` | 1–3 | `obstacles` | počet odrazníků; bez něj losuje stream |
| `moving` | 0–1 | `moving: true` | bez parametru 1, když věta něčím hýbe (`patrol`) |
| `par` | 2–4 | `par` | bez `bends` určí tvar (2 rovná, 3 L, 4 S); nikdy pod počet úseků trasy (`bends + 1`) |

Modely odrazníků a pohyblivé překážky jdou do `tuning.bumper` / `tuning.mover` (id katalogu z `sceneModelOf`).
Výchozí obsazení a místo: `tire-barrier` / `crate`, místo `mini golf course` (`draft.ts`).

### Assety

| Soubor | Licence | Zdroj | Poznámka |
|---|---|---|---|
| jamka (chybí v katalogu) | – | procedurální geometrie ve scéně | černý kalíšek Ø 1 m s okrajem, vlajka `finish-flag` z katalogu |
| míček | katalog | `gen3d-golf-ball` | |
| odrazníky / pohyblivá překážka | katalog | `sceneModelOf` věci z věty, výchozí `tire-barrier` / `crate` | fixture: `cc0-pumpkin`, `gen3d-coffin` |
| kandidát: Kenney Minigolf Kit (125 souborů) | Creative Commons CC0 (stránka kitu, 1. 11. 2026) | https://kenney.nl/assets/minigolf-kit | dílce dráhy (rovinka, roh, jamka, rampa, větrný mlýn) místo procedurálních; licenci před přidáním ověřit po souborech v archivu |

Nic nového v `public/**`.

### Požadované změny sdíleného kontraktu

Při „zapoj minigolf“ (vše mimo soubory pruhu):
- **Modul na `ready`.** `src/play/genre/minigolf.ts` je `staged` a jeho `compile` do té doby hází jako kostra (drží blok
  „a skeleton does not compile“ v `p68-staged.test.ts`). Zapojení přepne `availability: () => 'ready'` – `compile` pak
  volá `compileMinigolf` bez další změny – a odstraní blok kostry (odstraňuje ho i PR P68S). Test:
  `minigolf-module.test.ts` („stays staged: compile throws like the scaffold“, překlad a brána přes `compileMinigolf`).
- **Brány aktivace:** `minigolf` pryč z `ROUTE_PENDING` (`classify.ts`), `DIRECTOR_PENDING` (`director/answer-schema.ts`)
  a `STAGED_CONTROLS` (`spec.ts`, kvůli `READ_CONTROLS`). Pak přepočítat snímek směrování a sady z oddílu Narážky.
- **Popis pro čtečku** `capabilities.ts` (`minigolf`): dnes `roles: []`, `labels: []`. Prosba: `roles: ['bumper', 'mover']`,
  `labels: ['player', 'bumper', 'mover']` a do `cues` „things from the sentence are bumpers, a moving one (spinning,
  sliding) sweeps across the lane“ – role `bumper` a `mover` (`kind: 'prop'`) píše `compileMinigolf`.
- **Počty (volitelné):** `COUNT_PARAMS.minigolf` je `{}`; „with three bumpers“ by šlo vést do `obstacles`
  (`{ default: { enemy: 'obstacles' } }`), pokud P68-I chce počty z věty. Bez toho počet losuje stream.
- **Osa s `HOLD` na plátně:** míření se drží jen z tiků s `HOLD` / `TAP` (README T6); vstup `throw-rig` na plátně ji musí
  nést (`session.hold(axis)`), jinak míček letí rovně. Ověřeno v T9: vrstva `MinigolfTouch` osu nese (prst i klávesy,
  `HOLD` a `TAP` s osou > 0 v záznamu e2e).
- Přednačtení fyziky, nový efekt ani nový popisek mimo `hud-labels-request.ts` (`strokes`, `par`) potřeba není.

### Fixture spec

Vzor pro T9 (`e2e/fixtures/p68-minigolf-spec.json`): `SAMPLE` v `src/play/genre/__tests__/minigolf-module.test.ts` –
`compileMinigolf` věty „mini golf in a haunted house with pumpkins and a moving coffin“ s `bends: 1, obstacles: 3`
(dráha L, 3 odrazníky `cc0-pumpkin`, pohyblivá `gen3d-coffin`); publikační brána projde na seedech 1–10.

`e2e/fixtures/p68-minigolf-spec.json` (T9) – týž spec, seed 1. Hraje ho `e2e/play-minigolf.spec.ts` bez zapojení hry:
12/12 na `chromium`, `pixel7-touch` a `iphone-touch` (1. 11. 2026, `3d577865`). Herní aserce z `assertions.json`
(`bot-wins`, `idle-loses`, `weak-loses`, `ball-in-hole`, `strokes-counted`) drží `minigolf-bot.test.ts` nad
`minigolf-trace.ts` (30/30 jamek); otisk replaye prohlížeč = Node `43e13345` (`minigolf-hash.json`), FPS
`fps-minigolf.json`.

<!-- p68-ready: minigolf -->
