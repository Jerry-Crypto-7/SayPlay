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

## T6 – nepřátelé na stanovišti (`t6-station.json`)

| Věta (panel) | Chování | Finále | Mrtvý čas |
|---|---|---|---|
| m04 „bake cookies“ | **0 → 3** (`enemy:static+spawned`, `hazard:chase+spawned`, `hazard:roam+spawned`) | `climax` → `climax` | 1,8 → 1,5 s |
| u03 „a penguin chef stirs…“ | **0 → 2** (`enemy:static+spawned`, `hazard:roam+spawned`) | `climax` → `climax` | 1,98 → 1,98 s |
| stanoviště na panelu (medián) | 0 → 2 | 0,67 (d03 s díly P42 mimo rozsah) | 1,8 → 1,65 s |

- Nová hra (`genre.v5`) má dva vrhače zezadu kuchyně (`STATION_FOES`, chování `sniper`): první přijde se začátkem druhého kola, druhý (větší, role nepřítele) se spěchem. Po varování 0,8 s hodí výstřel přes řadu u pultu; hráč uhne podél pultu a práce v dosahu běží dál. Robot úkolu uhýbá sám (`quest-bot.ts`, `close`/`rowStep`), obecný úhyb průběhu se přeskočí (`pacing_bot.own`). Vrhači vezmou robotu ~2,5 s, takže před spěchem odpadne tolik kol, kolik ten čas pokryje (`STATION_FOES.seconds`); hodiny zůstávají.
- Buňka `quest.station` × 12 semínek (`p51-foes.test.ts`): intermediate 12/12, finále 12/12, novice 7/12 (bez nepřátel 12 / 12 / 9), 2–3 chování telemetrie na každém běhu, hra 30,9–36,2 s. Robot bez úhybu prohrál 12/12 (tři zásahy) – hrozba je skutečná.
- Zkoušené a zamítnuté (čísla v komentáři `STATION_FOES`): flanker od druhého kola (0/12, výpad každé ~2 s), vrhač z rohů s obecným úhybem (0/12 na 40 s hodinách), pevné kolo navíc pryč (otočilo délku „one / three pancakes“ v `quest-rounds.test.ts`).
- Dev sada stanoviště nemá; jiné řádky gauge se nezměnily. Brány: replay brána, `p51-stored-v4`, `station-rush`, `pacing-static-b`, `field-news`, `quest-rounds` a další testy stanoviště a průběhu zelené (`swarm` časový rozpočet padá jen pod zátěží, sám zelený).
- Mutace (záloha mimo repo): bez vrhačů ve v5 → `p51-foes` červený; vrhači i ve `genre.v4` → `p51-foes` a `station-rush` červené; robot bez úhybu → `p51-foes` červený (intermediate 0/12). `p51-stored-v4` stanoviště nehlídá – dev sada žádné nemá.

## T6 – souboj a hod (`t6.json`)

| Věta (panel) | Chování | Stoupá | Finále | Mrtvý čas |
|---|---|---|---|---|
| f02 „an ogre arm wrestles a frost giant…“ | **1 → 2** (`enemy:static`, `hazard:roam+spawned`) | ano → ano | `boss` → `boss` | 2,25 → 2,25 s |
| h05 „boxing a kangaroo…“ | **1 → 2** (`enemy:static`, `hazard:roam+spawned`) | ano → ano | `boss` → `boss` | 2,27 → 2,27 s |
| h03 „defend a castle from dragons…“ | **1 → 2** (`enemy:chase+spawned`, `enemy:roam+spawned`) | **ne → ano** (0,65 → 1,19) | `boss` → `boss` | 2,27 → 2,27 s |

