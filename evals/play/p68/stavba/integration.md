# P68-S stavba – co potřebuje zapojení (`buildshift`)

Požadavky pruhu P68-S na P68-I. Hra je hotová, až tu bude značka `p68-ready: buildshift`.

## Pitch

_(T8)_

## Sentences

_(T8: 20 vět pro klasifikátor a čtečku)_

## Cues

_(T4/T8)_

## Assets

_(T8: jen z dnešního katalogu; nový asset = požadavek s licencí a zdrojem)_

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

_(T5/T10: „Served“ a „Coins“ do `HUD_COUNTER_LABELS`; do té doby čísla ve 3D scéně)_
