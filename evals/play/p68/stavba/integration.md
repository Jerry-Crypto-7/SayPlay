# P68-S stavba – co potřebuje zapojení (`buildshift`)

Požadavky pruhu P68-S na P68-I. Hra je hotová, až tu bude značka `p68-ready: buildshift`.

## Pitch

Text pro produkt a prompty je anglicky, poznámky česky.

- **Hint for the reader (`read/prompt.ts` `MODE_HINTS`):**
  `'buildshift.default': 'you build a small shop (ovens, counters, shelves) on a grid, open it and serve customers who come for one food or drink before they walk out'`
- **Line for the director (`director/prompt.ts`):**
  `buildshift: 'build the stations of a small shop on a grid, open it and serve arriving customers their goods before the shift ends; "robots line up for pizza at my tiny diner", "serve 12 cats their milk"'`
- **Pick it when** the player runs a shop, stand, café, diner, bakery or truck and customers come to be served; the
  layout of the shop matters (oven next to the counter serves more).
- **Do not pick it when:**
  - one fixed workplace, cooking or fixing order after order with nothing to build → `quest.station`;
  - tapping things into bins of their kind → `sort.default`;
  - carrying things across a map → `quest`;
  - an economy over many days, a farm or a city → `null` (out of scope, P69).
- **Params:** `customers` 6–20, default 12 = how many customers to serve (the number in the sentence, clamped).
  Fixed: 4 walk-outs allowed (lives), shift 88 s, build phase at most 10 s, 6 start coins (oven 3, counter 2, shelf 1),
  +1 coin per served customer.
- **Roles:** `customer` (collectible, the arriving crowd), `goods` (item, what they want), hero = the shop owner.

## Sentences

**Belong here** (`evals/play/p68/stavba/dev.json`; expected customer / goods / goal, `draftFill` 20/20 exact):

| Sentence | Customer | Goods | Goal |
|---|---|---|---|
| robots line up for pizza at my tiny diner | robot | pizza | 12 |
| run a cat cafe and serve 12 cats their milk | cat | milk | 12 |
| a penguin opens a stand on the beach and sells ice cream to 15 sweaty tourists | tourist | ice cream | 15 |
| build a bakery where hungry dragons come for fresh bread | dragon | bread | 12 |
| my little taco truck has to feed 20 hungry astronauts tacos before launch | astronaut | taco | 20 |
| zombies want burgers at the midnight burger joint, serve 9 of them | zombie | burger | 9 |
| set up a lemonade stand and sell lemonade to 10 thirsty kids | kid | lemonade | 10 |
| a raccoon runs a donut shop and sleepy police dogs come for donuts | police dog | donut | 12 |
| open a sushi bar and serve sushi to 14 picky cats | cat | sushi | 14 |
| aliens order noodles at my space station noodle shop | alien | noodles | 12 |
| a busy coffee shop where 16 office workers want their morning coffee | office worker | coffee | 16 |
| run a candy store and serve 8 greedy goblins their candy | goblin | candy | 8 |
| monsters queue for cupcakes at the haunted cupcake bakery | monster | cupcake | 12 |
| my hot dog stand has to serve hot dogs to 30 football fans at halftime | football fan | hot dog | 20 |
| a fox runs a juice bar and sells fresh juice to 11 forest animals | forest animal | juice | 11 |
| pirates come for fish at the harbour fish shop | pirate | fish | 12 |
| serve tea to 7 sleepy grandmas in a cozy tea room | grandma | tea | 7 |
| ghosts drop by my spooky pie shop for a slice of pie | ghost | pie | 12 |
| run the school canteen and give lunch to 18 noisy students | student | lunch | 18 |
| dinosaurs crowd my ice cream parlour wanting milkshakes, serve 3 of them | dinosaur | milkshake | 6 |

**Do not belong here** (návrh pro stráž žánru, neověřeno klasifikátorem):

| Sentence | Where it belongs |
|---|---|
| a chef cooks burgers at one grill, order after order | `quest.station` |
| sort the fruit into crates at the market stall | `sort.default` |
| deliver pizzas across town on a scooter | `quest` (spatial) |
| build a city and manage its money for ten years | `null` (city management) |
| catch falling donuts in a basket outside the bakery | `catch.default` |

## Cues

