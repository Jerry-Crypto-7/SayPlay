# P45C – měřidlo průběhu hry

Měří, jestli hra má úvod, stupňování a finále: stoupá tlak hrozeb od začátku ke konci běhu, nese hra finále a kolik různých chování nepřátel v ní je. Čte jen stav jádra a kusy světa, telemetrii P45A ne – P45A definuje „mrtvý čas“ a „finále“ po svém a T17 obě definice porovná.

```
npx vitest run --config vitest.measure.mts evals/play/p45c/pacing.measure.ts                 # → baseline.json
P45C_OUT=after npx vitest run --config vitest.measure.mts evals/play/p45c/pacing.measure.ts  # → after.json
```

Každá živá buňka (`liveCells`) × semínka 1–8, týž svět jako `/play` (`compileRecipe` → `arcadeWorldOf`). Kód: `pacing.ts`, test měřidla `__tests__/pacing-gauge.test.ts`.

## Pole řádku

| Pole | Co znamená |
|---|---|
| `threatsPerThird` | průměrný tlak (m/s) v první, druhé a třetí třetině **běhu robota intermediate** (ne horizontu 90 s). Tlak tiku = součet rychlostí živých těl rolí `chaser`, `enemy`, `hazard`; rychlost = posun mezi dvěma tiky. Tělo, které tik předtím nežilo (předloha, právě oživené), a přesun nad 30 m/s (nová vlna na vstupu) se nepočítají |
| `countPerThird` | průměrný počet živých hrozeb po třetinách |
| `rising` | poslední třetina má tlak aspoň o 15 % vyšší než první (a nenulový) |
| `finale` | svět nese bosse (`boss_beat`) nebo pravidlo `pacing` s finále |
| `behaviours`, `behaviourNames` | různá chování nepřátel ve světě: dnešních šest (`wander-flee`, `pursue`, `pursue-track`, `fight`, `guard`, `pendulum` – definice v `behavioursOf`) a nová P45C z obalu `pacing_control` a `boss_beat` |
| `winSeconds` | sekundy do výhry robota intermediate; `null` = nevyhrál |
| `noviceWon`, `intermediateWon` | výhra robota s profilem člověka (`BOT_PROFILES`, `verify.ts`) |
| `idleWon` | nečinný hráč vyhrál (`verifyArcade`) |
| `replayEqual` | přehrání záznamu robota intermediate dá týž hash a `verifyArcade` hlásí shodu dvou přehrání |
| `buildMs` | `compileRecipe` + `arcadeWorldOf` + `verifyArcade` v ms (načtení Rapieru mimo) – jediné pole, které se mezi běhy mění |

**Role `projectile` se nepočítá:** v jádře ji má jen výstřel hráče (`blaster`, `gun`, `launch`), takže hod (`throw.default`) by ve všech 8 semínkách „stoupal“ jen tím, že hráč háže. Výstřely nepřátel P45C (ostřelovač, boss) jsou role `hazard`.

## Baseline na `main` (`0714a352`, 8. 10. 2026)

`baseline.json`, 54 živých buněk × 8 semínek = 432 her, všechny postavené bez chyby.

| Měřítko | Baseline |
|---|---|
| Tlak stoupá (`rising`) | **9 %** her – jen buňky s vlnami (`arena.escape`, `arena.collect`, `arena.escape+collect`, `quest.spatial` 8/8) a souboj (`arena.fight` 6/8) |
| Finále | **0 %** |
| Chování nepřátel, medián | **0** (nejvýš 1 na hru: `pursue`, `pursue-track`, `guard`, `fight`, `wander-flee`, `pendulum`) |
| Novice 0,3–0,7 | 27 z 54 buněk; nad 0,7 je 20 (`drive.*` a `voyage.race` 1,0, `glide.*`, `ball.*`, `roam.catch`, `jump.escape`, `flap.collect`, `arena.escape+collect` 0,75), pod 0,3 je 7 (`platformer.*`, `timing.*` 0,25) |
| Intermediate ≥ 0,8 | 54 z 54 buněk |
| Délka 30–90 s (výhry intermediate) | 64 % – krátké jsou `walk.*` (12 s), `glide.*` (15 s), `ball.*` (10–16 s), `voyage.land` (14 s), `roam.catch` (6 s) |
| Nečinný vyhrál | 0 |
| Přehrání = hash | 100 % |
| `buildMs` p95 | 761 ms |

