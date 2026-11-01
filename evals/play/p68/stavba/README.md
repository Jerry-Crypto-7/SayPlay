# P68-S stavba – `buildshift` (a volitelně `drawsave`)

Pruh P68-S staví hru `buildshift` (směna se stavbou obchodu) do souborů, které mu předala kostra P68-I T1.
Plán: `plans/P68S-stavba-2026-10-31.md` (mimo git). Potřeby změn sdílených souborů: `integration.md`.

## Základ větve

- **Kostra P68-I zatím není v `origin/main`** (1. 11. 07:15, `origin/main` = `688d989d`). Větev proto stojí na jejich
  lokálním WIP commitu `5005bfe3` („chore(play): WIP P68 T1 scaffold five staged games in registries“).
- Až kostra dorazí do `origin/main` (squash PR `features/P68I-scaffold`, jiné sha), vlastní commity se přenesou
  příkazem `git rebase --onto origin/main 5005bfe3`. Konflikty můžou vzniknout jen na kostrách, které tenhle pruh
  přepisuje (`pieces/buildshift*.ts`, `genre/buildshift.ts`, `BuildshiftScene.tsx`, `e2e/play-buildshift.spec.ts`),
  a na `integration.md` (kostra ho založí ze šablony – obsah se sloučí ručně). Vždy platí verze tohoto pruhu.
- Do přenosu strážce kontroluje proti WIP základu:
  `git diff --name-only 5005bfe3..HEAD | node evals/play/p68/stavba/own-files.mjs --stdin`.

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
- **Pohyb:** prodavač 20 tiků na buňku, zákazník 30 tiků na buňku; cesta = Manhattanova vzdálenost × tiky na buňku.
  Prodavač nese jednu věc.
- **Mince:** start 6, obsloužený zákazník +1 (stavět jde i během směny).
- **Trpělivost:** 900 tiků (15 s) od vstupu; kdo odejde, ubere jeden ze 4 povolených odchodů.
- **Okno stavby:** nejdéle 600 tiků (10 s), pak se obchod otevře sám; dřív ťukem na Open.
- **Cíl:** obsloužit zákazníky z věty – výchozí 12, min 6, max 20. Přijde `cíl + max(4, ⌈cíl/2⌉)` zákazníků během 60 s
  po otevření, rozložení ze semínka (vlastní `pure-rand` stream).
- **Konec:** výhra = obslouženo ≥ cíl; prohra = 4 odchody nebo hodiny 88 s (pravidlo `time_limit` max 90 s by
  v horizontu 5400 tiků nevystřelilo).

## Dev věty

- `dev.json`: 20 nových vět (zákazník, zboží, cíl v mezích 6..20). Test `__tests__/dev.test.ts` kontroluje, že žádná
  není v `evals/play/p30/test-200.json` ani v jiné sadě vět pod `evals/play` – 1. 11. zelený (7/7 i se strážcem).
- Zapečetěný holdout P68-I se neotevírá ani nehledá.

## Rozhodnutí bez člověka

- 1. 11.: stavět na WIP kostře místo čekání na `origin/main` (důvod: kostra se v PR už jen dokončuje, jména jsou
  zmrazená v `p68-contract.ts`; čekání by spotřebovalo den z termínu 2. 11.).
