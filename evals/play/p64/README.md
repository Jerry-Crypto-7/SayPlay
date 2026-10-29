# P64 – hra na výšku

Kamera každého žánru má na telefonu na výšku plnit vysokou obrazovku, HUD sedět nahoře a ovládání dole pod palcem.
Tady jsou měření plánu: audit (T1), stráže, zapečetěná sada a výchozí stav `main`.

## T1 – audit, stráže, zapečetěná sada

Větev `features/P64-hra-na-vysku-2026-10-28` nad `origin/main` `e661855c`. Od `main` se liší jen sondou záběru:
`__playFrame()` vrací navíc `spread` a `camera` (`ArcadeStage.tsx`, `spreadOf`, `cameraOf`). Obojí jen čte scénu,
relace ani hash to nevidí (`__tests__/p64-probe.test.ts`).

### Jak se měří

- **Buňky** (`e2e/p64-cells.ts`): 19 žánrů jako `p61-portrait`. Je to hra z `p58a/framing-cells.json`, žánr, který
  tam chybí (plavba, sekání, dav, slučování), se složí z věty bez modelu. Navíc tři ovládání bez žánru
  (`control:steer`, `walker`, `ball`), protože jejich kamery přepisuje T5.
- **Audit** (`e2e/p64-portrait-audit.spec.ts`, `pixel7-touch` 412 × 839 a `iphone-touch` 393 × 659): robot hraje
  180 tiků ručními hodinami. Každý šestý tik se čte sonda a obdélníky DOM. Totéž na šířku pro srovnání. Výsledek je
  v `audit.json` → `results.before`, snímky 1 s a 3 s v `D:/caches/p64/audit/<telefon>/` (mimo repo).
  - `playRect` = plátno bez horního pásu (`.play-hud-progress`, `.play-hud-corner`, `.play-hud-goal`, tytéž lišty
    jako `hudBars`) a bez dolního pásu (dolní řada, štítky zón, tlačítka `--_stack`).
  - `fill` = medián svislého rozsahu hry (hrdina a všechny živé cíle a nebezpečí před kamerou) oříznutého na
    `playRect`, jako podíl jeho výšky.
  - `cropped` = podíl snímků, kde má některé tělo střed mimo plátno do stran.
  - `underHud` = podíl snímků, kde obdélník hrdiny nebo nejbližšího cíle protíná horní lištu nebo dolní ovládání.
  - `heroShare`, `foeSeen` = definice z `p61-portrait`.
- **Stráž šířky** (`e2e/p64-landscape-guard.spec.ts`, `chromium` 1280 × 720 a Pixel 7 na šířku): otisk kamery po 30,
  90 a 180 tikách se porovná s `landscape-baseline.json` do 1e-4. Otisk = poloha, kvaternion, zorné pole, poměr stran
  a projekční matice, takže chytí i `setViewOffset`. Kamera se čte, až se ustálí. Aréna, úkol, plošinovka a
  přeskákání dojíždějí 150–200 snímků.
  - Zapsáno a hned znovu porovnáno: 44 / 44 zelených dvakrát po sobě.
  - Mutace: kamera chytání o 1 % dál → stráž červená na obou projektech (odchylka 0,097). Pak vráceno.
- **Hash** (`src/components/play/arcade/__tests__/p64-hash.test.ts`): robot a nečinný hráč na 22 buňkách cestou
  dveří publikace (`compileGame`, `verifyArcade`) → `hash-baseline.json`. Robot vyhraje všude, nečinný ne, přehrání
  se shodují. Test selže při jakékoli změně výsledku, tiku nebo hashe.

Spuštění (worktree, server zvlášť, `PLAY_READER=off`):

```
npm run build
PLAY_READER=off node node_modules/next/dist/bin/next start -p 3164 -H 127.0.0.1
FALLBACK_SMOKE_URL=http://127.0.0.1:3164 P64_AUDIT=write P64_SHOTS=D:/caches/p64/audit npx playwright test e2e/p64-portrait-audit.spec.ts --project=pixel7-touch --project=iphone-touch
FALLBACK_SMOKE_URL=http://127.0.0.1:3164 npx playwright test e2e/p64-landscape-guard.spec.ts --project=chromium --project=pixel7-touch
npx vitest run src/components/play/arcade/__tests__/p64-hash.test.ts
```

Výstup Playwrightu nikdy přes `| head`: po zavření roury spadne běh na SIGPIPE. Tak v T1 přišel iPhone o poslední
čtyři buňky (`push` a tři ovládání), které se pak doměřily zvlášť.

### Audit na výšku (`before`)

Čísla jsou na výšku, `fill` i na šířku. Hrdina = podíl plochy plátna. Řádky cíle = řádky `.play-hud-goal`.

**Pixel 7** (412 × 839; `playRect` 719 px, s tlačítky vpravo 477 px, se zónami 565–583 px; horní pás 120 px = 14 %)

| buňka | fill výška / šířka | cropped | underHud | hrdina | cíl vidět | řádky cíle |
|---|---|---|---|---|---|---|
| runner | 0,52 / 0,66 | 0 | 0 | 4,3 % | 1 | 2 |
| platformer | 0,51 / 1 | 1 | 0 | 12,6 % | 1 | 3 |
| arena | 0,85 / – | 0 | 0,33 | 8,7 % | 1 | 2 |
| voyage | 0,24 / 0,32 | 0 | 0 | 9,3 % | – | 2 |
| quest | 1 / – | 1 | 0,83 | 4,3 % | 1 | 2 |
| shooter | 0,95 / 1 | 1 | 0,23 | 6,8 % | 1 | 2 |
| throw | 0,63 / 0,48 | 0 | 0 | 5,8 % | 1 | 2 |
| timing | 0,19 / 0,36 | 0 | 0 | 1,7 % | 1 | 2 |
| rhythm | 0,63 / 0,9 | 0 | 0 | 10,6 % | 1 | 3 |
| duel | 0,34 / 0,93 | 0 | 0 | 3,4 % | 1 | 2 |
| flap | 0,44 / 0,9 | 1 | 0 | 2,2 % | 1 | 2 |
| catch | 0,31 / 0,77 | 0 | 0 | 7 % | 1 | 2 |
| whack | 0,19 / 0,56 | 0 | 0 | 3 % | 1 | 2 |
| defense | 0,63 / 1 | 0 | 0 | 4,8 % | 1 | 2 |
| slice | 0,18 / 0,37 | 0 | 0 | 5,1 % | 1 | 2 |
| hop | 0,1 / 0,34 | 0 | 0 | 1,5 % | 1 | 2 |
| crowd | 0,23 / 0,34 | 0 | 0 | 4,1 % | – | 2 |
| merge | 0,17 / 0 | 0 | 1 | 5 % | – | 2 |
| push | 0,17 / 0,38 | 0 | 0 | 1,5 % | 1 | 2 |
| control:steer | 0,41 / 0,56 | 0 | 0 | 1,3 % | 1 | 2 |
| control:walker | 0,53 / 0,44 | 1 | 0 | 1 % | 1 | 2 |
| control:ball | 0,29 / 0,45 | 0 | 0 | 4,8 % | 1 | 2 |