## T13 – střelnice, souboj dvou, míč

- **Střelnice:** vlny čekají za branou 40 m (mimo dostřel) a vyjdou podle pochodu, jehož rozestupy zhušťuje křivka; ostřelovač od druhé vlny; finále boss-terč s HP 5 a salvou, kterou jde sestřelit. Buňka P41 `shooter.default` (jeden život) průběh nedostane vůbec: proniklý výstřel prohraje celou hru a začátečník s průběhem vyhrával 0,85–1,0 místo 0,7 (s bossem i jen s poslední vlnou jako finále) – páka jen na začátečníka se nenašla, náboje i rychlost salvy jsou útes i pro robota bez profilu.
- **Souboj dvou:** agresivita soupeře jde s intenzitou (700–1200) místo zrychlení po soupeřích; finále = rozzuření posledního soupeře pod polovinou HP (nápřah +12 tiků, mezera −4). Soupeř stojí a scéna ho kreslí na startu, takže tlak tohoto měřidla je u souboje vždy 0 – stoupání souboje měří test četností úderů po třetinách.
- **Míč bez průběhu:** spec míče staví `nativeSpec` bez `genre` (jako chodec), takže záznam by nikdy neběžel; volba finále podle módu `ball_pitch` (s brankářem boss-brankář, bez něj pohyblivá branka – bez soupeře není koho porazit) čeká na značku nové hry i pro nativní spec.

## T14 – hod, načasování, rytmus, úkol na stanovišti, přistání

Tyhle žánry nemají hrozby, takže tlak měřidla je u nich 0; test `pacing-static-b` měří stoupání tím, co hra opravdu zrychluje (rychlost jezdce, noty do 3 s před lištou, rychlost pohyblivého terče, tempo lhůty přetečení). Obtížnost (20 semínek, novice / intermediate, před → po): načasování 0,3 → 0,6 / 0,95 → 1,0, rytmus 0,5 → 0,55 / 1,0, stanoviště 0,35 → 0,4 / 1,0, hod 0,65 → 0,55 / 1,0.

- **Načasování:** rychlost jezdce po kolech z křivky (dnešní nejpomalejší + rozpětí × intenzita nad `floor` 450), finále jede jako dnešní poslední kolo – okno nikdy užší než dnešní nejužší; finále = náhlá smrt v posledních třech kolech (minutí prohrává i se životy). Začátečník prohrával hlavně na hodiny 34 s, rychlejší kola mu je zkrátila.
- **Rytmus:** písnička nad `placeByCurve` – 75 % not písničky bez průběhu na mřížce třetin doby, úvod řidší než doba, závěrečná fráze po dvou třetinách doby; dráhy ve frázích po čtyřech: `walk` do stupňování, pak střídání s `trill`, finále celé `trill`. Se stejným počtem not začátečník vyhrál 5/20: robot začátečníka vypadne 12 tiků z každých 60 a noty na celých dobách při 120 BPM mu z toho okna většinou vypadnou – mimo doby chybí na každé notě stejně (~7 %).
- **Úkol na stanovišti:** lhůta přetečení kola jde s křivkou od dnešní lhůty prvního kola po dnešní poslední (nikdy kratší); finále = poslední kolo s dvojím úkolem (kopie stanovišť na pultu, výhra čeká i na ně), proto o dvě kola míň. Držení `interact` je v `rules/**` – kola samotná se zrychlit nedají, zrychluje jen lhůta.
- **Hod:** v každém kole bonusový terč za cíli, kyvadlo přes čáru hodu (±3 m), rychlost kola z křivky 30–105 jednotek za tik; robot nabije předem a pustí, až ho let potká na čáře (zasáhne každým hodem). Kola se počítají do rozpočtu s 2 s za bonusový terč – hry s věží mají o kolo míň (33 s místo 48 s).
- **Přistání bez průběhu (odchylka):** jeden život a hra 13,6–15,1 s (intermediate 19/20, novice 13/20) – délku 30–90 s průběh bez jiné úrovně nedá; vítr a přiblížení s varováním čekají na delší přistání.

## T17 – slepý párový soud v půli plánu (panel 40 vět)

