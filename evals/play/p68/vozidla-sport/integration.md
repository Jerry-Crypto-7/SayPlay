# P68 – předání k zapojení: kategorie `vozidla-sport` (P68-V)

Hry `stunt` a `minigolf`. Každá hra má vlastní sekci podle `../integration-template.md` (popis, věty, narážky, assety,
požadované změny kontraktu, fixture spec) a vlastní značku `p68-ready: <id>` (HTML komentář), přidanou až když je hra
hotová. P68-I zapne každou hru zvlášť, jakmile její značka dorazí do `origin/main`.

## Hry a id

| id | Stage (`stage-registry.ts`) | vstup | pohled (`P68_VIEWS`) | stav |
|---|---|---|---|---|
| `stunt` | `scene: 'stunt'` | `steer` | `chase` | kostra (T1) |
| `minigolf` | `scene: 'minigolf'` | `throw-rig` | `shoulder` | kostra (T1) |

Kostra P68-I (`origin/main` `15c81e6a`) dala oběma hrám vstup, který plán čeká.

## Popisky HUD

Nové popisky počítadel, které `HUD_COUNTER_LABELS` (`e2e/hud-labels.ts`) nezná: `hud-labels-request.ts`
(`smash`, `air`, `strokes`, `par`). Prosba: dopsat je do sdíleného seznamu při zapojení her.

## Projekty Playwright

Kostra dopsala `play-stunt` a `play-minigolf` do `testMatch` projektů `pixel7-touch` i `iphone-touch`
(`playwright.config.ts`). Vlastní konfigurace pruhu není potřeba.

## Přednačtení fyziky

- `stunt`: bedny v hromadách jsou tělesa Rapieru (`FLAG.physics`) od tiku 0, takže `worldHasPhysics` / `preloadPhysics`
  Rapier přednačte bez změny. Hráč-auto zůstává kinematické.
- `minigolf`: Rapier se nenačítá vůbec. Spike T6 (50 ran, síly 15/35/60): koule Rapieru s celočíselným útlumem se do
  180 tiků zastavila jen 21/50 (útlum brzdí posun, ne rotaci; tření ji dál tlačí), celočíselné kutálení v jádře 50/50
  (nejdéle 119 tiků), obě verze replay 50/50 shodně. Míček se kutálí v jádře, těla dráhy jsou nepevná.

## Požadavky na sdílené soubory (souhrn)

- **Montáž dotykového adaptéru pro `steer` / `throw-rig`.** `GENRE_TOUCH` montuje adaptér jen vstupu `genre`.
  `stunt` chce vlastní palec (tah kdekoli ve spodní polovině = osa, tlačítko brzdy) a `minigolf` natažení zpět od
  míčku. Do zapojení je scéna vykreslí sama jako DOM vrstvu; prosba: registr i pro tyto dvě hry (`GENRE_TOUCH[control]`
  bez podmínky `input === 'genre'`, nebo vstup `genre`). Test: `stunt-touch.test.ts` / `minigolf-touch.test.ts`
  (gesto = tentýž `ArcadeInput` jako klávesnice).

- **Stream PRNG `stunt` v `src/sim/rng.ts`.** Prosba: připsat `'stunt'` na konec `SUBSYSTEMS` (za `rounds`). Do té
  doby si jádro `stunt` tentýž stream odvozuje samo (`jump()` od seedu hry), takže po zápisu do sdíleného seznamu se
  otisk nezmění. Test: `stunt.test.ts` („the same seed builds the same track and scatter table“) a `stunt-replay.test.ts`.
- **Popisky počítadel `minigolf`.** Rány leží v počítadle `ammo`, par v `reserve` (`strokesOf`, `parOf`); HUD je má
  ukázat jako `strokes` a `par` (`hud-labels-request.ts`), ne jako `ammo`. Řeší T8/T9; když to bez sdíleného HUD nejde,
  prosba se upřesní tady.
- **VR a `throw-rig`:** vstup `throw-rig` ve VR posílá `HOLD` bez osy míření, což minigolfu vrátí míření rovně. VR
  minigolf P68V neplánuje; při zapojení do VR (`XR_MODES`) je potřeba osa i ve VR.

_Další položky doplní T3–T10; každá s důvodem a testem._

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
"seed": 1 }` (monster truck, bedny, poušť; projde branou na semínkách 1–10). Soubor
`e2e/fixtures/p68-stunt-spec.json` založí T5.

## `minigolf`

### Popis pro režiséra a čtečku

_Vyplní T7._

### Věty pro klasifikátor

_Vyplní T7 (20 vět, věty, které sem nepatří)._

### Narážky

_Vyplní T7._

### Parametry a meze

_Vyplní T7 (`paramBounds`)._

### Assety

| Soubor | Licence | Zdroj | Poznámka |
|---|---|---|---|
| jamka (chybí v katalogu) | – | procedurální geometrie ve scéně | kandidát CC0: Kenney Minigolf Kit (licenci ověřit po souborech v T10) |

### Požadované změny sdíleného kontraktu

_Vyplní T7–T9._

### Fixture spec

_Vyplní T9 (`e2e/fixtures/p68-minigolf-spec.json`)._
