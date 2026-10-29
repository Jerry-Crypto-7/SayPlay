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