9. 10. 2026, `mid-round.json`. Větev sloučená s `origin/main` (`c9c3d91b`, bez konfliktů). **A** = `origin/main` `fc6b99ba` (P45A + P45E; hraje tytéž hry jako `0714a352`) z dočasného worktree na 3218, **B** = tato větev na 3217; obě strany bez `.env.local` a s prázdným `PLAY_STORE_DIR`. Podle `evals/play/p45/README.md` jen nad panelem, zapečetěná sada neotevřená:

```
node --experimental-strip-types scripts/play-fidelity.mjs fun --set p45-panel --base-a http://127.0.0.1:3218 --base-b http://127.0.0.1:3217 --run p45c-t17-mid --commit-a fc6b99ba --gpu   # --ignore-budget
```

`mid-round.json`: `result` = výstup nástroje doslova (`evals/play/p45/result-<run>.json`, ten v gitu není), `byGenre` = rozpad po žánrech, `pairs` = každý pár se zdůvodněním soudce. Telemetrie běží jen nad B; sloupec `main` je `evals/play/p45/baseline.json`. 40 volání soudce, čísla jednoho běhu.

| Celkem | `main` | Nová | Cíl |
| --- | --- | --- | --- |
| Podíl párů pro novou (`bShare`) | – | **0,638** (18 výher, 7 proher, 15 remíz; `leftWinShare` 0,488) | ≥ 0,55 |
| Mrtvý čas – medián `longestGapS` | 6,37 s | 6,79 s | ≤ 3 s |
| Podíl `rising` | 0,40 | 0,57 | ≥ 0,70 |
| Chování – medián `behaviourCount` | 1 | 1 | ≥ 2 |
| Podíl s finále | 0,15 | 0,33 | ≥ 0,50 |

Cíl párového soudu pro jeden plán na panelu splněný, ale šum panelu je ~0,08 – platí jen směr. Žádný ze čtyř cílů telemetrie splněný není.

### Po žánrech

Žánr z telemetrie B (u všech 40 vět shodný s panelem). Hodnoty `main → nová`, jen hratelné hry (40/40).

| Žánr | Věty | Nová / `main` / remíza | Podíl pro novou | Mrtvý čas (s) | `rising` | Chování | Finále |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `arena.collect` | 3 | 2 / 0 / 1 | 0,83 | 9,92 → 10,48 | 0 → 0,67 | 1 → 4 | 0 → 0,67 |
| `arena.escape` | 3 | 3 / 0 / 0 | 1 | 24,67 → 15,87 | 0 → 0,33 | 2 → 4 | 0 → 0,33 |
| `arena.fight` | 2 | 2 / 0 / 0 | 1 | 4,95 → 6,90 | 0 → 0,5 | 2 → 4 | 1 → 1 |
| `shooter` | 2 | 2 / 0 / 0 | 1 | 4,35 → 5,67 | 0 → 1 | 1 → 2,5 | 0 → 1 |
| `quest.spatial` | 3 | 3 / 0 / 0 | 1 | 14,70 → 10,32 | 0 → 0,33 | 1 → 2 | 0 → 0 |
| `quest.station` | 3 | 2 / 0 / 1 | 0,83 | 1,80 → 1,80 | 0,33 → 0,33 | 0 → 0 | 0 → 0 |
| `flap` | 2 | 2 / 0 / 0 | 1 | 2,68 → 2,98 | 1 → 1 | 0 → 0 | 0 → 0 |
| `throw` | 1 | 1 / 0 / 0 | 1 | 1,28 → 2,27 | 0 → 0 | 0 → 0 | 0 → 0 |
| `timing.stack` | 3 | 1 / 1 / 1 | 0,5 | 1,25 → 1,90 | 1 → 1 | 0 → 0 | 0 → 0 |
| **`duel`** | 2 | 0 / 2 / 0 | **0** | 2,26 → 2,49 | 1 → 1 | 1 → 1 | 0 → 0 |
| **`rhythm`** | 2 | 0 / 2 / 0 | **0** | 3,00 → 4,42 | 1 → 1 | 0 → 0 | 0 → 1 |
| **`runner`** | 2 | 0 / 2 / 0 | **0** | 21,10 → 20,02 | 1 → 1 | 0,5 → 0,5 | 1 → 1 |
| `platformer` | 3 | 0 / 0 / 3 | 0,5 | 8,38 beze změny | 0 | 1 | 0 |
| `control:steer` | 3 | 0 / 0 / 3 | 0,5 | 21,25 beze změny | 0,67 | 0 | 0,67 |
| `control:walker` | 3 | 0 / 0 / 3 | 0,5 | 21,92 beze změny | 0,33 | 0 | 0 |
| `control:ball` | 1 | 0 / 0 / 1 | 0,5 | 3,27 beze změny | 0 | 0 | 0 |
| `control:glide` | 1 | 0 / 0 / 1 | 0,5 | 2,15 beze změny | 0 | 0 | 0 |
| `control:move_free` | 1 | 0 / 0 / 1 | 0,5 | 6,32 beze změny | 1 | 1 | 0 |