- **Souboj** (`genre.v5`): soupeř každý třetí útok hodí věc (`DUEL_HURL`). Celý nápřah ji drží nad hlavou (hráč pozná, že úder nepřijde), po švihu letí 30 tiků a zasáhne, až doletí – úhyb trvá 20 tiků, takže úhyb na švih ruky vyprší dřív. Mezera po zásahu je mezera útoku, hratelnost z konstrukce platí. Scéna kreslí věc míčkem z primitiv střelnice. Buňka `duel.default` × 12: intermediate 12/12, finále 12/12, novice 7/12 (bez věci 12 / 12 / 7), hra 48,7–53,4 s (dřív 41–46 s); 180 hodů, robotu světa žádný zásah, robot, který uhýbá na švih ruky, dostal 36 zásahů a prohrál 12/12.
- **Hod** (`genre.v5`): do posledních dvou kol přiletí po čtyřech útočnících (`THROW_DIVE`, model nepřítele z věty). Čekají nad polem nad vrcholem každého oblouku, a až padne poslední cíl kola, snese se nejbližší a plíží se na hráče tak, aby k němu došel za 50 tiků; další se snese, když předchozí dosedne. Sestřelit ho jde míčem (bod), kdo dojde na 3 m, vezme 2 hody (hody došly = prohra). Kolo dostane hod navíc za útočníka a jejich odhad (1 s za útočníka) jde do rozpočtu kol – dlouhé hry mají o poslední kolo míň, hodiny zůstávají, křivka rychlosti kyvu jde dál přes původní počet kol (kola, která zůstala, jsou kola `genre.v4`, boss se kýve rychlostí finále). Buňka `throw.default` × 12: intermediate 12/12, finále 12/12, novice 5/12 (bez útočníků 12 / 12 / 6), `rising` 12/12 (dřív 0/12), hra 34,8–44,4 s (dřív 31,6–48,3 s); 76 útočníků, k robotu intermediate nedošel žádný.
- Zkoušené a zamítnuté (čísla v komentáři `THROW_DIVE`): útočníci s kolem rovnou na hráče z 24 m (konec nezhoustl, dlouhé hry přetáhly 52 s hodin, intermediate 5/12), přílet z dálky až po vyčištění kola (5/12), plížení bez rozpočtu kol (5/12), s rozpočtem a pomalým plížením (novice 12/12), vždy jen jeden útočník (novice 10 → 0 mezi 34 a 30 tiky okna). Okno 46–54 tiků: intermediate 12/12, novice 5–6/12; 42 → intermediate 5/12, 60 → novice 12/12.
- Gauge (`P47A_SET=p51`): změnily se jen řádky f02, h05 a h03; medián chování na panelu souboj 2, hod 2, stanoviště 2; podíl stoupajících her na panelu 0,98 → 1; žádný jiný řádek neztratil finále ani hratelnost, dev sada beze změny.
- Brány: replay brána, `p51-stored-v4`, `p51-foes` (12 testů) a všechny testy, které hlídají souboj a hod, zelené; `tsc` čistý. Červené už na HEAD před T6 (ověřeno na zdrojích HEAD): `finale-gauge` „names P42 parts“ (sběr s díly má průběh od T5), `ball-difficulty` (hodiny HUD), `field-segments` (otisky `runner.default`, `run.escape`, `platformer.default`), `difficulty` (`roam.catch` zastaralé měření) a známé `ball.score+rival`.
- Mutace (záloha mimo repo, 7/7 červené): bez věci ve v5 → `p51-foes` (4 testy); bez útočníků ve v5 → `p51-foes` (3); jen jeden útočník v posledním kole (konec bez tlaku) → `p51-foes` `rising`; věc i ve `genre.v4` → `p51-foes`, `duel-verbs`, `pacing-static-a`; útočníci i ve `genre.v4` → `p51-foes`, `throw-boss` (4); robot souboje bez věci → `p51-foes` (3); robot hodu bez útočníků → `p51-foes` (2, k robotu došlo 81 % útočníků).

## T7 – mrtvý čas chodce, střílečky, běžce a rytmu (`t7.json`)

Nejdelší mezera bez události (`longestGapS`, medián), proti `t6.json`:

| Žánr | Dev (vět) | Dev | Panel (vět) | Panel |
|---|---|---|---|---|
| chodec | 5 | **17,2 → 2,52 s** | 3 | **18,12 → 2,55 s** |
| běžec | 3 | **5,78 → 2,5 s** | 2 | **5,23 → 2,5 s** |
| střílečka | 2 | **6,15 → 3,34 s** | 2 | **5,67 → 2,79 s** |
| rytmus | 3 | 3,62 s (beze změny) | 2 | 4 s (beze změny) |
| **celkem** | 30 | **4,07 → 2,51 s** | 40 | 2,5 s |

- **Chodec** (značka `segments`): jiskra tepu na každém poli cesty k východu, ke kterému hráč plnou rychlostí dojde za 150 tiků (`WALKER_BEAT.beat` = tep pole P47A T9) – mezera 2,5 s ve všech pěti větách dev (dřív 10–20 s). Nová hra má bludiště 15 × 15 (`WALKER_BEAT.size`): na 11 × 11 trvala hra s jiskrami 20–27 s, pod pásmem 30–90 s. Hodiny mají navíc 35 ‰ cesty (`WALKER_BEAT.slack`), jinak začátečník na větším bludišti 0/12.
- **Běžec** (`genre.v5`): tep pole P47A T9 na trati – po 150 tikách bez události mince v pruhu před hráčem (`RUNNER_PULSE`, `heartbeatOf` posune místo o polohu hráče pro `space: 'track'`). Mezera 2,5 s ve všech větách; intermediate, novice, finále `boss` i stoupání beze změny. `run.escape` tep nemá (trať bez hrozeb `runnerFoes`) a pod 4 s byla už dřív.
- **Střílečka** (`genre.v5`): pochod vln nikdy řidší než intenzita 1150 (`SHOOTER_FOES.densityFloor`). Dev s01, s02 × 12 semínek: medián nejdelší mezery 6,18 → 3,17 s, nejvýš 3,77 s; výhry, finále i stoupání 12/12, hra 49–56 s místo 57–64 s.
- **Rytmus** beze změny: medián dev 3,62 s je pod 4 s; nejdelší mezera je náběh před první notou (m03 4,12 s, pod stropem 6 s).
- Gauge: změnily se jen řádky chodce, běžce a střílečky; finále (dev 0,93, panel 0,93), medián chování (1 / 2), stoupání (0,97 / 1) a hratelnost (30/30, 40/40) beze změny. Chytání (`control:move_free`, dev 14,92 s) řeší T4a.
- Brány: `p51-dead-time` 23/23 (7 buněk chodce, 5 běžce, s01/s02 střílečky × 12 semínek: mezera medián ≤ 4 s a žádná nad 6 s, hra 30–90 s, `idle` nevyhraje, replay týž, intermediate ≥ 0,8 s finále, novice 0,3–0,7 u chodce a ≥ 0,3 u běžce a střílečky; uložená hra staví týž svět), replay brána, `p51-stored-v4` a `runner-boss` 117/117, `tsc` čistý.
- Mutace (záloha mimo repo, 5/5 červené): bez jisker tepu chodce → 14 testů chodce (mezera 31–46 s); bez `RUNNER_PULSE` → 5 testů běžce (mezera 5,7 s); `densityFloor` 0 → s01, s02 (6,2 s); `WALKER_BEAT.slack` 0 → novice chodce 0/12 v 7 buňkách; bludiště 11 × 11 → hra 20–24 s v 7 buňkách. Strukturální test „velké bludiště“ při 11 × 11 neselže (čte tutéž konstantu) – menší bludiště chytí délka hry.

## T8 – obtížnost po P51 (`evals/play/p41/difficulty.json`)

Přeměřeno všech 54 živých buněk × 20 semínek × začátečník/intermediate (`difficulty.measure.ts`); posunulo se 17 řádků, proti stavu zapsanému v T3 (`728c8933`):