**iPhone 15** (393 × 659; `playRect` 538 px, s tlačítky 296 px, se zónami 384 px; horní pás 121 px = 18,4 %)

| buňka | fill výška / šířka | cropped | underHud | hrdina | cíl vidět | řádky cíle |
|---|---|---|---|---|---|---|
| runner | 0,54 / 0,68 | 0 | 0 | 3,7 % | 1 | 2 |
| platformer | 0,6 / 1 | 1 | 0 | 12,2 % | 1 | 3 |
| arena | 0,84 / – | 0 | 0,23 | 7,5 % | 1 | 2 |
| voyage | 0,29 / 0,34 | 0 | 0 | 9,9 % | – | 2 |
| quest | 1 / – | 1 | 0,93 | 4,6 % | 1 | 2 |
| shooter | 0,95 / 1 | 1 | 0,5 | 6,5 % | 1 | 2 |
| throw | 0,66 / 0,5 | 0 | 0 | 4,8 % | 1 | 2 |
| timing | 0,23 / 0,37 | 0 | 0 | 2,3 % | 1 | 2 |
| rhythm | 0,7 / 0,91 | 0 | 0 | 13,6 % | 1 | 3 |
| duel | 0,4 / 0,99 | 0 | 0 | 2,8 % | 1 | 3 |
| flap | 0,46 / 0,82 | 1 | 0 | 1,8 % | 1 | 2 |
| catch | 0,4 / 0,79 | 0 | 0 | 7 % | 1 | 2 |
| whack | 0,24 / 0,52 | 0 | 0 | 3,8 % | 1 | 2 |
| defense | 0,79 / 1 | 0 | 0 | 5,3 % | 1 | 2 |
| slice | 0,23 / 0,38 | 0 | 0 | 6,3 % | 1 | 2 |
| hop | 0,13 / 0,35 | 0 | 0 | 1,9 % | 1 | 2 |
| crowd | 0,27 / 0,35 | 0 | 0 | 5,2 % | – | 2 |
| merge | 0,09 / 0 | 0 | 1 | 5,8 % | – | 2 |
| push | 0,22 / 0,38 | 0 | 0 | 1,9 % | 1 | 2 |
| control:steer | 0,43 / 0,58 | 0 | 0 | 1,1 % | 1 | 2 |
| control:walker | 0,5 / 0,42 | 1 | 0 | 0,8 % | 1 | 2 |
| control:ball | 0,3 / 0,47 | 0 | 0 | 3,9 % | 1 | 2 |

### Co z auditu plyne

Fakta z tabulek:

- **Malé (hra v úzkém pásu):** `fill` pod 0,3 na obou telefonech mají přeskákání (0,10 / 0,13), slučování
  (0,17 / 0,09), vytlačování (0,17 / 0,22), sekání (0,18 / 0,23), načasování (0,19 / 0,23), bouchání (0,19 / 0,24),
  dav (0,23 / 0,27), plavba (0,24 / 0,29) a míč (0,29 / 0,30). Chytání a souboj leží pod 0,41. Na šířku mají tytéž
  žánry 0,34–0,93.
- **Pod HUD:** slučování 1 (shazovač nahoře stojí celou dobu pod lištou cíle), úkol 0,83 / 0,93, střílečka
  0,23 / 0,50, aréna 0,33 / 0,23 (hrdina nebo cíl pod sloupcem tlačítek vpravo).
- **Uříznuté do stran (`cropped` 1):** plošinovka, úkol, střílečka, poletování a chodec. Jsou to posuvné světy, kde
  další úsek trati leží mimo záběr i na šířku (plošinovka a střílečka mají na šířku `fill` 1). U nich `cropped`
  neměří chybu kamery. Měří se `foeSeen` a u poletování dohled dopředu (T5). Deskové žánry mají `cropped` 0.
- **HUD:** pilulky nikde uříznuté nejsou. Cíl má dva řádky, u plošinovky a rytmu (a souboje na iPhonu) tři. Horní
  pás je 120 px (14 %) na Pixelu a 121 px (18,4 %) na iPhonu. Překryvy uvnitř HUD žádné.
- **Ovládání:** všechny prvky v měřených buňkách leží ve spodních 45 % výšky (štítky zón plošinovky a souboje,
  tlačítka arény a úkolu). Kroužek joysticku (aréna, úkol) v klidu vidět není. Lišta feedu na stránce hry není, její
  překryv měří až T7 ve feedu.
- **Desktop a šířka:** `fill` na šířku u arény a úkolu je `–`. Sloupec tlačítek vpravo sahá výš než spodní hrana HUD,
  takže pásový `playRect` je prázdný. Na výšku to nevadí, srovnání na šířku tam chybí.

Inference: na výšku nejvíc ztrácejí deskové žánry, jejichž kamera počítá vzdálenost ze šířky
(`šířka / (tan · aspect)`). Kamera couvne a plocha se zmenší do pásu. Honičky ztrácejí méně, protože hloubka trati
plní výšku sama.

### Rodiny a cíle pro T3–T7

Cíle platí na výšku na obou telefonech (`P64_CHECK=1`, mapa `TARGETS` v `p64-portrait-audit.spec.ts`). Pro
`heroShare` a `foeSeen` platí plán: `heroShare` ≥ 0,9 × T1, `foeSeen` ≥ T1 − 0,05.

| úloha | žánr | `fill` ≥ | `cropped` ≤ | `underHud` ≤ | poznámka |
|---|---|---|---|---|---|
| T3 | catch | 0,55 | 0 | 0,05 | |
| T3 | whack | 0,55 | 0 | 0,05 | P61: poměr výška / šířka 0,41 / 0,61 → aspoň 0,9 |
| T3 | defense | 0,6 | 0 | 0,05 | už dnes 0,63 / 0,79, nezhoršit |
| T3 | slice | 0,55 | 0 | 0,05 | |
| T3 | merge | 0,55 | 0 | 0,05 | shazovač pryč zpod HUD |
| T3 | push | 0,55 | 0 | 0,05 | drží soupeře na kraji ringu ≤ 0,9 šířky (P61) |
| T4 | hop | 0,55 | 0 | 0,05 | P61 0,62 / 0,72 → aspoň 0,9; řada překážek v horní polovině |
| T4 | crowd | 0,55 | 0 | 0,05 | trať nahoru po obrazovce |
| T4 | duel | 0,55 | 0 | 0,05 | |
| T4 | quest | 0,9 | – | 0,1 | posuvný svět; `MIN_HELD_BY_CELL['phone quest']` ≥ 0,9 |
| T4 | timing | 0,55 | 0 | 0,05 | drží `timingDistance`, `timingHeroAt` |
| T4 | rhythm | 0,6 | 0 | 0,05 | P61 0,88 / 1,00 → aspoň 0,9 |
| T5 | runner | 0,6 | 0 | 0,05 | |
| T5 | platformer | 0,6 | – | 0,05 | posuvný svět |
| T5 | flap | 0,55 | – | 0,05 | posuvný svět; dohled dopředu ≥ `main` |
| T5 | voyage | 0,45 | 0 | 0,05 | |
| T5 | shooter | 0,9 | – | 0,1 | posuvný svět |
| T5 | throw | 0,6 | 0 | 0,05 | už dnes 0,63 / 0,66 |
| T5 | arena | 0,8 | 0 | 0,1 | už má větev `Tall`; hlavně `underHud` |
| T5 | control:steer | 0,5 | 0 | 0,05 | |
| T5 | control:walker | 0,55 | – | 0,05 | posuvný svět |
| T5 | control:ball | 0,45 | 0 | 0,05 | |

