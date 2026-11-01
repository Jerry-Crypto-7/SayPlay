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
- **Kostra ještě není v `origin/main`.** Pruh stojí na WIP `5005bfe3`; potřebuje sloučenou kostru, aby šel PR jen
  s vlastními soubory (README → Základ větve).

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
