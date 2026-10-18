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

## T3 – chodec a klouzání (`t3.json`)

| Žánr | Sada | Vět | Průběh | Finále | Mrtvý čas (medián) | Stoupá |
|---|---|---|---|---|---|---|
| chodec | dev | 5 | 5 | **5/5** (cíl ≥ 4/5) | 17,2 s (dřív 11,32 s) | 1 |
| klouzání | dev | 4 | 4 | **4/4** (cíl ≥ 3/4) | 2,15 s | 1 |
| chodec | panel | 3 | 3 | 3/3 | 18,12 s | 1 |
| klouzání | panel | 1 | 1 | 1/1 | 2,15 s | 1 |
| **dev celkem** | dev | 30 | 0,67 | **0,57** (dřív 0,27) | 5,21 s | 0,8 |
| **panel P45 celkem** | panel | 40 | 0,9 | **0,78** (dřív 0,68) | 2,76 s | 0,93 |

- Finále obou žánrů telemetrie uzná jako `climax`, ne `boss`. Brány v každé živé buňce (7 chodce, 8 klouzání × 12 semínek) drží: `p51-walker-glide.test.ts`.
- **Mrtvý čas chodce se zhoršil** (11,3 → 17,2 s): cesta k nejvzdálenějšímu východu je delší a jiskry leží jen na jejích posledních 8 polích. Řeší T7 (heartbeat chodce), tady se cíl 4 s nehonil.

## T4 – míč, chytání a načasování (`t4.json`)

| Žánr | Sada | Vět | Průběh | Finále | Mrtvý čas (medián) | Stoupá |
|---|---|---|---|---|---|---|
| míč | dev | 3 | 3 | **2/3** (boss) | 4,02 s (dřív 3,35 s) | 0,67 |
| chytání | dev | 3 | 3 | **3/3** (boss) | 14,92 s (dřív 7,02 s) | 1 |
| načasování | dev | 3 | 3 | **3/3** (`climax`) | 1,25 s (dřív 2,8 s) | 1 |
| míč, chytání, načasování | panel | 5 | 5 | 5/5 | – | 1 |
| **dev celkem** | dev | 30 | 0,87 | **0,83** (po T3 0,57) | 5,21 s | 0,87 |
| **panel P45 celkem** | panel | 40 | 0,95 | **0,9** (po T3 0,78) | 2,69 s | 0,95 |

- Cíl T4 (≥ 7/9, žádný žánr 0) splněn 8/9. Bez finále zůstal b01 („a robot plays tennis…“): týmová hra (`team`) soupeře-bosse nedostane, průběh má, ale jeho finále `round` telemetrie neuzná.
- Brány v každé živé buňce (3 míče, 1 chytání, 3 načasování × 12 semínek): `p51-ball-catch-timing.test.ts`. Uložené hry: `p51-stored-v4` zelené, replay brána zelená.
- **Mrtvý čas chytání se zhoršil** (7,0 → 14,9 s): mezi třemi chyceními kořist uteče a hráč jde zpět na start. T7 chytání nemá v rozsahu – zapsáno v plánu jako nález pro T7.
- Mutace (záloha mimo repo, ne `git checkout --`): kořist bez tuhosti, soupeř míče padne po prvním zásahu, načasování nové hry na staré křivce, hodiny chytání bez rezervy → `p51-ball-catch-timing` červený; kořist-boss a soupeř bez značky nové hry, finální křivka i pro `genre.v4` → `p51-stored-v4` (a `pacing-static-b`) červený. Mutant „bez brány `segments` v `clockPaced`“ přežil, protože je ekvivalentní: spec bez `genre` pustí k průběhu jen se značkou už `pacingParts`.

## T5 – aréna s díly P42 a finále běžce (`t5.json`)

| Žánr | Sada | Vět | Průběh | Finále | Mrtvý čas (medián) |
|---|---|---|---|---|---|
| aréna se sbíráním (díly P42) | dev | 4 | 4 | **3/4** (boss, dřív 0/4) | 2,33 s (dřív 7,67 s) |
| běžec | dev | 3 | 3 | **3/3** (boss) | – |
| aréna se sbíráním | panel | 3 | 3 | 3/3 (dřív 2/3, m02 s díly) | 2,4 s |
| **dev celkem** | dev | 30 | 1 | **0,93** (po T4 0,83) | 4,07 s (po T4 5,21 s) |
| **panel P45 celkem** | panel | 40 | 1 | **0,93** (po T4 0,9) | 2,5 s |