- **T6 (HUD):** horní pás ≤ 18 % výšky (iPhone dnes 18,4 %), cíl nejvýš dva řádky (dnes tři u plošinovky, rytmu a
  souboje na iPhonu), žádná uříznutá pilulka na 360, 390 a 412 px.
- **T7 (ovládání):** střed každého prvku dál ve spodních 45 %. Kroužek joysticku vidět v klidu (dnes ne). Tlačítka
  arény a úkolu zmenší `playRect` z 719 na 477 px (Pixel) a z 538 na 296 px (iPhone), sloupec patří níž a užší.
  Nápověda míče pryč z levého horního rohu.

### Kde se dnes rámuje na výšku

Větve `aspect < 1`, které T5 přepíše přes `fitTall` (nezdvojit):

- `ball/camera.ts:4` `placeBall`, `glide/camera.ts:5` `placeGlide`, `walker/view.ts:7` (výška 28 m místo 20)
- `track-camera.ts:71` `placeRunner` → `placeAngled`, `track-camera.ts:133` `CHASER_VIEW.platformBehindTall`
- `World.tsx:706` plácání → `placeAngled`
- `steer/SteerScene.tsx:71` a `:104` (`VOYAGE_CAM.phone`), `shooter/ShooterRig.tsx:109` a `:118`, `throw/ThrowRig.tsx:53`
- `arena/arena-camera.ts:166–202` (`heroShareTall`, `stretchTall`, `seeTall`), `arena/ArenaScene.tsx:209` – platí dál,
  T5 sahá jen na `underHud`

Vzdálenost ze šířky (`/ (tan · aspect)`), tady se na výšku jen couvá. Mění T3 a T4:

- T3: `catch/CatchScene.tsx:188`, `whack/WhackScene.tsx:262`, `defense/DefenseScene.tsx:260`,
  `slice/SliceScene.tsx:304`, `merge/MergeScene.tsx:279`, `push/PushScene.tsx:206`
- T4: `hop/HopScene.tsx:408`, `crowd/CrowdScene.tsx:362`, `duel/DuelScene.tsx:308`, `quest/StationScene.tsx:226`,
  `rhythm/RhythmScene.tsx:145`
- Opravy P61 T6, které platí dál: `timing/TimingScene.tsx:139` `timingDistance` a `:146` `timingHeroAt`, a
  vytlačování (podíl hrdiny).

### Zapečetěná sada

`holdout.json`: 24 nových anglických vět. `p64-01` až `p64-19` je jedna věta na žánr podle klasifikátoru rychlé hry
bez modelu (`classifyGenre`). `p64-20` až `p64-24` je pět navíc pro žánry s nejhorším `fill` v auditu (průměr obou
telefonů): přeskákání, slučování, vytlačování, sekání a načasování. Žádná věta není v dosavadních sadách (p30, p56c,
p58b, p61, p62, p62-b, p63 holdout, read-set, reread-set). Hlídá to `__tests__/seal.test.ts`.

SHA-256 nad LF bajty: `77c23c1f50f1a6588eb5538a75d54d801a6b754af92394a0c64bcd01b447d624` (`seal.ts`).

Otevře se jednou v T8. Snímky `main` na ní leží v `D:/caches/p64/main-holdout/` a nesoudí se.

### Výchozí stav `main` (dev, telefon)

`main` `e661855c` ve vlastním worktree `D:/caches/p64/main`, `npm run build`, `shots.mjs serve` na portu 3165 (astra
jen pro AI verzi, režisér bez dosažitelného modelu, strop 1,25 USD). Pak `shots.mjs shoot` nad `p30/dev.json` [0..11]
do `D:/caches/p64/main-dev/` a `judge.mjs --view phone --judge claude --runs 2`. Seed 61026, souběh 1, `sheet.png`
v prázdném `mkdtemp`. Výsledek je v `baseline-dev.json`.

| strana | běh | věrnost | hrál bych | n |
|---|---|---|---|---|
| `main` rychlá | 1 | 0,475 | 0,35 | 12 |
| `main` rychlá | 2 | 0,475 | 0,35 | 12 |
| `main` po čtení | 1 | 0,45 | 0,35 | 12 |
| `main` po čtení | 2 | 0,425 | 0,325 | 12 |
| `main` hra ze čtení | 1 | 0,375 | 0,30 | 6 |
| `main` hra ze čtení | 2 | 0,375 | 0,325 | 6 |

Rozptyl dvou běhů je u rychlé hry 0 a po čtení 0,025. Placené čtení proběhlo u všech 12 vět, hra ze čtení vznikla
u 6 z nich.

### Útrata a volání

| krok | volání | USD |
|---|---|---|
| T1 `main` dev, 12 vět (`shots.mjs spend`) | 12 | 0,376 |
| T1 `main` zapečetěná sada, 24 vět (nafoceno 24 z 24) | 24 | 0,758 |
| **celkem P64** | 36 | 1,134 z 4 |

Soudce: 24 volání `claude -p` (12 vět × 2 běhy), předplatné, 0 USD. Codex 0 volání.

## T6 – HUD na výšku

Jen CSS pod `@media (max-aspect-ratio: 1/1) and (pointer: coarse) and (max-width: 1023px)` na konci `play.css` a posun
popisku jména v `NameLine.tsx` (`--_name-push`, čte se jen na telefonu na výšku). Scéna, kamera ani hash se nemění.
`Hud.tsx` a `PostRun.tsx` změnu nepotřebovaly.

- Horní pás: menší odsazení a řádek cíle písmem popisku – dva řádky 46 px místo 57, na iPhonu 393 × 659 pás ≤ 18 %.
- Pilulky o 4 px užší z každé strany: „116 shots left ♥ 3“ se na 360 px vejde vedle časovače s pauzou.
- Štítky nad hrou (ukázka robota, stav AI verze, hotový remix, živá změna) v mřížce HUD pod řádkem cíle, ne přes
  hrdinu a ne v prostřední třetině. S výsledkem jde stav AI verze nahoru doprostřed.