**Odvozeno (ne změřeno):** 12 vět (plošinovka a `control:*` – nativní specy bez `genre`) P45C nemění a všech 12 skončilo remízou, jak předpovídá kalibrace P45A. Na 28 změněných větách je podíl pro novou (18 + 3/2) / 28 = **0,70**.

### Prohry ≥ 50 % párů – příčina a cíl

- **`duel`** (`f02`, `h05`): soudce u nové verze vidí soupeře, který opakuje týž pohyb bez stupňování (`f02`) nebo většinu klipu stojí a útočí až v posledním snímku (`h05`), kdežto v `main` útočí opakovaně po celý klip. **Cíl: T18 kalibrace** – agresivita soupeře `PACING_KNOBS.duel` (`pace` od `PACING.intensity.intro` do 1200) začíná pod dnešní úrovní; nový souboj navíc trvá přes 43,5 s proti 33–35 s v `main` (odvozeno z délky klipu).
- **`rhythm`** (`u01`, `u02`): soudce u nové verze vidí noty, které většinou zůstávají daleko od lišty, a lištu, která mlčí až do konce, kdežto `main` přivádí barevné bloky k liště opakovaně. **Cíl: T18 kalibrace** – podíl not `RHYTHM_CURVE.share` (750) a řidší úvod; konstanta leží v `rhythm.ts`, mimo dnešní soubory T18. Telemetrie souhlasí: mrtvý čas 3,00 → 4,42 s.
- **`runner`** (`m08`, `s003`): soudce u nové verze vidí prázdnější, otevřenější úseky s méně těsnými průjezdy kolem překážek než v `main`. **Cíl: nový nález pod „Findings routed by the run“** – běžec dostal jen křivku rychlosti (úvod 90 %), žádnou novou hrozbu (odchylka T11: chování v pruzích shazují robota, protože uhýbání nehlídá překážky řady); konstanty T18 ho vrátí nejvýš k remíze.

**Pozorování pro T18:** mrtvý čas se zhoršil v osmi žánrech (`arena.collect`, `arena.fight`, `shooter`, `rhythm`, `throw`, `timing.stack`, `flap`, `duel`) a zlepšil jen v `arena.escape`, `quest.spatial` a `runner`. Domněnka (neověřená): lehčí úvod křivky prodlužuje první mezery.

### Dvě definice – měřidlo T1 proti telemetrii P45A

- **`rising`:** T1 = tlak hrozeb (součet rychlostí) v poslední třetině ≥ 1,15 × první; P45A = víc událostí v poslední třetině než v první. Žánry bez hrozeb (`flap`, `rhythm`, `timing.stack`, `runner`) mají v P45A `rising` 1 už na `main` – houstnou sebrání a skóre – kdežto měřidlo T1 na `main` stoupání ukázalo jen v buňkách s vlnami a v souboji v aréně.
- **Finále:** T1 = svět nese bosse nebo finále průběhu (stavba světa); P45A = poražený boss (≥ 3 zásahy, pak zmizí) nebo zhoustlý konec vyhraného běhu (climax). P45A tak finále nedá bossovi, kterého robot neporazí, a dá ho hře bez bosse (`runner` a `control:steer` už na `main`).
- **Mrtvý čas** měří jen P45A. Podle plánu platí P45A a T18 ladí proti ní.

## T18 – kalibrace

9.–10. 10. 2026 nad `fc6adb61` (po R2). Změněné jsou dvě konstanty, `PACING`, `TENSION_CURVE` a `GENRE_PACING` zůstaly:

- **`PACING_KNOBS.duel`** (`pacing.ts`): spodní mez agresivity soupeře 700 (úvod křivky) → **1000** (dnešní první soupeř), strop 1200 beze změny.
- **`RHYTHM_CURVE`** (`rhythm.ts`): podíl not 750 → **900 ‰** písničky bez průběhu, mřížka třetiny → **čtvrtiny doby** (`grid` 3 → 4), fráze 4 beze změny.

Mrtvý čas měří telemetrie P45A lokálně bez soudce (`P45_SET=panel … evals/play/p45/fun.measure.ts`, 40 vět panelu, robot `intermediate`); kde leží nejdelší mezera, ukázal dočasný běh nad týmiž hrami (`traceRun`, začátek mezery v podílu běhu a události na jejích krajích). Varianty konstant měřil dočasný běh nad buňkami P41 (semínka 1–20, novice / intermediate, jako `difficulty.measure.ts`).

### Prahy AC

| Měřítko | Před T18 (`fc6adb61`) | Po T18 | Práh | Splněno |
| --- | --- | --- | --- | --- |
| Novice 0,3–0,7 (`difficulty.json`, 20 semínek) | 54/54 buněk | **54/54** (0,30–0,70) | každá živá buňka | ano |
| Intermediate (`difficulty.json`) | min 0,90 | **min 0,90** | ≥ 0,8 | ano |
| Délka 30–90 s (`depth.json`, 260 vět) | 90,0 % | **90,0 %** | ≥ 85 % | ano |
| `idle` prohraje (`depth.json`) | 100 % | **100 %** | ≥ 95 % | ano |
| `rising` (`after.json`, 432 her) | 19 % | **19 %** | ≥ 70 % | **ne** |
| Chování, medián (`after.json`) | 0 | **0** | ≥ 2 | **ne** |
| Finále (`after.json`) | 35 % | **35 %** | ≥ 50 % | **ne** |
| p95 `buildMs` (`after.json`, běh sám) | 1762 ms pod zátěží souběžných měření | **1554 ms** | ≤ 2000 ms | ano |
| Přehrání = hash (`after.json`) | 100 % | **100 %** | 100 % | ano |

V `difficulty.json` se pohnuly jen dvě laděné buňky: `rhythm.default` novice 0,55 → 0,40 a `duel.default` 0,50 → 0,40 (intermediate obě 1,0); hashe běhů jinde beze změny, vzory P41 přezmrazené jen u variant těchto dvou buněk. `noviceBand` v `after.json` (27 buněk mimo) je pohled přes 8 semínek – bránou je `difficulty.json` s 20. p95 `buildMs` 1554 ms proti 761 ms v baseline táhne ověření běžce s hrozbami v pruzích (R2: sonda každého chování hraje plánovač pruhů) – 7 ze 432 staveb nad 2 s, všechny v buňkách běžce (`runner.default+chase_me+shoot_at` až 3271 ms, `+chase_me` 2399 ms, `run.escape` 2053 ms). `depth.json` mimo pásmo jsou jen nativní hry bez žánru, na které P45C nesahá: `control:walker` 11, `control:ball` 8, `control:glide` 6, `control:move_free` 1.

### Nesplněné prahy měřidla – rozbor po buňkách

Konstantami nedosažitelné: stoupání, finále i chování dává jen průběh, a ten dostane 19 z 54 buněk.

| Skupina | Buňky | `rising` | Finále | Chování |
| --- | --- | --- | --- | --- |
| Hrozby s průběhem (10) | `run.escape`, `runner.default` (+`shoot_at`, +`chase_me`, +`chase_me+shoot_at`), `arena.escape`, `arena.collect`, `arena.escape+collect`, `arena.fight`, `quest.spatial` | 8/8 každá | ano | 2–4 (`arena.escape` 2, ostatní 3–4) |
| Statické s průběhem (9) | `flap.collect`, `flap.default`, `throw.default`, `timing.stack`, `timing.precision`, `timing.bridge`, `rhythm.default`, `duel.default`, `quest.station` | 0/8 – nemají hrozbu, tlak měřidla je 0 | ano | 0 |
| Bez průběhu (35) | `drive.*` 8 (`steer_track`), `glide.*` 8 (`glide_course`), `walk.*` 7 (`walker_labyrinth`), `ball.*` 3 (`ball_pitch`), `roam.catch` (`arena_catch`) – nativní spec bez `genre`, záznam nikdy neběží (T11 (6)); `platformer.*` 4 a `jump.escape` (`platform_level`, bez záznamu – T11 (4)); `shooter.default` a `voyage.race` (jeden život / jedna havárie, odchylky T13 a T11); `voyage.land` (odchylka T14) | 0/8 | ne | 0–1 (dnešní `pursue-track`, `guard`, `pursue`, `wander-flee`, `pendulum`) |