| Buňka | Otisk specu | Začátečník | Intermediate | Proč |
|---|---|---|---|---|
| `roam.catch` | změněný | 14 → 8/20 | 19 → 20/20 | T4: kořist na tři chycení, hodiny 430 % `catchSeconds` |
| `timing.stack`, `timing.precision`, `timing.bridge` | týž | 12 → 7/20 | 20/20 | T4: posledních 20 kol rychlostí 100 (`TIMING_FINALE`) |
| `ball.defeat`, `ball.score`, `ball.score+rival` | změněný | 14 → **20/20** | 20/20 (`ball.score` 19 → 20) | T4: soupeř-boss za terči a hodiny na 4 střely navíc (`ballFinaleSeconds`) – začátečník nad pásmem, viz „Rozhodnutí“ |
| `throw.default` | týž | 11 → 7/20 | 20/20 | T6: čtyři útočníci v posledních dvou kolech, o kolo míň |
| `duel.default` | týž | 8 → 10/20 | 20/20 | T6: hozená věc každý třetí útok, hra delší (48,7–53,4 s místo 41–46 s) |
| `quest.station` | týž | 13 → 12/20 | 20/20 | T6: dva vrhači se spěchem |
| sedm buněk `walk.*` | změněný | 10/20 | 20/20 | T7: bludiště 15 × 15 nové hry; jiskry tepu a rezerva hodin drží začátečníka na polovině |

- Žádný řádek nemá chybu stavby ani rozdílné přehrání; všechny buňky mají intermediate ≥ 0,8 a začátečník ≥ 0,3. Běžec, střílečka, arény a ostatní žánry beze změny: tep běžce robot nevidí (`withoutCoins`), `shooter.default` průběh nemá.
- **Šest řádků bylo zastaralých se stejným otiskem** (`timing.*`, `throw.default`, `duel.default`, `quest.station`): spec je týž, mění se svět za branou `genre.v5`. Brána `src/play/compose/__tests__/difficulty.test.ts` porovnává jen otisk specu, takže změnu světa za verzí nevidí – našlo je až přeměření. Oprava (otisk postaveného světa semínka 1 v měření i bráně) zapsaná jako přetečení směrování v commitu T8.
- Brána obtížnosti: horní mez začátečníka se u buněk `ball.*` nehlídá (stejně jako v `p51-ball-catch-timing` od T4), dolní mez 0,3 a intermediate ≥ 0,8 dál platí. Mutace (záloha mimo repo, 2/2 červené): začátečník bez zpomalení reakce (`extraReactionTicks` 12 → 4) → brána červená na profilech; `walk.reach` začátečník 16/20 v datech → `walk.reach/novice` nad 0,7.
- `e2e/offline-chain.spec.ts`, který plán jmenuje, v repu není – pevná čísla k porovnání nejsou.

## T4a – mrtvý čas chytání

Kořist na tři chycení (T4) poslala hráče po prvních dvou chyceních zpět na start a cesta ke kořisti byla bez události. Nová hra chytání má tep pole P47A T9 (`CATCH_PULSE` v `pacing-parts.ts`): po 2,5 s ticha (houstne s křivkou) přijde mince na volném z osmi míst čtverce 6 m kolem hráče, sevřená do arény (`pulse.around`), hráč ji sebere za bod (`pickup`, výsledek ji počítá jako „coins“); se třemi mincemi na ploše tep odvolá tu nejdál. První verze s pevnými místy v polovině arény (20 m od středu) dala táž čísla, ale ve snímku z prohlížeče mince ležela mimo záběr – událost, kterou hráč nevidí, se zahodila.

| Hra | Nejdelší mezera před | Po | Běh (s) |
|---|---|---|---|
| buňka `roam.catch`, 12 semínek | 9,3–16,6 s (medián 10,7) | 2,5 s všude | 22,3–34,6, beze změny |
| dev k01 / k02 / k03 (publikovaná semínka) | 9,5 / 14,9 / 16,1 s | 2,5 s | 22,9 / 33,1 / 33,1, beze změny |
| panel m11 | 9,5 s | 2,5 s | 22,5, beze změny |