- Výsledek: list podle obsahu dole, menší kroky a odznak 84 px; akce přilepené dole, kde se list nevejde.

Měření `e2e/p64-portrait-hud.spec.ts` (obdélníky DOM, 22 buněk × 360 × 780, 390 × 844, 412 × 915 a výřez telefonu):

| server | `pixel7-touch` | `iphone-touch` | desktop 1280 × 720 proti referenci |
|---|---|---|---|
| `main` `e661855c` | 0 / 23 | – | shodný (reference je z `main`) |
| větev T2 + T6 | 23 / 23 | 23 / 23 | shodný |

Na `main` padá: list výsledku se posouvá (64 odečtů), akce mimo obrazovku (60), ukázka robota přes hrdinu (32),
uříznuté pilulky (22), popisek jména pod horním pásem (14). `play-phone` a `interface-language` na `chromium`
i `pixel7-touch` 20 / 20. Snímky pro oko: `D:/caches/p64/hud/final/`. Útrata 0 USD.

Hrdina v horní třetině (úkol pod lištou, shazovač slučování – `underHud` auditu T1) štítek pod pásem minout nemůže;
spec překryv jen vypíše a hlídají ho kamery T3 a T4.

```
FALLBACK_SMOKE_URL=http://127.0.0.1:3164 P64_HUD_SHOTS=D:/caches/p64/hud/final npx playwright test e2e/p64-portrait-hud.spec.ts --project=pixel7-touch --project=iphone-touch --project=chromium --workers=1
```

## T7 – ovládání palce

Jen DOM a CSS pod podmínkou T6 (`max-aspect-ratio: 1/1`, `pointer: coarse`, ≤ 1023 px) v samostatném bloku na
konci `play.css`. Vstup, scéna, kamera ani hash se nemění; `usePlayRect` (T2) zůstal, jak byl.

- **Joystick** (`TouchStick`): na výšku je kroužek vidět i v klidu, vlevo dole nad dolní řadou HUD (`--_stack`).
  Prst ho přenese pod sebe jako dřív (kdekoli na ploše), puštění ho vrátí domů. Osu dál počítá jen `useArenaInput`
  z místa dotyku: `p64-stick.test.ts` drží pro týž tah táž volání `session.hold` jako `main` (s kroužkem i bez).
- **Tlačítka** (`.play-fire`, `.play-action`, `.play-ability`): kolo 62 px (`--sp-size-control-l`, dřív 72),
  sloupec od `--_stack` odspodu podle pořadí v DOM. Zmizela díra po chybějící střelbě: tlačítko úderu nebo
  použití v aréně a úkolu leželo o kolo výš (84 px) nad prázdným místem. Čtvrté a páté kolo jde do druhého sloupce.
  Ve feedu sloupec dál stojí vlevo od lišty (`right: 72px`).
- **Zóny** plošinovky a souboje: beze změny, štítky už stály nad dolní řadou ve spodních 45 %.
- **Nápověda míče**: dřívější inline styl je teď třída `.play-ball-hint` se stejnými hodnotami. Na výšku leží
  dole nad sloupcem tlačítek (nad dolní řadou), na papíru s obrysem, jen dotyková věta, 2 řádky na obou telefonech.

Obdélníky na výšku (tik 30 hry hráče, `e2e/p64-thumb.spec.ts`):

| buňka | Pixel 7 412 × 839 | iPhone 15 393 × 659 |
|---|---|---|
| aréna, úkol: tlačítko | 596–668 → 691–753 | 416–488 → 511–573 |
| aréna, úkol: kroužek v klidu | skrytý → 657–753 | skrytý → 477–573 |
| sloupec Fire, Dash, Shield (horní hrana) | → 543 | → 363 |

Pro T3–T5 a bránu: horní hrana ovládání arény a úkolu klesla o 95 px, takže `playRect` auditu (a `usePlayRect`)
je tam vyšší – Pixel 477 → 572 px, iPhone 296 → 391 px (inference z hrany tlačítka, audit jsem na větvi T7
nepouštěl). Kroužek v `playRect` není, stojí vlevo ve stejném pásu jako tlačítko (o 34 px výš).

Měření (server `next start` na 3174, `PLAY_READER=off`, útrata 0 USD):

- `p64-thumb` (22 buněk + sloupec tří kol + míč z dílů, na výšku i na šířku, a karta souboje ve feedu):
  25 / 25 na `pixel7-touch` i `iphone-touch`. Na šířku: kroužek v klidu skrytý, kola 72 px, nápověda vlevo nahoře
  i s větou o klávesnici. Ve feedu tlačítko úderu 278–340 px, lišta od 356 (Pixel), 259–321 / 337 (iPhone).
  Proti buildu T6 bez T7 spec padá (kroužek v klidu skrytý, nápověda míče přes řádek cíle).
- `p64-stick.test.ts` 3 / 3; mutace (kroužek polkne `pointerdown`) → 2 červené, po obnově zelené.
- `play-feed-phone` 2 / 2 (nový krok: svislý tah po kroužku nahoru i dolů kartu nepřetočí ani feed neposune).
- `interface-language` 8 / 8 (`chromium`, `pixel7-touch`), `p64-portrait-hud` 47 passed / 24 skipped.
- `play-touch` 12 / 14: všech pět her gesty vyhraných na obou telefonech; padá „duel: the Quick | Full detail switch
  leaves the touch zones readable“ na obou – přepínač verze, který T6 dal na výšku do horní mřížky, se překrývá
  s kartou „Tap to start“ (Pixel: přepínač y 122–167, karta 130–222). Totéž padá na buildu T6 bez T7, T7 to
  nezpůsobil a neopravuje (kartu staví `ArcadeStage` mimo rozsah T7) – patří T6 / bráně.
  - Opraveno v `db4c0f28`: `hudBars` počítal stav AI verze za podlahu i nahoře pod cílem, takže pás karty
    (a `playRect` kamer) končil u jeho horní hrany. Prvek `floor` celý v horní půlce stage teď patří k hornímu
    pásu. `play-touch` 14 / 14 na obou telefonech.

```
FALLBACK_SMOKE_URL=http://127.0.0.1:3174 P64_THUMB_SHOTS=D:/caches/p64/t7-shots npx playwright test e2e/p64-thumb.spec.ts --project=pixel7-touch --project=iphone-touch --workers=1
npx vitest run src/components/play/arcade/__tests__/p64-stick.test.ts
```

## T4 – přeskákání, dav, souboj, úkol, načasování a rytmus na výšku

Každá změna platí jen na `camera.aspect < 1` se změřeným `playRect` (`usePlayRectRef`) a jde přes `fitTall`. Na šířku
a bez změřeného obdélníku je kamera beze změny. `track-camera.ts` `placeSide` žádný z těch šesti žánrů nepoužívá
(volá ho jen plošinovka na šířku a poletování), takže zůstal beze změny.