- **`rising`:** strop je 10 buněk s hrozbami = 80/432 = 19 % a všechny už stoupají v 8/8. Na 70 % chybí ~220 her; statické žánry měřidlo T1 z definice nezapočte (tlak = rychlost těl rolí `chaser`/`enemy`/`hazard`).
- **Finále:** 19 buněk s průběhem × 8 = 152/432 = 35 %; na 50 % chybí 64 her = 8 buněk, a ty všechny průběh nemají (výše).
- **Chování:** 256 ze 432 her má 0 chování, ≥ 2 jen 80 (10 buněk s hrozbami). Medián 2 chce 216 her; ani 2 chování v každé buňce s průběhem (152 her) by nestačila.

Telemetrie P45A na panelu se konstantami T18 nehnula (před → po): mrtvý čas medián 6,79 → 6,79 s, `rising` 0,57 → 0,57, chování medián 1 → 1, finále 0,33 → 0,33 – všechny cíle P45A pořád nesplněné (měří je T19).

### Ztráty z T17

Mrtvý čas = nejdelší mezera bez události (P45A), průměr přes věty žánru v panelu; `main` = `evals/play/p45/baseline.json`.

- **Souboj dvou – vyřízeno.** Příčina potvrzená: s agresivitou 700 v úvodu soupeř první útok dotáhne o 0,2 s později a celou úvodní část útočí o 43 % pomaleji. S mezí 1000: první úder `f02` 2,47 → 2,25 s, `h05` 2,50 → 2,27 s (`main` 2,25 / 2,27), délka `f02` 49,0 → 42,6 s, `h05` 52,8 → 45,8 s, `depth.json` souboj medián 50,9 → 44,2 s; P41 novice 0,40, intermediate 1,0. **Zbytek délky (`main` ~34 s) nevyřízen, příčina:** `main` zrychluje po soupeřích (`rise` 3 tiky) až na meze oken 18/17 tiků, průběh má strop 1200 kvůli začátečníkovi – mez 1000 se stropem 1300 dala novice 0/20, 1200 po celou hru 4/20. Mez 1100 (38–43 s, novice 8/20) nevybrána: úvod by byl těžší než dnešní a stupňování jen 1100 → 1200.
- **Rytmus – vyřízeno zčásti.** Not na panelu `u01`/`u02` 39/38 → 47/45 (`main` ~50, odvozeno z `eventsPerS`), druhá nejdelší mezera 2,67/3,58 → 2,13/2,50 s, nejdelší (čekání na první notu) 4,33/4,50 → 4,00/4,00 s (`main` 3,00); finále `climax` zůstalo; P41 novice 0,55 → 0,40, na semínkách 21–60 15/40 → 15/40. **Zbytek nevyřízen, příčina:** první nota čeká na řídký úvod křivky – `placeByCurve` váží `intenzita − spawnFloor`, v úvodu 200, ve finále 1000 – a s tím `RHYTHM_CURVE` nehne (jen počet not). Plný počet not (1000 ‰) srazil novice na 5/20; celé doby a poloviny (`grid` 1, 2) dají novice 9/20 resp. 7/20, ale dvě noty nikdy blíž než doba – závěrečná fráze přestane být rychlejší (červený `pacing-static-b` a banner finále). `spawnFloor` 300 s plným počtem not (první nota 3,5/3,7 s, novice 0,40) přesune spawny všech žánrů: `run.escape` novice 0,35 → 0,25, `arena.escape` intermediate 0,90 → 0,80, `arena.fight` novice 0,45 → 0,30 – nepoužito.
- **Mrtvý čas v osmi žánrech – domněnka „lehčí úvod“ potvrzená pro čtyři, vyvrácená pro čtyři:**

