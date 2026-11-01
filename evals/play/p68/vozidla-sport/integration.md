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

_Vyplní T3._

### Věty pro klasifikátor

_Vyplní T3 (20 vět, věty, které sem nepatří)._

### Narážky

_Vyplní T3._

### Parametry a meze

_Vyplní T3 (`paramBounds`)._

### Assety

| Soubor | Licence | Zdroj | Poznámka |
|---|---|---|---|

### Požadované změny sdíleného kontraktu

_Vyplní T3–T5._

### Fixture spec

_Vyplní T5 (`e2e/fixtures/p68-stunt-spec.json`)._

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