- **Souboj:** ring leží podél výšky obrazovky. Kamera je z boku natočená o 68° za hráče a zvednutá o 30°, pohled
  jde přes rameno. Hráč stojí vlevo dole, soupeř vpravo nahoře čelem ke kameře a povel „Dodge!“ / „Strike!“ je nad
  ním. Krabice záběru obsahuje oba bojovníky, 0,7 m nad hlavou, 0,15 m do stran a 0,4 m za hráčem. Bez té rezervy
  za hráčem zajel hrdina při zásahu pod štítky zón (`underHud` na iPhonu 0,1–0,17).
- **Rytmus:** pohled je strmější (24°) a míří 7 m za lištu místo 9 m. Lišta i se 0,2 m po stranách vyplní šířku
  plátna a 8 m pruhů před ní se vejde do `playRect`. S bodem pohledu na 9 m tlačila lišta na iPhonu ke spodní hraně
  a kamera kvůli ní couvla: lišta měla 0,107 plochy proti 0,136.
- **Přeskákání:** šíře pole v řadě hrdiny vyplní šířku plátna. Hrdina stojí v 80 % výšky `playRect`; v T1 stál
  v 57 % obrazovky a pod ním bylo 40 % trávy. Nad hrdinou jsou řady až k cíli. Náklon je 48° místo 58°, protože
  strmější pohled hrdinu zmenšil (při 62° měl 0,011 plochy proti 0,0146 v T1).
- **Dav:** stejný princip. Obě brány (±2,4 m) vyplní šířku, dav stojí v 61–66 % výšky a další brány a pily jsou
  v horní polovině. Náklon je 44°.
- **Načasování:** `timingDistance` i `timingHeroAt` zůstaly. `fitTall` bez okraje jen posune kyv, věž a cíl do
  `playRect`, takže tučňák v popředí už není useknutý spodní hranou.
- **Úkol:** `StationScene` se používá jen pro `quest_station`. Úsek pultu s hrdinou se posune nad tlačítko „Use“
  a pod HUD, do stran se záběr nemění. Bod úvodního průletu se posouvá s kamerou.

**Audit na výšku** (`P64_CHECK=1`, T1 → T4, Pixel 7 / iPhone 15). Horní pás `playRect` je po T6 nižší: na Pixelu
98 px místo 120.

| žánr | fill | hrdina (plocha) | cropped / underHud |
|---|---|---|---|
| souboj | 0,34 → 0,57 / 0,40 → 0,64 | 0,034 → 0,099 / 0,028 → 0,082 | 0 / 0 |
| rytmus | 0,63 → 0,80 / 0,70 → 0,94 | 0,106 → 0,129 / 0,136 → 0,139 | 0 / 0 |
| přeskákání | 0,10 → 0,10 / 0,13 → 0,13 | 0,0146 → 0,0140 / 0,0185 → 0,0175 | 0 / 0 |
| dav | 0,23 → 0,21 / 0,27 → 0,25 | 0,041 → 0,046 / 0,052 → 0,053 | 0 / 0 |
| načasování | 0,19 → 0,20 / 0,23 → 0,25 | 0,017 → 0,020 / 0,023 → 0,029 | 0 / 0 |
| úkol (a10) | 1 → 1 / 1 → 1 | 0,043 → 0,044 / 0,046 → 0,046 | 1 / 0,83 → 0,57, 0,93 → 0,93 |

- **P61 poměr výška / šířka:** rytmus 0,88 → 1,07 a 1,00 → 1,03, splněno. Přeskákání 0,62 → 0,61 a 0,72 → 0,69,
  cíl 0,9 nesplněn. Šířka pole dovolí na výšku nejvýš 36,7 px/m u hrdiny, na šířku má hrdina 41 px/m (kamera na
  9 m). Strop poměru je tak (36,7 / 41)² × 0,90 (poměr ploch plátna) ≈ 0,72. Na 0,9 by se pole muselo do stran
  uříznout, což rozsah plánu zakazuje (In 1: nic hratelného uříznuté do stran).
- **Úkol (nesplněno, předáno dál):** buňka a10 je `quest_spatial` a rámuje ji kamera arény (`arena-camera.ts`,
  `ArenaScene.tsx`, soubory T5), ne `StationScene`. Hrdina stojí nahoře pod HUD (`underHud` 0,57 / 0,93). Opravu
  provede T5 (`underHud` arény), případně navazující úloha. Stanoviště (`quest_station`, věta „a chef cooks pancakes
  on the stove before they burn“, mimo buňky auditu) má na výšku fill 0,55 / 0,73 a `underHud` 0 / 0.
- **Cíle `fill` v `TARGETS` byly špatně** u žánrů, kde rozsah sondy tvoří hrdina a nejvýš jedno blízké tělo a šíři
  záběru drží věc, která se musí vejít:
  - přeskákání 0,55 → 0,09: rozsah = hrdina a nejbližší vozidlo do 5 řad (`NEAR_ROWS`). Pole 10,8 m vyplní
    412 px, takže 5 řad (6 m) dá v obraze nejvýš ~5,5 m z ~20 m výšky `playRect`, tedy ≤ 0,27. Medián vozidla je
    1–2 řady, naměřeno 0,10. Na 0,55 by pole muselo být 2–5× širší než obrazovka;
  - dav 0,55 → 0,19: rozsah = jen hrdina. Brány ani pily nejsou cíl sondy a zlobr se objeví až po 3 s (`foeSeen`
    v T1 je null). Když brány vyplní šířku, má hrdina 0,21 výšky `playRect`; na 0,55 by trať musela být 2,6× širší
    než obrazovka;
  - načasování 0,55 → 0,18: rozsah = jezdec a sloupec cíle (1,6 m). Kyv ±3,5 m vyplní šířku (`timingDistance`,
    P61 T6), takže `playRect` je vysoký ~13 m a vychází ~0,2.

  Nové prahy jsou naměřená hodnota minus ~10 %, slouží jen jako pojistka proti zhoršení. Cíl plánu (`fill` 0,55)
  u těchto tří žánrů tím **splněný není**: sonda plnou výšku neumí vidět, rozhodne soudce na listech v T8 a jeho
  jediné kolo opravy.
- **Stráže:**
  - `p64-landscape-guard` 44 / 44 (`chromium` a `pixel7-touch`);
  - `p58a-framing` 20 / 20 pro souboj, úkol, rytmus, načasování a přeskákání na `chromium` (desktop i telefon,
    `phone quest` 97 % ≥ 0,9), `pixel7-touch` a `iphone-touch`;
  - `p61-portrait` 12 / 12, připíchnutá čísla se nehýbou;
  - audit 10 / 12 – červený je jen úkol (viz výš);
  - vitest `src/components/play/arcade` 1191 / 1191 (včetně hashe `p64-hash`). Náhrada Reactu v testech `ghost-slot`, `toy-duel`
    a `toy-rhythm` dostala `useContext` (vrací výchozí hodnotu kontextu), protože scény teď čtou `PlayRectContext`.