- Robot mince nevidí (`withoutCoins`, jako tep pole), takže hraje tytéž vstupy: délka běhu na každém semínku sedí na desetinu, finále `boss` ve všech výhrách, intermediate a novice beze změny. Řádek `roam.catch` v `difficulty.json` se proto nepřeměřoval (otisk specu týž, výsledky robotů taky).
- Test `p51-dead-time.test.ts` („P51 T4a“): buňka a k01–k03 na 12 semínkách – medián ≤ 4 s, žádná nad 6 s, běh 20–90 s (chytání trvá 22–35 s už od T4), nečinný nevyhraje, přehrání = hash, intermediate ≥ 0,8 s finále, novice ≥ 0,3 (buňka i ≤ 0,7); hráč, který dojde k minci, dostane bod; uložená hra bez značky tep nemá.
- Mutace (záloha mimo repo): bez mince tepu → 5 testů červených; bez `pickup` → test sebrání červený; tep i pro míč → 8 testů míče červených; místa bez `around` (pevná kolem středu) → mince 11 m od hráče, test červený; „jen hra s `half`“ místo „jen chytání“ je ekvivalentní (ovládání míče `half` nemá).
- Ve snímku z prohlížeče (věta k02, tik 200, produkční build) mince svítí 6 m od psa v záběru kamery.

## T9 – oznámení nových finále ve scéně

Banner P47A (`PacingBanner`, štítek kitu `sp-world-tag`) teď ohlásí každé nové finále. Co a kdy, čte `nativeFinaleOf` v `pieces/pacing.ts` ze světa – finále, které staví generátor, ne pravidlo `pacing`:

| Žánr | Nápis | Kdy |
|---|---|---|
| chodec | „Exit ahead!“ | hráč na stezce jisker, posledních 8 polí cesty před východem |
| klouzání | „Hit the rings!“ | hráč vjel do tunelu kruhů (`glideTunnelZ`) |
| míč | „Boss: <jméno>“ | padl poslední terč a soupeř-boss žije |
| chytání | „Catch it again!“ | kořist po prvním chycení utekla |
| načasování, skládaná aréna, běžec | „Sudden death!“, „Boss: …“ | beze změny, hlásily už před T9 |

- Pin `src/play/arcade/__tests__/p51-finale-news.test.ts` (w01, w02, g01, b02, b03, k02, k03 × semínka 1–2): nápis přijde jednou, před výhrou, v tiku změny ve světě; uložená hra bez značky nové hry nehlásí nic. Délku (≤ 15 znaků) a anglickou větu hlídá `pacing-banner.test.tsx`.
- E2E `e2e/p51-finale-banner.spec.ts` (desktop a Pixel 7 s „méně pohybu“): věta w01 dveřmi návštěvníka, robot hraje v prohlížeči – „Exit ahead!“ v záběru ve 41,4 s, výhra ve 46,9 s, náběh `play-pacing-banner`, s „méně pohybu“ žádný; 0 chyb konzole. `e2e/interface-language.spec.ts` 3/3.
- Barvy a pohyb beze změny: nápis bere styl i `prefers-reduced-motion` z existujícího CSS banneru (`play.css`), nový popisek do `HUD_COUNTER_LABELS` nevznikl (banner má vlastní `PACING_BANNER_LABELS`).

## T4b – svědek soupeře a míč se soupeřem z věty

- **Svědek `rival` (4 červené `ball.score+rival`):** průběh obalí ovládání míče do `pacing_control` a sonda brankáře (`pieces/ball-probe.ts`) kontrolovala holé `world.control.id`, takže v nové hře nevystřelila ani jednou. Teď čte ovládání pod obaly (`baseControlOf`). `allowed.test.ts` a `ball-recipes.test.ts` 66/66.
- **Míč se soupeřem z věty měl finále jen na papíře:** každá taková věta jde rychlou verzí (`compose()` → `team`) a dostala průběh s finále `round` bez bosse – nejen b01, ale všechny čtyři zkoušené věty (fotbal, brankář, koše proti týmu, tenis). Týmová hra teď má bosse jako ostatní míč a soupeřův tým na něj má o `hp` + `spare` = 4 góly víc; bez nich robot prohrál na všech semínkách (soupeř dá gól zhruba každé 3,5 s). Čtyři věty: finále `boss`, hratelné, publikované semínko beze změny, nejdelší mezera 3,6 → 4,0 s (koše 2,4 s). Brána `p51-ball-catch-timing` má dvě týmové věty přes `draftGameSpecWithMeta`: intermediate ≥ 0,8, výhry s bossem ≥ 0,8, začátečník ≥ 0,3, `goalsToLose` pinované. Dev míč tím 2/3 → 3/3 (b01).

