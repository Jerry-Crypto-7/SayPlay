# P68-S stavba – `buildshift` (a volitelně `drawsave`)

Pruh P68-S staví hru `buildshift` (směna se stavbou obchodu) do souborů, které mu předala kostra P68-I T1.
Plán: `plans/P68S-stavba-2026-10-31.md` (mimo git). Potřeby změn sdílených souborů: `integration.md`.

## Základ větve

- **Větev stojí na `origin/main` `15c81e6a`** (kostra P68-I #61). Do 1. 11. stála na WIP commitu kostry `5005bfe3`;
  1. 11. přenesena `git rebase --onto origin/main 5005bfe3` (11 vlastních commitů). Jediný konflikt: `integration.md`
  (add/add – kostra ho založila ze šablony s „_Zatím nevyplněno._“), platí verze tohoto pruhu. Ostatní kostry
  (`pieces/buildshift*.ts`, `genre/buildshift.ts`, `BuildshiftScene.tsx`, e2e) jsou ve WIP i v #61 shodné.
  Vlastní soubory po přenosu bajt po bajtu stejné jako před ním (záloha `backup/P68S-pre-rebase-2026-11-01`).
- Strážce: `node evals/play/p68/stavba/own-files.mjs` (proti `origin/main`, 21 vlastních cest, exit 0).

## Co kostra zmrazila (čteno z `5005bfe3`)

| Co | Jméno | Soubor |
|---|---|---|
| Modul žánru | `buildshiftGenre = stagedGenre('buildshift', ['humanoid', 'animal', 'robot'])` | `src/play/genre/buildshift.ts` |
| Ovládání | `buildshiftControl` (kus `buildshift`) | `src/play/arcade/pieces/buildshift.ts` |
| Generátor úrovně | `buildshiftShop` (kus `buildshift_shop`) | `src/play/arcade/pieces/buildshift.ts` |
| Pravidla | `BUILDSHIFT_RULES` (rozbalí se do `library.ts` → `rules`) | `src/play/arcade/pieces/buildshift.ts` |
| Robot | `buildshiftBot` (kus `buildshift_bot`) | `src/play/arcade/pieces/buildshift-bot.ts` |
| Scéna | `BuildshiftScene({ scene })` (`WorldProps` bez `control`, `backdrop`) | `src/components/play/arcade/genres/buildshift/BuildshiftScene.tsx` |

- **Vstup:** `stage-registry.ts` → `buildshift: { scene: 'buildshift', input: 'lanes' }` (a `P68_INPUT.buildshift =
  'lanes'`). Klepnutí na buňku tedy funguje beze změny: scéna zapíše `data-lane-cells`, ťuk přijde jako `TAP` + osa
  buňky (`axisOfCell`).
- **Pohled:** `P68_VIEWS.buildshift = ['top']`. **Horizont:** `P68_MAX_TICKS = 5400` (90 s).
- **Verze žánru:** `genre.v7` (`GENRE_COMPILER_VERSION`, `P68_GENRE_VERSION`); chování P68 platí od ní.
- **Brána aktivace:** `ROUTE_PENDING` (klasifikátor) a `DIRECTOR_PENDING` (režisér) hru skrývají; `STAGED_CONTROLS`
  obsahuje `buildshift`. Hra jde do té doby jen ručním specem (fixture).
- **Další řádky kostry** (sdílené, jen ke čtení): `roles.ts` hrdina `robot`, `capabilities.ts` popis
  „build shop stations on the grid…“, `xr/modes.ts` `desk`/`table`, `unsupported.ts` „a shop building game“,
  `presets.ts` `buildshift.default` (`actions: ['shopbuild']`, `objective: 'score'`), role nepřítele `scenery`,
  `CONTROL_PARAMS.buildshift = z.object({}).strict()` (ovládání nemá parametry ve specu).
- **Playwright:** `play-buildshift` je v `testMatch` projektů `pixel7-touch` i `iphone-touch`; `chromium` ho nemá
  v `testIgnore`, takže běží taky. Vlastní `playwright.stavba.config.ts` není potřeba.
- `evals/play/p68/assertions.json` a šablona `integration-template.md` ve WIP kostře zatím nejsou; `integration.md`
  má proto nadpisy z plánu P68-S a sekce šablony podle plánu P68-I (fixture, značka `p68-ready`).

## Návrh hry (výchozí čísla, ladí T3)

- **Deska** 5 sloupců × 6 řad (buňky 0–29; řada 0 vzadu, řada 5 u dveří). Dveře = buňka 27, pevná přední zeď 25 a 29.
  Pod deskou **řada palety** (buňky 30–34): Oven, Counter, Shelf, ukazatel mincí, Open. Celkem 35 buněk v jedné
  `data-lane-cells`; nejvyšší osa 35 < `AXIS_MAX`.
- **Stanoviště a ceny:** pec 3 mince (peče 1 věc za 120 tiků, drží nejvýš 2), pult 2 mince (zákazníci se řadí před
  něj), police 1 mince (drží až 3 věci, zkracuje cestu).
- **Pohyb:** prodavač 40 tiků na buňku (T3: původně 20), zákazník 30 tiků na buňku; cesta = Manhattanova vzdálenost ×
  tiky na buňku. Prodavač nese jednu věc. Při 20 tikách stihl i pec v nejvzdálenějším rohu frontu výchozího cíle
  (špatné rozvržení vyhrálo 12/12), při 40 rozhoduje cesta pec → pult.
- **Mince:** start 6, obsloužený zákazník +1 (stavět jde i během směny).
- **Trpělivost:** 900 tiků (15 s) od vstupu; kdo odejde, ubere jeden ze 4 povolených odchodů.
- **Okno stavby:** nejdéle 600 tiků (10 s), pak se obchod otevře sám; dřív ťukem na Open.
- **Cíl:** obsloužit zákazníky z věty – výchozí 12, min 6, max 20. Přijde `cíl + max(4, ⌈cíl/2⌉)` zákazníků během 60 s
  po otevření, rozložení ze semínka (vlastní `pure-rand` stream).
- **Konec:** výhra = obslouženo ≥ cíl; prohra = 4 odchody nebo hodiny 88 s (pravidlo `time_limit` max 90 s by
  v horizontu 5400 tiků nevystřelilo).

## Robot a rozvržení (T3, 1. 11.)

- **Robot** (`pieces/buildshift-bot.ts`): rozvržení pravidlem `planLayout` – pult 22 (nejblíž dveřím), pec 17 vedle
  pultu, police 21 za zbylou minci, Open; během směny za 3 vydělané mince druhá pec 23. Obsluha `serveWithLayout(layout)`
  je společná pro jakékoli rozvržení.
- **Naměřeno** (`src/play/arcade/__tests__/buildshift-bot.test.ts`, 12 semínek, celý horizont): robot vyhraje 12/12 na
  cíli 6, 12 i 20 (při ladění 40/40 semínek na každém cíli 6–20, výhra nejpozději v tiku ~2680); nečinný hráč prohraje
  12/12; pec v rohu nejdál od pultu + jeden pult prohraje 12/12 s mediánem 4,5 obsloužených proti 12; stejná
  stanoviště za stejné mince, jen pec tři řady za pultem místo vedle něj: medián 9 proti 20 na cíli 20.
- **Otisk** běhů robota: `bot-runs.json`; vědomé přepsání `BUILDSHIFT_BOT_RUNS=write` při běhu testu.

## Dev věty

- `dev.json`: 20 nových vět (zákazník, zboží, cíl v mezích 6..20). Test `__tests__/dev.test.ts` kontroluje, že žádná
  není v `evals/play/p30/test-200.json` ani v jiné sadě vět pod `evals/play` – 1. 11. zelený (7/7 i se strážcem).
- Zapečetěný holdout P68-I se neotevírá ani nehledá.

## e2e T6 (1. 11.)

- `e2e/play-buildshift.spec.ts` zelený na `chromium`, `pixel7-touch`, `iphone-touch` (5 testů na projekt) proti
  `npm run build` + `next start -p 3683` (`PLAY_READER=off`, úložiště her `D:/caches/p68/stavba/store`).
- **Stavba i provoz skutečnými ťuky.** `handPlay('end')` z plánu se nepoužívá: relaci restartuje a přehraje robotovu
  vlastní stavbu, takže by stavbu prstem neověřil. Provoz proto hraje společná obsluha `serveWithLayout` nad rozvržením,
  které prst postavil; každý její ťuk jde prstem (myší na `chromium`) na buňku z `data-lane-cells`. Node vede dvojče
  hry a po každém ťuku porovná hash s prohlížečem.
- **Naměřeno (fixtura, cíl 10):** dobré rozvržení 10/10, výhra v tiku 2338 (30 ťuků obsluhy); špatné (`badLayout`, pec
  v rohu 0, jeden pult 22) 6/10 a prohra; nečinný hráč prohraje. Stejně na všech třech projektech.
- `badLayout` se přesunul z testu T3 do `pieces/buildshift-bot.ts`, aby vitest i e2e měly jednu definici.
- **Oprava kamery na šířku:** paleta ležela pod dolní řadou HUD (ťuk na Counter otevřel „Change one thing“). Rám na šířku
  teď končí nad dolním pásem hracího obdélníku; buňka na šířku telefonu 34,6–36,9 px (požadavek v `integration.md`).
- FPS (10 s, rAF, provoz bez obsluhy): `fps.json`. Snímky: `D:/caches/p68/stavba/shots/`.

## Sdílení a vyzvání T7 (1. 11.)

- Dobré rozvržení postavené prstem, výhra, sdílení → vyzvání „Beat 645 in 39.0s“. Záznam ťuků (`packInputs`) se
  v Node přehraje do stejné výhry, 10 obsloužených, stejný tik, skóre i hash; druhý prohlížeč otevře odkaz a vidí cíl.
- Stejný záznam bez ťuků stavby skončí prohrou s 0 obsloužených – trvalá aserce, že stavba je v záznamu, ne mimo něj.

## Hratelné – milník 2. 11. (stav 1. 11.)

| Co | Kontrola | Výsledek |
|---|---|---|
| Jádro (T2, T7) | `src/play/arcade/__tests__/buildshift.test.ts` | 6/6 |
| Robot a rozvržení (T3) | `src/play/arcade/__tests__/buildshift-bot.test.ts` | 8/8 |
| Modul žánru (T4) | `src/play/genre/__tests__/buildshift.test.ts` | 3/3; `draftFill` 20/20 dev vět, 20/20 projde `verifyArcade` |
| Kamera a buňky (T5, T6) | `genres/buildshift/__tests__/buildshift-camera.test.ts` | 25/25 |
| Dev věty a strážce souborů (T1) | `evals/play/p68/stavba/__tests__/{dev,own-files}.test.ts` | 2/2 + 5/5 |
| e2e stavba, provoz, sdílení, vyzvání (T6, T7) | `e2e/play-buildshift.spec.ts` | 18/18 (`chromium`, `pixel7-touch`, `iphone-touch`) |
| Robot, 12 semínek, cíl 6 / 12 / 20 | `bot-runs.json` | 12/12 výher na každém cíli; výhra v tiku medián 2028 / 2479 / 2575, nejpozději 2697 z 5400 |
| Nečinný hráč | `buildshift-bot.test.ts` | prohra 12/12 |
| Špatné rozvržení (pec v rohu, jeden pult) | `buildshift-bot.test.ts`, e2e | prohra 12/12, medián 4,5 obsloužených proti 12; e2e 6/10 |
| FPS, 10 s provozu (`fps.json`) | e2e T6 | `chromium` 59,9 FPS, p95 16,8 ms (brána ≥ 40 / ≤ 33,3); `pixel7-touch` 59,9, p95 33,3; `iphone-touch` 16 – WebKit softwarově na tomto stroji, ne iPhone |
| Snímky | `D:/caches/p68/stavba/shots/` (mimo git) | 24: stavba, otevřeno, provoz, výsledek, špatné rozvržení, vyzvání – na výšku i na šířku |

Testy vitest znovu puštěné 1. 11. při T8 (všech 49 zelených); e2e z běhu T7 (`49f87ec3`).

**Po přenosu na kostru #61 (1. 11., T9):** vlastních 6 souborů vitest + `p66-staged` + `p68-staged` 63/64 – jediná
červená je sdílený test kostry „a skeleton does not compile“ pro `buildshift` (viz Odchylky); 18 sdílených testů, které
procházejí všechny žánry (`contract`, `classify`, `dressing`, `sets`, `holdout`, `seal`, `director-*`, `p66-hash` …),
934/934; `tsc` čistý; e2e znovu nad novým buildem 18/18 na třech projektech (stejná čísla: 10/10 v tiku 2338, špatné
6/10, vyzvání 645 → výhra 10). FPS `chromium` 59,9 / p95 16,7 ms, `pixel7-touch` 59,9, `iphone-touch` 21,7.

## Odchylky od návrhu

- **Základ větve:** T1–T8 vznikly na WIP kostře P68-I `5005bfe3`, 1. 11. přeneseny na sloučenou kostru #61 – viz
  Základ větve.
- **Sdílený `p68-staged.test.ts` čeká, že `buildshift` nepřekládá** („a skeleton does not compile … until its category
  ships“) – s hotovou hrou padá právě pro `buildshift`. Soubor je P68-I, požadavek v `integration.md`.
- **Prodavač 40 tiků na buňku místo 20.** Při 20 vyhrálo i špatné rozvržení 12/12; až při 40 rozhoduje cesta pec → pult.
- **Prohra hodinami v 88 s, ne koncem horizontu** – pravidlo `time_limit` (max 90 s) by v 5400 tikách nevystřelilo.
- **Řada palety má pátou buňku s mincemi** (Oven, Counter, Shelf, Coins, Open); celkem 35 buněk jako v návrhu.
- **Provoz v e2e ťuky přes `serveWithLayout`, ne `handPlay('end')`** – ten by stavbu přehrál robotem.
- **Na šířku telefonu buňka 34,6–36,9 px, pod 44 px** (`--sp-size-touch-min`) – paleta musí ležet nad dolní řadou HUD.
  Bez změny sdíleného `play.css` to nejde opravit; požadavek v `integration.md`.
- **`availability` zůstává `staged`** do zapojení P68-I (s `ready` by žánr viděla čtečka a sdílené testy).
- **Cíl vyzvání v bodech („Beat 645“), ne v obsloužených**, a **karta „Tap to start“ na výšku zakrývá popisky palety**
  do prvního ťuku – obojí sdílené, požadavky v `integration.md`.
- **`iphone-touch` (WebKit na Windows) po změně kvality kreslí prázdné plátno** – i u šipek P66, ne scénou; e2e otevírá
  druhou orientaci rovnou v ní.
- **Vlastní `playwright.stavba.config.ts` nebyl potřeba** – kostra dala `play-buildshift` do `testMatch` obou telefonů.

## Rozhodnutí bez člověka

- 1. 11.: stavět na WIP kostře místo čekání na `origin/main` (důvod: kostra se v PR už jen dokončuje, jména jsou
  zmrazená v `p68-contract.ts`; čekání by spotřebovalo den z termínu 2. 11.).