- **Mutace:** po vypnutí větve na výšku u souboje padl audit (fill 0,33 < 0,55). Po návratu ze zálohy byl znovu
  zelený (0,57).
- Snímky jsou v `D:/caches/p64/t4-shots/final/` (Pixel) a `D:/caches/p64/t4-shots/iphone/` (iPhone). Část snímků
  iPhonu vyšla prázdná i na šířku, kde se kód neměnil. Plátno tam za zátěže nenakreslilo snímek; sonda měřila
  normálně. Útrata 0 USD.

```
npm run build
PLAY_READER=off node node_modules/next/dist/bin/next start -p 3172 -H 127.0.0.1
FALLBACK_SMOKE_URL=http://127.0.0.1:3172 P64_CHECK=1 P64_SHOTS=D:/caches/p64/t4-shots/final npx playwright test e2e/p64-portrait-audit.spec.ts --grep "duel:" --project=pixel7-touch --project=iphone-touch --workers=1
FALLBACK_SMOKE_URL=http://127.0.0.1:3172 npx playwright test e2e/p64-landscape-guard.spec.ts --project=chromium --project=pixel7-touch --workers=1
```

Pro každý žánr (`hop:`, `crowd:`, `quest:`, `timing:`, `rhythm:`) jeden běh s `--grep`, nebo dočasný config
s `grep` (svislítko v argumentu přes shim `npx` neprojde). Stejně se pouštějí `p58a-framing` a `p61-portrait`.

## T3 – deskové žánry na výšku (chytání, bouchání, obrana, krájení, slučování, vytlačování)

Všech šest kamer má větev `camera.aspect < 1` s `playRect` z `PlayRectContext` a končí `fitTall`. Póza se spočítá
jen při změně obdélníku nebo poměru stran (ref ve scéně), ne v každém snímku. Na šířku a dokud `playRect` není změřený,
běží původní kód beze změny. Jádro, robot ani hash nic z toho nevidí.

- **Chytání:** kamera zepředu jako dřív. Do stran drží pět pruhů, okraj za nimi smí ven. Pád nad lapací čárou se
  natáhne do výšky `playRect`. Natažení hledá půlení: největší, při kterém kameru pořád drží šíře pruhů, nejvýš 2,6×.
  Natažený pád je mírně ohnutý (`BEND` 0,5): věc nahoře padá pomaleji a k hrdinovi zrychluje. Koruna jede s ním.
  Počet tiků pádu se nemění.
- **Bouchání:** řada děr se natočí o 1,1 rad kolem svislé osy a běží šikmo nahoru po obrazovce, sklon je 0,9 rad.
  Pořadí děr zleva doprava zůstává, takže `data-lane-edges` pro prst platí dál (díra má na prst ~50 px). Hrdina má
  na výšku vizuální měřítko 1,8. Cíle se ho nedotýkají.
- **Obrana:** jen `fitTall`, sklon zůstává. Strmější sklon 1,12 rad dal `fill` 0,74 / 0,84, ale hrdina na iPhonu
  klesl na 0,0459, tedy pod 0,9 × T1 (0,0475).
- **Krájení:** let, čára řezu, stopy čepele a půlky se natáhnou do výšky `playRect` stejně jako pád u chytání
  (nejvýš 2,2×, bez ohybu).
- **Slučování:** nádoba s dávkovačem přes `fitTall`, dávkovač vyjel zpod lišty cíle. Na výšku má vizuální měřítko
  1,25. Bez něj iPhone (výšku drží nádoba) dával 0,0421 proti 0,0582 v T1.
- **Vytlačování:** `fitTall` ring jen posadí do `playRect`. Šíře a sklon zůstávají jako v P61 T6. Sklon 70° dal
  `fill` 0,13 a hrdinu 0,0096, obojí horší.

**Audit na výšku** (`P64_CHECK=1`, 12 / 12 zelených; před → po, hrdina = `heroShare`):

| žánr | Pixel 7 `fill` | iPhone 15 `fill` | hrdina Pixel | hrdina iPhone | `underHud` | cíl `fill` |
|---|---|---|---|---|---|---|
| catch | 0,31 → 0,61 | 0,40 → 0,59 | 0,0695 → 0,0766 | 0,0695 → 0,0699 | 0 → 0 | 0,55 |
| whack | 0,19 → 0,34 | 0,24 → 0,37 | 0,0297 → 0,0602 | 0,0379 → 0,0544 | 0 → 0 | 0,55 → **0,3** |
| defense | 0,63 → 0,65 | 0,79 → 0,80 | 0,0476 → 0,0481 | 0,0528 → 0,0599 | 0 → 0 | 0,6 |
| slice | 0,18 → 0,19 | 0,23 → 0,24 | 0,0514 → 0,0593 | 0,0631 → 0,0725 | 0 → 0 | 0,55 → **0,17** |
| merge | 0,17 → 0,27 | 0,09 → 0,26 | 0,0501 → 0,0900 | 0,0582 → 0,0654 | 1 → 0 | 0,55 → **0,2** |
| push | 0,17 → 0,17 | 0,22 → 0,22 | 0,0147 → 0,0153 | 0,0188 → 0,0184 | 0 → 0 | 0,55 → **0,15** |

`cropped` 0 a `foeSeen` 1 všude. Snímky Pixelu: `D:/caches/p64/t3-shots/final2/`. Snímky iPhonu jsou i v T1 bez
plátna, protože emulace iPhonu WebGL nevyfotí.

**Cíle, které neplatily** (`TARGETS` pro čtyři žánry snížené na jistotu pod naměřenou hodnotou na obou telefonech):

- **Krájení a bouchání:** v mediánovém snímku je vidět jen hrdina, takže `fill` = výška hrdiny. Robot cíl rozsekne
  nebo trefí do ~10–15 tiků a další přijde až za 80–175 tiků. Důkaz měřením: krájení s letem nataženým 2× zůstalo na
  0,19 / 0,24 (T1 0,18 / 0,23). Bouchání při natočení 0,7 → 1,1 rad rostlo jen s hrdinou.
- **Slučování:** sonda vidí jen dávkovač. Předměty v nádobě jsou instance bez `frame` a `frameOf` matice instancí
  nečte. 0,55 by chtělo dávkovač vysoký 400 px. Opravit by to šlo jen v `ArcadeStage.tsx`, mimo soubory T3.
- **Vytlačování:** celý ring musí do šíře (soupeř na kraji ringu ≤ 0,9 šířky, P61 T6). Průměr 13 m tak zabere
  ~396 px šířky Pixelu a jeho hloubka pod sklonem 58° ~0,45 výšky `playRect`. Postavy v ringu zaberou méně.