## T5b – chodec a klouzání pod parametry režiséra

- **Chodec s fázemi a závislostmi (nález 2):** změřeno 12 semínek, `paceBudgetPct: 100`, rychlost 80/110/160 – nová hra vyhraje 12/12 (nejmenší náskok 86 tiků). Klíče leží na cestě ke starému rohu, ale objížďku kryje rezerva hodin a zaokrouhlení na celé sekundy, takže kód se nemění; pin v `p51-walker-glide.test.ts`. Mutant „klíče u starého rohu“ ho shodí (7/12).
- **Krátké a rychlé klouzání (nález 3):** bez změny neměla finále trať 80–250 m při 180 ani 300–400 m při 240. Navržené zkrácení tunelu nestačí: na 160 m (běh 15 s) by v posledních 10 s muselo ležet 99 % kruhů. Nová hra teď má tunel úměrný rychlosti, úvodní kruhy aspoň 2,5× řidší než tunel a trať aspoň tak dlouhou, aby podmínka telemetrie platila s rezervou 10 % (`glideFinaleMinM`: 120 → 172 m, 180 → 288 m, 240 → 400 m). Všechny zkoušené kombinace délky 80–400 m a rychlosti 120–240: `climax`. Výchozí nová hra (300 m, 180) staví týž svět. Mutace 4/5 červené; přežila „hodiny chodce bez rezervy“ (viz výš, rezerva je pro jiskry tepu T7).

## T10 – regrese po P51

Celá sada (18. 10.): 14625/14655, 27 červených v 9 souborech. Opravené (všechny jsou piny světa *nové* hry, které P51 vědomě mění; uložené hry beze změny):
- `evals/play/p41/golden/genres.json` + `replays.json` přezmrazené generátorem (`-t genres`, `stored.json` nedotčený): mění se jen otisk světa a brána publikace ve 13 skupinách (běžec, skákačka, arény, quest, střílečka, hod, načasování, duel); žádný spec ani `readGameSpec`, všechny výsledky přehrání stejné (`won→won`, `lost→lost`). Tím zelený i `bot-profiles` (čte tytéž soubory).
- `field-segments`: běžec, útěk po trati a skákačka pinují uloženou `genre.v4` – staví přesně staré otisky.
- `finale-gauge`: hra s díly P42 má od T5 průběh; důvod `assembly` ukazuje uložená v4.
- `ball-difficulty`: HUD čte `time_limit` nové hry (15 s + `ballFinaleSeconds` = 33 s), nečinný hráč prohraje v tiku 1981 – termín platí, test pinoval 15 s.
- `bodies`: počítadlo tepu trati běžce (T7) se nekreslí – správně, test ho doplnil.
- Nález revize T5c-1 č. 5: uložená hra chytání ukazovala „0 coins“ místo „0 eaten“ (`ArcadePlay.tsx` `scoreUnit`); teď mince jen u nové hry (`tuning.segments`), pin v `gated-rules-render.test.ts`.

Zbývá: 4 piny P47B ve složce `src/play/arcade/abilities/__tests__/` (viz „Rozhodnutí“) a `submission-check` (ENOENT `plans/P8-odevzdani.md`, worktree).