- **Module (`buildshift.ts`):** `shop`, `diner`, `cafe`, `café`, `bakery`, `restaurant`, `serve`, `customers`, `run a`.
- **Collisions to check in the route guard (inference, not measured):**
  - `shop` – the `sort` fixture plays in a "toy shop"; a sentence with the verb sort must stay in `sort`;
  - `serve` – tennis or volleyball "serve" is a ball game, not a shop;
  - `bakery`, `cafe` – a setting in other genres too ("catch donuts outside the bakery").
- **Do not take:** `cook`, `order`, `grill`, `stove` (`quest.station`), `sort`, `bins` (`sort`), `deliver` (`quest`),
  `catch` (`catch`), `build` alone (too wide), `manage` (out of scope).

## Assets

No new files in `public/`. Models from today's catalog only:

| Model | Used for | License | Source |
|---|---|---|---|
| `cc0-oven` | oven | CC0-1.0 | Quaternius Sushi Restaurant Kit |
| `gen3d-checkout-counter` | counter | LicenseRef-Worldsmith-Generated | ops/gen3d |
| `gen3d-bread-rack` | shelf, back wall | LicenseRef-Worldsmith-Generated | ops/gen3d |
| `cc0-kitchencabinet` | back wall | CC0-1.0 | KayKit Restaurant Bits 1.0 |
| hero and customer models | seller, customers, goods | as in the catalog (picked by the sentence label) | – |

The counter model reads as a dark blob from above (T6 screenshots) – polish in T10 within the catalog.

## Fixture spec

`e2e/fixtures/p68-buildshift-spec.json` – překlad modulu pro „robots want pizza in a tiny diner“, hrdina chef, cíl 10
(test `src/play/genre/__tests__/buildshift.test.ts` hlídá, že fixtura = překlad, a otisk světa `ad6da927`).

## Contract needs

Z kontroly kostry `5005bfe3` (T1):

- **Žádná změna kontraktu není potřeba ke hraní.** Vstup `lanes` nese stavbu i provoz (ťuk + osa buňky), pohled `top`
  je povolený, horizont 5400 tiků stačí, `CONTROL_PARAMS.buildshift` bez parametrů vyhovuje (cíl jde přes generátor).
- **Zapnutí = jeden řádek v modulu.** `buildshiftGenre.availability` vrací `staged`, dokud hru nezapojí „zapoj
  buildshift“; ta ho přepne na `ready` (soubor `src/play/genre/buildshift.ts`). Důvod: s `ready` by žánr viděla čtečka
  (`READER_PENDING` v `read/schema.ts` hry P68 nemá) a sdílené testy „každý žánr, který hraje“ (`contract.test.ts` –
  vzorek, `dressing.test.ts`, `p66-staged.test.ts` – pořadí klasifikátoru) by chtěly vzorek, oblečení a řádek, které
  patří zapojení.
- **Počet zákazníků z věty.** `COUNT_PARAMS.buildshift` je `{}`, takže počet ze čtečky (`counts`) se do hry nedostane;
  rychlý návrh ho čte sám (`params.customers`). Žádost: `buildshift: { default: { collectible: 'customers' } }`.
- **Registrace a projekty – beze změny.** `stage-registry.ts` `buildshift: { scene: 'buildshift', input: 'lanes' }`
  a `testMatch` projektů `pixel7-touch` a `iphone-touch` (`play-buildshift`) z kostry sedí; e2e běží na všech třech.
- **Čtečka (`read/prompt.ts` ~ř. 114):** věta „genre is null when … managing a shop, farm or city“ dnes posílá každou
  směnu v obchodě na `null`. Změnit na „… managing a farm or a city, or a shop over many days“ a přidat řádek
  `buildshift.default` z Pitch do `MODE_HINTS` (pořadí v `MODE_ORDER` před `quest.station`, ať „serve customers in my
  diner“ nevezme stanoviště). Plus `READER_PENDING` / `ready` podle bodu „Zapnutí“ výše.
- **Režisér (`director/prompt.ts`):** řádek `buildshift` z Pitch; vyjmout z `DIRECTOR_PENDING`.
- **Rychlá hra (`draft/draft.ts`):** `GENRE_SETTING.buildshift` je `'shopping street'` – obchod je uvnitř; navrhuji
  `'cozy diner'`. `TEMPLATE_TITLE` už `shift` zná (titulek modulu „<Goods> Shift“). Sloveso řádku a výsledkové karty
  viz HUD labels.