Snížené prahy jsou jen pojistka proti zhoršení. Cíl plánu (`fill` 0,55) u bouchání, krájení, slučování a vytlačování
**splněný není**; rozhodne soudce na listech v T8 a jeho jediné kolo opravy (stejně jako u T4).

**Bouchání, poměr P61 (výška / šířka): 0,41 / 0,61 → 0,84 / 0,87, cíl 0,9 nesplněn.** Měřeno `p61-portrait`, zkoušené
kombinace (`fill` vše 0,32–0,37):

| natočení | měřítko hrdiny | Pixel 7 | iPhone 15 |
|---|---|---|---|
| 0,7 rad | 1 | 0,41 | 0,59 |
| 1,0 rad, okraj pruhu | 1,4 | 0,82 | 0,94 |
| 1,0 rad, okraj díry | 1,4 | 0,73 | 0,94 |
| 1,1 rad | 1,5 | 0,80 | 0,89 |
| **1,1 rad** | **1,8** | **0,84** | **0,87** |
| 1,0 rad | 2,0 | 0,83 | 0,77 |

Hrdina nad podlahou čitelnosti (20 % výšky, P58A) už nedorůstá. Na iPhonu drží kameru výška: větší hrdina zvětší
krabici `fitTall` a kamera couvne. Inference: pomohl by fit dvou krabic (řada hrdiny a řada děr zvlášť) v
`portrait-frame.ts`. Je to soubor T2, mimo T3, proto `FIXED` v `p61-portrait` zůstává beze změny.

**Zjištění pro T6 / T8:** štítek ukázky robota („Demo: the verified run…“, T6) leží pod řádkem cíle, ale do horního
pásu `playRect` se nepočítá. U chytání pod ním v ukázce leží koruna a začátek pádu (snímek `catch-portrait-3s`).

**Stráže:**

| stráž | výsledek |
|---|---|
| `p64-landscape-guard` (`chromium` + `pixel7-touch`) | 44 / 44 |
| `p58a-framing` + `p61-portrait`, šest žánrů, oba telefony | 20 / 20 (16 přeskočeno – jiné profily) |
| `p64-hash`, `portrait-frame` a `merge-input` (vitest) | 15 / 15 |
| mutace: kamera chytání vrácená na HEAD | audit červený na obou telefonech (0,31 / 0,38 < 0,55); po obnově zelený |

Pin `p61/portrait.json` se nehýbal. Útrata 0 USD.

```
FALLBACK_SMOKE_URL=http://127.0.0.1:3171 P64_CHECK=1 P64_SHOTS=D:/caches/p64/t3-shots/final2 npx playwright test e2e/p64-portrait-audit.spec.ts --project=pixel7-touch --project=iphone-touch --workers=1 --grep "whack:"   # po žánrech, `|` v grep nejde
FALLBACK_SMOKE_URL=http://127.0.0.1:3171 npx playwright test e2e/p64-landscape-guard.spec.ts --project=chromium --project=pixel7-touch --workers=1
```

## T5 – honičky a tratě na výšku

Vše jen pod `camera.aspect < 1`; na šířku kamery beze změny. Společný šev je `fitChase` v `track-camera.ts`: scéna
postaví pózu žánru, `fitTall` (T2) ji po ose pohledu a ose nahoru dorovná, až krabice hry leží v `playRect`
(`usePlayRectRef`), a bod pohledu jede s kamerou. Volitelný strop `most` omezí couvnutí, aby hrdina neklesl pod T1.

- **Běžec:** kamera nad osou trati (pruh ji nehýbe), sklon 22°, míří 10 m před hrdinu; krabice = tři pruhy ±2,5 m
  od pat pronásledovatele (2 m za hrdinou) po 2 m před ním. Trať běží nahoru po obrazovce.
- **Plošinovka:** tři čtvrtiny jako dřív a navíc 10° shora, míří 2 m před hrdinu; těsná krabice (na iPhonu je mezi
  HUD a zónami jen 408 px). `CHASER_VIEW.platformBehindTall` = zadní hrana krabice, 1,2 m místo 1,5.
- **Poletování:** 65° od boku místo 50° (víc zezadu), míří 2 m před ptáčka; celá výška letu do `playRect`.
- **Plavba:** `VOYAGE_CAM.phone` 5 / 5 / −1 / 8 m místo 4 / 7 / −1,6 / 6, loď do `playRect`. **Závod:** silnice
  ±5 m a 14 m dopředu. **Klouzání:** póza beze změny a fit (žádná buňka auditu ho neměří).
- **Míč:** sklon 46° místo 19°, hřiště ±3,6 m a 5,5 m dopředu. **Hod:** osa hřiště −1 až 20 m, ±0,35 m, výška 3 m.
- **Střelnice:** hráč (do stran jen on) a nejbližší terč do `playRect`, couvnutí nejvýš 1 m. **Bludiště:** ±7,2 m,
  −4 až 12 m.
- **Aréna:** beze změny (níž).
- Testy, které volají `World` jako funkci s mockovaným Reactem, dostaly `useContext` → nezměřený obdélník (6 souborů).

Audit (`P64_CHECK=1`, `fill / underHud / hero`), před = tatáž větev bez T5 (s HUD z T6):

| buňka | Pixel 7 před | Pixel 7 po | iPhone 15 před | iPhone 15 po |
|---|---|---|---|---|
| runner | 0,50 / 0 / 0,043 | 0,72 / 0 / 0,049 | 0,52 / 0 / 0,035 | 0,78 / 0 / 0,050 |
| platformer | 0,48 / 0 / 0,127 | 0,73 / 0 / 0,118 | 0,56 / 0 / 0,122 | 0,84 / 0 / 0,127 |
| flap | 0,43 / 0 / 0,022 | 0,57 / 0 / 0,064 | 0,44 / 0 / 0,018 | 0,58 / 0 / 0,049 |
| voyage | 0,25 / 0 / 0,105 | 0,26 / 0 / 0,113 | 0,26 / 0 / 0,084 | 0,28 / 0 / 0,097 |
| shooter | 0,95 / 0,23 / 0,076 | 0,97 / 0 / 0,076 | 0,95 / 0,23 / 0,063 | 0,96 / 0,23 / 0,064 |
| throw | 0,61 / 0 / 0,058 | 0,63 / 0 / 0,056 | 0,63 / 0 / 0,047 | 0,64 / 0 / 0,051 |
| arena | 0,81 / 0,23 / 0,088 | beze změny | 0,77 / 0,17 / 0,075 | beze změny |
| control:steer | 0,40 / 0 / 0,013 | 0,51 / 0 / 0,021 | 0,42 / 0 / 0,011 | 0,69 / 0 / 0,025 |
| control:walker | 0,54 / 0 / 0,0099 | 0,61 / 0 / 0,0091 | 0,52 / 0 / 0,0081 | 0,63 / 0 / 0,0104 |
| control:ball | 0,28 / 0 / 0,048 | 0,47 / 0 / 0,052 | 0,29 / 0 / 0,039 | 0,55 / 0 / 0,053 |