Po opravách (18. 10.): celá sada 14648/14656 – červených jen těch pět; replay brána je v ní celá. `npm run build` exit 0. E2E proti `next start` na 3291 (úložiště jen v paměti, `PLAY_STORE_DIR` na nezapisovatelné cestě, jak `play-share` čeká): `p35-perf` 17, `play-share` 5, `p36-dare` 4, `interface-language` 3 – 29/29 zelených. `e2e/offline-chain.spec.ts` v repu není (T8).

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
- **T6 – druhý vrhač má roli nepřítele (`enemy`):** se stejnou rolí `hazard` jako první dala telemetrie na semínku 12 buňky jediný podpis (těla i výstřely `hazard:roam`); větší vrhač s vlastní rolí je druhý druh hrozby, který přijde se spěchem, a dvě chování drží na všech 12 semíncích.
- **T6 – `station-rush.test.ts` staví strukturu spěchu jako `genre.v4`:** test popisuje spěch P47A, jak ho postavila `genre.v4`; nová hra má navíc vrhače a o jejich čas míň kol, její spěch a kopie hlídá `p51-foes.test.ts` (konzervativní čtení – žádná dřívější aserce se nezmírnila).
- **T6 – banner stanoviště nové hry:** s prvním vrhačem ohlásí „Here they come!“ (`buildUp`, jako hry s chováním bez úseků), pak „Rush order!“; `field-news.test.ts` to u buňky `quest.station` čeká.
- **T6 – druhé chování souboje je hozená věc v ovládání `duel`, ne chování průběhu:** hráč souboje se jen skrčí – výstřel ostřelovače letí ve výšce 0,5 m a zasáhl by i skrčeného, a výpad soupeře by telemetrie viděla jako tutéž stopu jednoho těla. Věc je vlastní tělo role hrozby; telemetrie ji vidí jako `hazard:roam+spawned` (ne `chase`), protože `z` hráče souboje je počítadlo zásahů, ne poloha.
- **T6 – útočník hodu bere hody, ne život:** hod životy nemá („Hod nemá čím ubrat život“, `arcade/compile.ts`), prohra je „hody došly“ – konzervativní čtení drží slovník hodu a nepřidává životy.
- **T6 – útočníci hodu jdou do rozpočtu kol:** bez toho dlouhá semínka buňky přetáhla 52 s hodin; o poslední kolo míň, hodiny zůstávají (jako vrhači stanoviště). Křivka rychlosti kyvu se počítá z kol před úbytkem, takže kola, která zůstala, jsou kola `genre.v4` (s křivkou přes méně kol se kyv druhého kola h03 zrychlil a mrtvý čas stoupl 2,27 → 2,88 s).
- **T6 – testy dnešního souboje a hodu staví `genre.v4`:** otisk sumo duelu (`duel-verbs`), údery po třetinách souboje (`pacing-static-a`) a stavba terče-bosse (`throw-boss`) popisují svět `genre.v4`; nová hra je hlídaná v `p51-foes.test.ts` (věta f02, h05 a sumo mají věc, stoupání telemetrie souboje, kola hodu = kola `genre.v4` bez posledního nejvýš jednoho, HP a rychlost terče-bosse). Žádná aserce se nezmírnila.
- **T7 – tep chodce leží na cestě, ne na místě vstupu:** bludiště se staví při stavbě a robot jde vždy nejkratší cestou, takže jiskry na každém poli cesty, ke kterému hráč dojde za jeden tep, dají týž rytmus jako tep pole P47A bez čekání na ticho za běhu – mince tepu na pevném místě vstupu by v bludišti ležela za zdí.
- **T7 – nová hra chodce má bludiště 15 × 15:** plán zakazuje zkrátit hru pod 30 s; s hustšími událostmi na 11 × 11 šel robot k východu 20–27 s. Rezerva hodin 35 ‰ cesty (25–40 ‰ → novice 6/12, 20 → 4/12, 45 → 8/12, 50 → 11/12; intermediate 12/12 v celém okně) je střed okna.
- **T7 – podlaha hustoty střílečky 1150:** nejnižší změřená, při které je nejdelší mezera na všech 12 semíncích obou vět pod 4 s (1000 → nejvýš 4,68 s, 1100 → 4,05 s); vrchol a finále (1300, 1500) zůstávají hustší, takže stoupání drží.
- **T7 – živá buňka `shooter.default` není v testu:** má jeden život a průběh nemá, mezera se tam podlahou nemění; test měří věty dev s01, s02 (střílečka s průběhem).
- **T7 – rytmus se nemění:** cíl ≤ 4 s splňuje už `genre.v4` (dev 3,62 s) a nejdelší mezera je náběh před první notou; hustší začátek by změnil hudbu, ne mrtvý čas uprostřed hry.
- **T8 – brána obtížnosti nehlídá horní mez začátečníka u míče:** pokračování rozhodnutí T4 – začátečník míče vyhraje 20/20 a pásmo 0,3–0,7 by držely jen hodiny desetiny sekundy nad během intermediate. Výjimka stojí v `difficulty.test.ts` vedle výjimky běžce se střelbou; míč je tím jediný žánr, kde začátečník může vyhrát vždy – kandidát na úpravu, až bude míč mít jiný rozdíl mezi profily než reakci.
- **T4a – mince tepu chytání jde sebrat za bod:** mince, kterou hráč nesebere, by byla jen kulisa, která měřidlu dodá událost. Chytání skóre jinak nemá, takže bod nic nerozbije (velikost hráče je pevná, `size` ovládání), a kořist zůstává jediná cesta k výhře.
- **T9 – finále míče se hlásí jako „Boss: <jméno>“, ne „Last round!“:** pravidlo `pacing` míče má finále `round`, ale to, co hráč na konci opravdu potká, je soupeř-boss se 3 HP sám na hřišti; „Last round!“ by sliboval kolo, které hra nemá. Nápis přijde, až padne poslední terč – dřív by boss nebyl jediný, co zbývá.
- **T4b – týmová hra dostane bosse, ne průběh bez finále:** plán připouštěl obojí; míč se soupeřem z věty je přesně ta hra, kterou porota zkusí, a průběh bez finále by ji nechal jediným žánrem bez konce. Cena: soupeřův tým má o 4 góly víc, než měl uložený `team`.
- **T5b – krátkou trať klouzání nová hra prodlouží:** režisér smí chtít 80 m, ale běh pod ~25 s nemůže mít konec, který telemetrie uzná. Přednost má finále; žádost o krátkou trať se splní nejkratší tratí, která ho ještě má.
- **T9 – chodec a klouzání nehlásí „Final sprint!“:** jejich finále je místo (stezka k východu, tunel kruhů), ne zrychlení; nápis říká, kam jít.
- **T5c – začátečník nové hry načasování smí v náhlé smrti prohrát hodinami:** uložený pin „nikdy neprohraje v náhlé smrti“ na nové hře neplatí (4 z 8 semínek, 3 buňky), ale ani jednou minutím – všechny prohry jsou 34 s pravidla `time_limit` v tiku 2040, robot okno rychlých kol trefí každým ťukem. Finále se nemění: hodiny jsou to, co drží začátečníka v pásmu 0,3–0,7; nový pin hlídá, že náhlá smrt minutím nezabíjí.
- **T10 – čtyři piny P47B nechané červené:** `assembly-harm` (2) a `fight-guard` (2) pinují otisk světa nové hry z věty; uložená `genre.v4` staví přesně jejich otisk (`3eaf0928…`, `327f61dd…`, `ef1c82ae…`), mění se jen `genre.v5`. Leží ve `src/play/arcade/abilities/**`, kam P51 podle hranice s P52 nesmí – přeotiskne je P52 při slučování této větve.
- **T5c – sonda svědka vybírá tělo jen v rámci role:** globální řazení vazeb z T5 posunulo i pořadí rolí (a tedy sond a svědků). Na žádné živé buňce to pořadí neměnilo (změřeno nad všemi), týkalo by se jen her s díly; teď se volí první tělo přítomné od startu v rámci role a role jdou v pořadí vazeb jako před T5.