- **Kostra je v `origin/main`** (#61, `15c81e6a`); větev na ni přenesena 1. 11. (README → Základ větve).

Po přenosu na sloučenou kostru #61 (1. 11.):

- **Sdílený test kostry zčervená, jakmile hra dorazí.** `src/play/genre/__tests__/p68-staged.test.ts` „a skeleton
  does not compile: the game exists only as a hand-written spec until its category ships“ čeká u všech pěti her, že
  `compile` hodí `/not live/`. Hotový modul `buildshift` překládá, takže test padá právě pro `buildshift` (jediná
  červená z 64 cílených testů; 934/934 sdílených testů přes žánry zelených). Soubor patří P68-I. Žádost: v tom testu
  smyčku omezit na hry, jejichž kategorie ještě nedodala (bez `buildshift`), nejpozději se sloučením tohoto PR.
- **`p68-roundtrip.test.ts` (z #65) je pro `buildshift` červený už na `main` po #65.** `vitest.config.mts:45` pouští
  všechny testy s `VERCEL_ENV=production`, a stráž nezapojených her (`_publish.ts:194-196`) proto ruční spec
  `e2e/fixtures/p68-buildshift-spec.json` odmítne s 422 „this game type is not live yet“. Test hru přeskakuje jen
  u kostry (`blockerOf`), hotový modul ho tedy pustí přímo na vlastní stráž. #66 to nezpůsobil (odmítnutí padne před
  prvním tikem jádra). Soubor patří P68-I. Žádost: v kole publikace nastavit `VERCEL_ENV` na `preview` (např.
  `vi.stubEnv`), nebo hry z `ROUTE_PENDING` přeskakovat do „zapoj X“. Stejně narazí každá další kategorie, která dodá.
- **`READER_PENDING` už hry P68 obsahuje** (`read/schema.ts:41`) a test kostry říká, že kategorie smí modul přepnout na
  `ready` dřív. Modul přesto zůstává `staged` (opatrnější čtení; `contract.test.ts`, `dressing.test.ts` a
  `p66-staged.test.ts` se s `ready` nezkoušely). Přepnutí na `ready` zůstává jednořádková součást „zapoj buildshift“.

Z e2e T6 (`e2e/play-buildshift.spec.ts`, 1. 11.):

- **Dolní řada HUD na šířku telefonu bere paletě místo.** `.play-hud-bottom` (Restart, „Change one thing“, sdílení;
  `--_bottom` 16 px + `--_row` 58 px, `play.css`) vede přes celou šířku i na šířku. Paleta proto leží nad ní (oprava
  T6 v `buildshift-camera.ts`; dřív ji řada zakrývala a ťuk na Counter otevřel „Change one thing“) a 7 řad mřížky se na
  šířku telefonu vejde jen po **34,6 px (iPhone 15 na šířku, 734 × 343) a 36,9 px (Pixel 7 na šířku, 863 × 360)**, pod
  `--sp-size-touch-min` 44 px. Žádost: na šířku (`aspect ≥ 1`, výška < ~420 px) dát dolní řadu do pravého sloupce
  vedle desky (sloupec mezi rohy HUD je u `buildshift` volný do stran), nebo ji pro hry s `input: 'lanes'` a mřížkou
  zúžit na kola. Pak kamera vrátí `wideFrame` na celou výšku a buňka vyjde ≥ 44 px (stačí 7 × 44 + 16 = 324 px).
- **Řádek slovesa říká „Grab the robots!“.** `action-cue/verb-line.ts` bere sloveso z `objective.kind: collect`; u směny
  v obchodě zákazníky obsluhuješ, ne sbíráš. Žádost: sloveso `serve` (nebo přebití žánrem) → „Serve the robots!“. Totéž
  výsledková karta („All 10 collected in 39.0s.“) a skrytý popisek pilulky („collected“) → „served“.
- **WebKit (Playwright `iphone-touch` na Windows) po změně úrovně kvality kreslí prázdné plátno.** Jakmile hlídač
  kvality shodí post-processing na `["aces"]` (běžící hodiny, nebo otočení okna za běhu), scéna zmizí a zůstane jen
  obloha sady a HUD; hra dál běží (hash, ťuky i stavba sedí). Stejně u šipek P66 (`p66-arrows-spec.json`), takže to
  není scéna `buildshift`. Chromium (`chromium`, `pixel7-touch`) kreslí dál. Zda to dělá i skutečný iPhone, z tohoto
  stroje nejde poznat. e2e proto druhou orientaci otevírá rovnou v ní a snímek `iphone-touch-service-live-portrait.png`
  je prázdný. Medián na WebKitu 16 FPS (`fps.json`) je software render tohoto stroje, ne iPhone.

Ze sdílení a vyzvání T7 (`e2e/play-buildshift.spec.ts`, 1. 11.):

- **Cíl vyzvání je v bodech, ne v obsloužených.** Kamarád uvidí „Beat 645 in 39.0s“ (`play-dare-goal`, skóre z
  `COUNTER.score`); v obchodě ale hráč počítá obsloužené zákazníky a 645 mu nic neřekne. Přehrání sedí (výhra, 10
  obsloužených, stejný hash). Žádost: u her, kde výhru dělá počet (`objective` s cílem, u `buildshift` obsloužení),
  ukázat cíl jako „Serve 10 in 39.0s“ / „Beat 10 served in 39.0s“; body nechat jen hrám bez počtu.
- **Karta „Tap to start“ na výšku zakrývá popisky palety** (Oven, Counter, Shelf) až do prvního ťuku. Hráč tak před
  startem nevidí, co bude stavět. Žádost: na výšku kartu u her s `input: 'lanes'` posadit nad desku (horní třetina
  hracího obdélníku), nebo ji zprůhlednit nad dolním pásem `data-lane-cells`.

## HUD labels

- **Request:** add `served` and `coins` to `HUD_COUNTER_LABELS` (`e2e/hud-labels.ts`). Until then the scene draws
  „Served n/goal“ (sign on the wall cell 25) and „Coins n“ (palette cell 33) in WebGL, outside the DOM HUD.
- **Verb line and result card:** today „Grab the robots!“ and „All 10 collected in 39.0s.“ (from `objective.kind:
  collect`). Wanted: „Serve the robots!“ and „All 10 served in 39.0s.“ (hidden pill label `served`).
- **Text the game shows (English, `11-voice-copy.md`):**
  - palette: „Oven“, „Counter“, „Shelf“ with the price badge, „Coins“, „Open“ (the one tomato action, build phase only);
  - title „<Goods> Shift“ (fallback „Shop Shift“), goal line „Serve 12 robots their pizza!“;
  - controls hint „Pick a station, tap a tile to build, tap Open. Then oven, counter!“.

<!-- p68-ready: buildshift -->

p68-ready: buildshift

---

# P68-S stavba – co potřebuje zapojení (`drawsave`)

Volitelná druhá hra pruhu (T12–T14, 1. 11.). Hotová, až tu bude značka `p68-ready: drawsave`.

## Pitch (drawsave)

- **Hint for the reader (`read/prompt.ts` `MODE_HINTS`):**
  `'drawsave.default': 'you draw a few lines with your finger on a side-view board; then things fall, bounce off your lines, and the character you protect must survive 10 seconds'`
- **Line for the director (`director/prompt.ts`):**
  `drawsave: 'draw lines to shield a character from falling things for 10 seconds; "draw a line to save the puppy from falling rocks", "shield the frog from fifteen hailstones"'`
- **Pick it when** something falls on or rains down on a character and the player protects it by drawing a line, wall
  or roof.
- **Do not pick it when** the player catches the falling things (`catch`), moves the hero to dodge them, shoots or
  slices them, or builds defences over many waves (`defense`).
- **Params:** `threats` 1–30, default 10 = how many things fall (the number in the sentence, clamped). Fixed: drawing
  6 s or until the ink runs out (10 cells, at most 12 segments), then 10 s of falling; one hit loses, no lives.
- **Roles:** hero = the protected character, `threat` (hazard, label from the sentence, count = `threats`).

## Sentences (drawsave)

**Belong here** (`evals/play/p68/stavba/dev-drawsave.json`; `draftFill` 10/10 exact):

| Sentence | Protected | Threat | Count |
|---|---|---|---|
| draw a line to save the puppy from falling rocks | puppy | rock | 10 |
| protect the sleeping cat from a rain of meteors | cat | meteor | 10 |
| draw walls so the little chick survives 20 falling bombs | chick | bomb | 20 |
| help the hamster survive an asteroid shower | hamster | asteroid | 10 |
| a baby penguin is in danger, draw lines to shield it from falling icicles | penguin | icicle | 10 |
| keep the robot safe from acid drops by drawing a roof | robot | acid drop | 10 |
| draw to protect grandma from 5 falling flower pots | grandma | flower pot | 5 |
| shield the frog from fifteen hailstones | frog | hailstone | 15 |
| save the precious egg from tumbling boulders | egg | boulder | 10 |
| bees are attacking, draw a wall to save the teddy bear | teddy bear | bee | 10 |

**Belong elsewhere** (expected route – inference, the classifier was not run on them):

| Sentence | Route |
|---|---|
| catch the falling apples in a basket | `catch.default` |
| slice the fruit flying across the screen | `slice` |
| whack the moles before they hide | `whack` |
| build towers to stop the zombie waves | `defense` |
| shoot down the meteors before they hit the city | `shooter` |
| robots line up for pizza at my tiny diner | `buildshift` |
| draw a picture of my cat | `null` (a drawing app, no game) |
| paint the walls of my house blue | `null` |
| save the princess from the dragon's castle | `quest` |
| a puppy runs and jumps over falling rocks | runner / platformer (the hero moves) |

## Cues (drawsave)

- **Module (`drawsave.ts`):** `draw`, `line`, `protect from falling`, `save the`.
- **Collisions to check in the route guard (inference, not measured):** `line` – „robots **line** up for pizza“
  (`buildshift`); `save the` – rescue adventures (`quest`); `draw` – drawing without a threat (`null`).
- **Do not take:** `catch`, `slice`, `shoot`, `dodge`, `tower`, `wave`.

## Assets (drawsave)

No new files in `public/`. Board, lines, ink bar and threat markers are primitive geometry in brand tokens; the hero
model comes from today's catalog by the sentence label.

## Fixture spec (drawsave)

`e2e/fixtures/p68-drawsave-spec.json` – překlad modulu pro „draw a line to save the puppy from falling rocks“, 10 hrozeb
(test `src/play/genre/__tests__/drawsave.test.ts` hlídá, že fixtura = překlad a projde `readGameSpec`).

## Contract needs (drawsave)

- **Registrace a vstup – beze změny.** Kostra #61 hru registruje (`library.ts`, `stage-registry.ts` `input: 'genre'`,
  pohled `side`); vstup podle `DRAWSAVE_STROKE` (`HOLD` + buňka v ose po dobu tahu). Adaptér `DrawsaveTouch.tsx` volá
  i `session.holdButtons(HOLD)` – jádro potřebuje `HOLD` v každém tiku tahu; tvar záznamu se nemění.