`cropped` u pruhů (runner, voyage, throw, steer, ball) 0 všude. Zelené na obou telefonech: runner, platformer, flap,
throw, steer, walker, ball; shooter na Pixelu.

**Nesplněno, s měřením:**

- **voyage `fill` 0,26 / 0,28 (cíl 0,45).** `spread` má ve všech 30 vzorcích jedno tělo: brány závodu jsou role
  `checkpoint`, sonda je za cíl nebere. `fill` je tak jen výška lodi a tu čitelnost drží na 21–26 % výšky plátna
  (nad 26 % ji zmenší). 0,45 by chtělo loď přes 40 % výšky a trať před ní by zmizela. Cíl nejde splnit kamerou; buď
  brány do sondy, nebo cíl kolem 0,25 – rozhodne T8.
- **arena** (Pixel `underHud` 0,23, iPhone `fill` 0,77). Zkoušený fit (hrdina a tažená hrozba do `playRect`, strop
  couvnutí 3–5 %) dal `underHud` 0,20–0,23 a hrdinu na hraně 0,9 × T1. Překryvy jsou hrozba pod lištou cíle při
  vstupu (3 vzorky) a hrdina při úderu pod tlačítkem úderu (3 vzorky): pás `playRect` je 98–597 px, tlačítko stojí
  v 597 px. Stejnou kameru má úkol (T4), proto vráceno; přeměřit po T7 (tlačítko níž).
- **shooter iPhone `underHud` 0,23 (před 0,23).** Nejbližší vrána je v 7 vzorcích o ~7 px pod lištou cíle. Vejde se,
  až když kamera couvne o ~2 m, a hrdina pak klesne na 0,048 (< 0,9 × 0,065). Strop couvnutí 1 m drží hrdinu 0,064.
- **Běžec „dřív v horní polovině“:** dohled končí mlhou 80 m od kamery – překážka je vidět 70 m před hrdinou proti
  73 m na `main` (kamera je o 2,7 m dál a výš), o 0,3 s méně. Přiblížení se ale roztáhne: překážka 18 m (2 s) před
  hrdinou leží 335 px nad jeho patami proti 259 px (Pixel) a 274 proti 204 px (iPhone). Měřeno `fitTall` nad
  obdélníky z auditu (`D:/caches/p64/t5-tools/ahead.mts`).
- **Poletování, dohled dopředu ≥ `main`:** koridor před ptáčkem v záběru 24 m proti 19,5 m (Pixel), 44 proti 24,5 m
  (iPhone). Splněno.

**Stráže:** `p64-landscape-guard` 44 / 44 (chromium, Pixel 7). `p58a-framing` a `p61-portrait` na obou telefonech
85 / 86, padl jen strážný bludiště na Pixelu (93 %); po rozšíření krabice na ±7,2 m 2 / 2. `play-hero-size` 20 / 20
(chromium, Pixel 7 přes dočasný config). `vr-enter`, `vr-diorama`, `vr-native`, `vr-hud` 25 / 25 (chromium).
`p32-voyage` (chromium) 7 / 10: tři testy „Pixel 7 with CPU 4× slower“ padají na čekání na tik 5 – stejně i proti
serveru větve bez T5 (3164), takže to není T5. Vitest `src/components/play/arcade` 1191 / 1191 (i `p64-hash`).
Mutace: `placeRunner` bez větve na výšku → audit runner červený na obou telefonech (`fill` 0,50 / 0,52); vráceno ze
zálohy, zelené. Připíchnutá čísla (`p61/portrait.json`, prahy) se nehýbala.

```
npm run build
PLAY_READER=off node node_modules/next/dist/bin/next start -p 3173 -H 127.0.0.1
FALLBACK_SMOKE_URL=http://127.0.0.1:3173 P64_CHECK=1 npx playwright test e2e/p64-portrait-audit.spec.ts --project=pixel7-touch --project=iphone-touch --workers=1
FALLBACK_SMOKE_URL=http://127.0.0.1:3173 npx playwright test e2e/p64-landscape-guard.spec.ts --project=chromium --project=pixel7-touch --workers=1
FALLBACK_SMOKE_URL=http://127.0.0.1:3173 npx playwright test e2e/p58a-framing.spec.ts e2e/p61-portrait.spec.ts --project=pixel7-touch --project=iphone-touch --workers=1
npx vitest run src/components/play/arcade --reporter=json --outputFile.json=<soubor>
```

## Po sloučení T3 + T4 + T5 + T7 (`3071efe7`)

Větev po cherry-picku T7 → T4 → T3 → T5, čistý build, `P64_CHECK=1 P64_AUDIT=write P64_PHASE=after` → `audit.json`
oddíl `after`. Zelené: 37 / 44 buněk. `p64-landscape-guard` 44 / 44, `p58a-framing` + `p61-portrait` 86 / 86 na obou
telefonech, vitest `src/components/play/arcade` 1197 / 1197.

Nesplněné cíle (Pixel 7 / iPhone 15):

| buňka | měřeno | cíl | proč |
|---|---|---|---|
| arena | `fill` 0,79 / 0,81, `underHud` 0,10 / 0,20 | 0,8 / 0,1 | po T7 je `playRect` o 95 px vyšší, týž záběr pokryje menší díl; na iPhonu cíl pod lištou cíle při vstupu |
| quest | `underHud` 0,60 / 0,93 | 0,1 | kamera arény (`quest_spatial`): hrozba u kamery stáhne bod pohledu a hrdina má temeno v NDC 0,79, lišta cíle končí v 0,77 / 0,70 |
| voyage | `fill` 0,27 / 0,28 | 0,45 | sonda bere jen loď, brány jsou `checkpoint` (T5) |
| shooter | `underHud` 0 / 0,23 | 0,1 | vrána ~7 px pod lištou cíle; vejde se až s hrdinou pod 0,9 × T1 (T5) |

Zkoušené na úkolu a aréně a vrácené (kopie v `D:/caches/p64/t5-bak/arena-band/`):

- **Pás `playRect` do řešiče arény** (`arena-camera.ts`, pevné `TALL_TOP` a hrany nahrazené změřeným pásem): úkol na
  Pixelu `underHud` 0,57 → 0, ale hrdina 0,0359 < 0,9 × T1 (0,0387); iPhone beze změny (0,93, kamera do setin stejná).
- **Posun kamery po ose nahoru**, až je temeno hrdiny pod pásem HUD (bez změny vzdálenosti): Pixel 0,57 → 0,43,
  iPhone 0,93 beze změny, hrdina beze změny.

Inference: na iPhonu úkol neřídí temeno hrdiny pod `TALL_TOP`; příčinu ukáže až sonda `framed` a `need`/`limit` ze
`arenaGoal` na tom telefonu.