| Žánr | `main` | před T18 | po T18 | Kde leží nejdelší mezera | Příčina |
| --- | --- | --- | --- | --- | --- |
| `duel` | 2,26 | 2,49 | **2,26** | začátek (první úder) | úvod 700 – vyřízeno |
| `rhythm` | 3,00 | 4,42 | **4,00** | začátek (první nota) | řídký úvod křivky – zčásti |
| `shooter` | 4,35 | 5,67 | 5,67 | 6–7 % běhu: od posledního sestřelení 1. vlny po první výstřel na 2. vlnu | 2. vlna vyjde později – rozestup pochodu × 1000 / intenzita začátku vlny (744 při čtyřech vlnách, 818 při třech) |
| `flap` | 2,68 | 2,98 | 2,98 | začátek (první sebrání) | úvod trati 90 % rychlosti (`CURVE_SPEEDS`, `compose/progression.ts` – mimo soubory T18) |
| `arena.collect` | 8,95 | 10,08 | 10,08 | 37 % běhu, mezi dvěma sebráními 2. vlny | ne úvod; **odvozeno:** robot čeká u strážce, který drží věc (neměřeno) |
| `arena.fight` | 4,95 | 6,90 | 6,90 | jen `j08`: 11,6 s v 78 % běhu, mezi dvěma zásahy téhož soupeře; `f10` 2,17 s je lepší než `main` | ne úvod; **odvozeno:** poslední vlna s bossem. Každá zkoušená konstanta cestu přeskládá (`spawnFloor` 300: `j08` 2,45 s, úvod 850: `f10` 10,9 s) |
| `throw` | 1,28 | 2,27 | 2,27 | 57 % běhu, od zásahu terče po další hod | ne úvod – robot čeká, až houpající se bonusový terč potká čáru (T14) |
| `timing.stack` | 1,55 | 1,86 | 1,86 | 49 % a 92 % běhu, mezi dvěma položeními | ne úvod – čekání na další průjezd jezdce; `n01`, `n04` lepší než `main`, `d09` horší |

**Vyšší úvod křivky (`intensity.intro` 850, se stejným vrcholem i se sníženým 1050/1250/1450) zkoušen a nepoužit** – měřeno nad sadou mez souboje 1000 + plný počet not + `spawnFloor` 300 a porovnáno s toutéž sadou bez vyššího úvodu: střelnici vrátil na 4,23–4,47 s a hod na 1,9–2,1 s, ale hry načasování spadly pod 30 s (30,4 → 28,8–28,9 s, pásmo délky), novice rytmu 0,40 → 0,15–0,20, `arena.fight` 0,30 → 0,25 (se stejným vrcholem), finále `climax` rytmu zmizelo (P45A finále 0,33 → 0,28–0,30) a plocha pod křivkou přetekla 105 % (1065–1094 ‰; `pacing-curve.test.ts`, směr plánu 95–105 %).

## T19 – konečné měření (panel 40 vět)

11. 10. 2026, celý zápis v `final.md`, data v `final.json`. A = `origin/main` `fc6b99ba`, B = `91d8e4bb`; zapečetěná sada neotevřená.

| Cíl | `main` | T17 | T19 | Cíl | Splněno |
| --- | --- | --- | --- | --- | --- |
| Párový soud nová vs `main` | – | 0,638 | **0,675** (na 28 změněných větách 0,73) | ≥ 0,55 | **ano** |
| Mrtvý čas – medián | 6,37 s | 6,79 s | 6,79 s | ≤ 3 s | ne |
| `rising` | 0,40 | 0,57 | 0,57 | ≥ 0,70 | ne |
| Chování – medián | 1 | 1 | 1 | ≥ 2 | ne |
| Finále | 0,15 | 0,33 | 0,33 | ≥ 0,50 | ne |

Brány beze ztrát drží (hratelné 40/40, prahy T18 beze změny kódu hry). Nesplněné cíle drží hlavně 12 nativních her bez průběhu a 11 her statických žánrů bez hrozeb (23 ze 40 vět) – rozbor v `final.md`. **P45B a P45D v `main` nejsou (nesloučeno).** e2e /play našlo chybějící model výstřelu chování (404), opraveno v `91d8e4bb`.