- **`testMatch` – beze změny:** `play-drawsave` je v `playwright.config.ts` u všech tří projektů.
- **Zapnutí:** `drawsaveGenre.availability` vrací `staged`; přepnutí na `ready` a vyjmutí z `ROUTE_PENDING` /
  `DIRECTOR_PENDING` je součást „zapoj drawsave“.
- **`p68-roundtrip.test.ts` je pro `drawsave` červený ze stejného důvodu jako pro `buildshift`** (fixtura teď existuje,
  stráž nezapojených her pod `VERCEL_ENV=production` vrátí 422) – viz požadavek výš.
- **Časovač HUD počítá nahoru:** `limitOf` v `ArcadePlay.tsx` hru nezná. Scéna ukazuje kreslení a obranu pruhem;
  žádost: limit 16 s (6 s kreslení + 10 s obrany), nebo časovač u `drawsave` skrýt.
- **Na šířku telefonu jsou buňky 20–24 px** (na výšku 36,6–49,4 px): sdílená jmenovka hrdiny (`ArcadeStage`) zakryje
  asi 4 × 2 buňky a dolní řada HUD bere desce místo – stejná žádost jako u palety `buildshift`.
- **`draftRoles` čte „in danger“ jako prostředí** („a penguin is in danger“ → setting „danger“). Modul to obchází,
  oprava patří do sdíleného `draftRoles`.
- **Otevřené pro lidskou zkoušku (P59′):** Chromium po rychlém tahu někdy spolkne další ťuk (klik nevznikne) – e2e
  nechává prst 150 ms v klidu před zvednutím; kreslení klávesnicí zatím chybí (`12-accessibility.md`).

## HUD labels (drawsave)

- **Text the game shows (English, `11-voice-copy.md`):** goal line „Draw lines to shield the <hero> from <n> falling
  <threats> for 10 seconds.“ (shorter fallbacks under 120 characters); the scene itself shows no text.

<!-- p68-ready: drawsave -->

p68-ready: drawsave