- Cíl T5 splněn: arény s díly 3/4 (≥ 3/4), běžec 3/3. Bez finále zůstala a04 („a kid catches falling leaves…“): na publikovaném semínku robot prohraje u bosse vedle překážky dílu; na semínkách 1–12 vyhraje 12/12 s bossem.
- **Běžec h024:** boss se nenarodil – hejno pěti těl těsně před ním zaplnilo `maxActors` (12) a boss „se nevešel“. Boss nové hry (`genre.v5`, parametr pravidla `bossRoom`) přijde i do plna a má vlastní slot navíc; buňky běžce beze změny. Na h024 (otevřený holdout P47A) se jen diagnostikovalo.
- **Aréna s díly:** ve `genre.v5` dostane průběh (`arena_collect`, `ownShape(…, parts)`), kromě dílu `chaser`. Měřeno na 12 semínkách: bez průběhu intermediate 12/12 a finále 0–1/12; s průběhem bez dalšího zásahu jen 9/12 (a01, a04) – robot dílů nevidí dopadlou překážku dílu `hazard` a s bossem a chováními u ní ztrácel životy (a01 semínko 2: všechna tři zranění u ní). Robot arény s průběhem ji proto obchází (`HAZARD_SKIRT`): a01 12/12, a02 12/12, a03 11/12, a04 12/12, vše s bossem.
- **Sonda svědka překážky:** s průběhem se vazba role překážky z věty (`bindRoles` podle kódu role) chytí i předloh nepřátel průběhu, které leží před dílem; sonda (jedna na roli) šla po nepříteli a svědek `hazard` dílu chyběl (`assembly-parts` „roam moving hazard“ červený). Sonda teď míří nejdřív na tělo, které je ve scéně od startu (`witnessRuns`); u her bez dílů leží tělesa úrovně vždy před předlohami, takže se tam nic nemění.
- Brány: `p51-assembly-runner.test.ts` (boss do plného stropu na ručním světě; a01 a a03 × 12 semínek: nečinný nevyhraje, přehrání = hash, intermediate ≥ 0,8, každá výhra s bossem; díl `chaser` a uložená `genre.v4` aréna s díly bez průběhu). Cílená sada (51 souborů svědků a věrnosti + průběh, díly, P51, replay brána): 3064/3068 – 4 červené `ball.score+rival` (`allowed.test.ts`, `ball-recipes.test.ts`) padají stejně i na kódu před T5 (způsobil T4), zapsané v plánu jako nález.
- Začátečník na arénách s díly: a01 7/12, a02 11/12, a03 5/12, a04 7/12 – a02 nad pásmem 0,3–0,7 (před T5 12/12 u všech čtyř); věty s díly nejsou živé buňky, test pásmo nehlídá.
- Mutace (záloha mimo repo): boss bez `bossRoom` → pin bosse červený; aréna s díly bez průběhu → a01 a pin „`genre.v4`/`chaser`“ červené; průběh i s dílem `chaser` → týž pin červený; robot bez obcházení překážky → a01 červený (9/12); sonda bez pořadí → `assembly-parts` „roam moving hazard“ červený.

## Rozhodnutí

- **T2 – verze u žánrů bez `genre`:** chodec, klouzání, míč a chytání staví `nativeSpec` bez pole `genre`, takže `genreAtLeast(spec, FINALE5_GENRE_VERSION)` pro ně nikdy neplatí. Nová hra těchto žánrů proto dostane značku nové hry v parametrech generátoru, jako řízení v P46B (`pacedNative`, `segments: true`); uložený spec bez značky staví týž svět (`p51-stored-v4.test.ts`).
- **T3 – značka nové hry:** `controlParams.segments: true` zapisuje `nativeSpec` (třetí parametr `paced`); hra s díly P42 ji nedostane (`compileAssembly`, `parts.length === 0`), takže její trať zůstává.
- **T3 – finále chodce je spěch, ne strážce:** těla chování projdou zdmi bludiště (pevná tělesa zastaví jen hráče) a uhnutí v rovině posílá kód směru arény, který `walker` čte jako rychlost v ose x – boss by v chodbách nefungoval. Východ je proto v nejvzdálenější buňce a na posledních 8 polích cesty leží jiskry přes celou chodbu (`WALKER_FINALE`), takže je hráč na cestě sebere vždy; hodiny mají rezervu 51 tiků (bez ní začátečník 0/12, s ní 5/12). Ve scéně se jiskra kreslí krystalem (`spark-lod1.glb` neexistuje).
- **T3 – finále klouzání je tunel:** výchozí trať nové hry 300 m místo 160 m (na 15 s by posledních 10 s byly dvě třetiny běhu), posledních 110 m kruhy po 8 m (`GLIDE_FINALE`). S doplňkem střelby má terč každý kruh tunelu (jinak finále 3/12); u akcí hrdiny ne – nepřítel po 44 tikách přijde dřív, než se výpad dobije (60 tiků).
- **T4 – finále míče je soupeř za terči:** soupeř-boss se 3 HP (`BALL_FINALE`) chodí kyvadlem brankáře za nejvzdálenějším terčem, míč jím projde; výhra až po všech terčích a třetím zásahu soupeře. Hodiny nové hry dostanou navíc čas na 4 střely (`ballFinaleSeconds`, 3 + 1 rezervní) – bez rezervy `ball.score+rival` 0/12.
- **T4 – u míče brána hlídá jen dolní mez začátečníka:** začátečník vyhraje 12/12 ve všech třech buňkách (před T4 7/12, 9/12, 9/12) – od intermediate se liší jen pomalejší reakcí (≤ 1,5 s za běh), takže pásmo 0,3–0,7 by držely jen hodiny pár desetin sekundy nad během intermediate, a to by na jiných větách neobstálo. Test proto u míče hlídá novice ≥ 0,3, horní mez jen u chytání.
- **T4 – finále chytání je kořist na tři chycení:** první dvě chycení jí uberou HP a hráče vrátí na start, třetí vyhraje (`CATCH_FINALE`); hodiny 430 % `catchSeconds` (47 s u buňky `roam.catch`): 33 s → intermediate 6/12, 44 s → novice 4/12, 47 s → intermediate 12/12, novice 5/12.
- **T4 – finále načasování je posledních 20 kol rychlostí 100:** plynulá křivka P45C dá konec nejvýš ~1,3× hustší, telemetrie chce 1,5× (`climax`). Nová hra (`genre.v5`) hraje první část rychlostí prvního kola a posledních 20 kol rychle (`TIMING_FINALE`); 19 kol → začátečník 3/12, 22 → 11/12.
- **T4 – ohlášení finále `round` ve scéně** (míč a chytání) zůstává na T9; scéna dnes `round` neohlásí.
