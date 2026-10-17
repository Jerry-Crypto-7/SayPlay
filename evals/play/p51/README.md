# P51 – finále pro všechny žánry, nepřátelé a mrtvý čas

Plán `plans/P51-finale-nepratele-mrtvy-cas-2026-10-17.md` (necommitovaný). Větev `features/P51-finale-nepratele-mrtvy-cas-2026-10-17` z `origin/main` `04700849`.

## Sady

- **`dev.json`** – 30 nových vět pro devět žánrů plánu: chodec 5 (`control:walker`), klouzání 4 (`control:glide`), míč 3 (`control:ball`), chytání 3 (`control:move_free`, generátor `arena_catch`), načasování 3 (`timing.stack`), aréna se sbíráním s díly P42 4 (`arena.collect` s `assemblyParts`), běžec 3, střílečka 2, rytmus 3. `cell` = žánr, který rychlý návrh postavil na semínku 1 (`genreOfSpec` v `p47a/finale.ts`); test to drží. Na dev sadě a panelu P45 se ladí a diagnostikuje.
- **`holdout.json`** – 60 vět, které napsal nezávislý subagent bez přístupu ke kódu, plánům a sadám. Dostal jen pravidla seznamu z `evals/play/fidelity/corpus.json` (2–4 podstatná jména, právě 1 sloveso se seznamem ovládání), tvar záznamu a rozložení skupin P45 (threat 24, everyday 15, fantasy 12, non-game 9). **SHA-256 nad LF bajty: `3b36fe64a2d7864245799f62bf91ce8a0423c45c7900c36efa640f03db321352`** (hlídá `__tests__/sets.test.ts`). Do konečného měření T11 ho čte jen test otisku a tvaru; jeho věty nikdo z P51 nečetl.
- Žádná věta dev ani holdoutu se po `normalizeSentence` neshoduje s jinou sadou `evals/play/**` (soubory do 1 MB) ani mezi sebou.
- Holdout P47A i zapečetěná sada P45 jsou otevřené; tady se na nich neladí.

## Verze

Nové hry žánru nesou `genre.v5` (`GENRE_COMPILER_VERSION`); každá změna světa P51 platí jen od `FINALE5_GENRE_VERSION` (`pieces/pacing-parts.ts`). Uložené hry hlídá `src/play/arcade/__tests__/p51-stored-v4.test.ts`: specy všech 30 vět dev sady, jak je uložila `genre.v4` (`04700849`), staví na semínkách 1–3 bajtově týž svět. Chodec, klouzání, míč a chytání `genre` nenesou vůbec (staví je `nativeSpec`) – pro ně je „uložená hra“ spec bez značky nové hry.

## Měřidlo

Gauge P47A (`p47a/finale.ts`, popis v `p47a/README.md`) se sadou P51: `P47A_SET=p51 P47A_OUT=<out> npx vitest run --config vitest.measure.mts evals/play/p47a/finale.measure.ts` zapíše `evals/play/p51/<out>.json` (dev, panel P45 a obojí). Holdout jen v T11 s `P47A_HOLDOUT=1` – otisk se ověří dřív, než se věty přečtou.

## Výchozí stav (`baseline.json`, T2)

Změřeno nad commitem T2: nová hra už nese `genre.v5`, ale nic na ni zatím nečeká, takže svět je tentýž jako na `origin/main` `04700849` (proto `compiler` v souboru říká `genre.v5`). Robot `intermediate`, semínko publikace, všechny hry hratelné (dev 30/30, panel 40/40).

| Žánr | Sada | Vět | Průběh | Důvod bez průběhu | Finále | Chování (medián) | Mrtvý čas (medián) | Stoupá |
|---|---|---|---|---|---|---|---|---|
| chodec | dev | 5 | 0 | vstup 5 | 0 | 0 | 11,32 s | 0,4 |
| klouzání | dev | 4 | 0 | vstup 4 | 0 | 0 | 2,15 s | 0 |
| míč | dev | 3 | 0 | vstup 3 | 0 | 0 | 3,35 s | 0 |
| chytání (`arena_catch`) | dev | 3 | 0 | vstup 3 | 0 | 1 | 7,02 s | 1 |
| načasování | dev | 3 | 1 | – | 0 | 0 | 2,8 s | 1 |
| aréna s díly P42 | dev | 4 | 0 | díly 4 | 0 | 1 | 7,67 s | 0,25 |
| běžec | dev | 3 | 1 | – | 1 | 3 | 5,78 s | 1 |
| střílečka | dev | 2 | 1 | – | 1 | 2 | 6,15 s | 1 |
| rytmus | dev | 3 | 1 | – | 1 | 0 | 3,62 s | 1 |
| **dev celkem** | dev | 30 | 0,37 | vstup 15, díly 4 | **0,27** | 0,5 | 5,21 s | 0,57 |
| **panel P45 celkem** | panel | 40 | 0,8 | vstup 6, díly 2 | **0,68** | 1,5 | 2,76 s | 0,85 |

- Na panelu P45 bez finále: chodec 3, klouzání 1, míč 1, chytání 1, načasování 3, poletování 2, aréna a stanoviště s díly P42 po 1. Poletování (`flap`) plán nejmenuje – průběh má, finále ne.
- Načasování průběh má (`timing_level` v `GENRE_PACING`), telemetrie u něj ale finále neuzná – důvod v plánu „`entry`“ platil pro holdout P47A, ne pro tuhle buňku.
- Běžec na dev sadě finále má 3/3 už teď; h024 z holdoutu P47A tu nemá obdobu.

## Rozhodnutí

- **T2 – verze u žánrů bez `genre`:** chodec, klouzání, míč a chytání staví `nativeSpec` bez pole `genre`, takže `genreAtLeast(spec, FINALE5_GENRE_VERSION)` pro ně nikdy neplatí. Nová hra těchto žánrů proto dostane značku nové hry v parametrech generátoru, jako řízení v P46B (`pacedNative`, `segments: true`); uložený spec bez značky staví týž svět (`p51-stored-v4.test.ts`).
