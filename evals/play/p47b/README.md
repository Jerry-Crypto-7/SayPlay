# P47B – Akce z věty je ve hře

Plán: `plans/P47B-akce-z-vety-2026-10-15.md`. Ladí se jen na `verb-dev.json`, `evals/play/p46/action-sentences.json` a panelu P45. Holdout čte jen T12, jednou.

## Panel sloves (T1)

- **Kdo psal věty:** podagent naslepo 15. 10. 2026 – viděl jen pět akcí (`strike, dash, shield, shoot, grab`), jejich rodiny sloves a seznam žánrů. Neviděl kód, slovník (`ABILITY_CUES`, `extract.ts`) ani žádnou jinou sadu vět.
- **Rozsah:** 92 vět – 14 na každou akci (asi pětina se dvěma akcemi) a 22 pastí (`family: "trap"`, `wants: []`): podstatné jméno „shield/blocks“, sloveso nepřítele („sharks bite the hull“), složeniny („dodgeball“, „photo shoot“, „shooting stars“), zápor („never steal“) a slovesa žánru („pushes dung balls“, „kicks a football“).
- **Rozdělení:** po rodinách, `pure-rand` `xoroshiro128plus`, **semínko 4747**, Fisher–Yates přes `uniformInt`, prvních ⌈2n/3⌉ z každé rodiny do dev. Výsledek: `verb-dev.json` 65 vět, `verb-holdout.json` 27 vět.
- **Pečeť:** `holdout-seal.json` = SHA-256 holdoutu nad LF bajty. `__tests__/panel.test.ts` hlídá štítky, pokrytí (každá akce ≥ 6 vět v ≥ 4 žánrech dev), pasti (≥ 10 dev, ≥ 5 holdout), pečeť a překryv s panelem P45, větami P46A, test-200 a zapečetěnou sadou P45 (ta jen přes otisky normalizovaných vět).

## Měřidlo a výchozí stav (T2)

`actions.ts` staví na `actionRowOf` z P46: chtěné akce ze štítku `wants`, jinak z regexu P46. Řádek navíc nese `dropped` (chtěná akce, kterou hra nemá, s prvním platným důvodem: slovník sloveso nezná → `VERB_UNPROVED:<akce>` z `composition.issues` → ovládání akci nebere → generátor akce nebere), `spurious` (akce ze slovesa – `abilities` nebo doplněk střelby – kterou štítek nechce; vlastní mechanika žánru jako střelba střelce se nepočítá) a `draftMs` (rychlá verze, fyzika načtená předem jako na živé cestě).

Spuštění: `P47B_SET=dev|p46a P47B_OUT=<soubor> npx vitest run --config vitest.measure.mts evals/play/p47b/actions.measure.ts`; holdout jen s `P47B_OPEN_HOLDOUT=1`.

| Sada | Vět / chce akci | hasAction | botUsed | verbFired | spuriousRate (pasti) | p95 draftMs |
|---|---|---|---|---|---|---|
| dev panel (`baseline-dev.json`) | 65 / 50 | 0,16 | 0,24 | 0,24 | 0,20 (3 z 15) | 1391 |
| věty P46A (`baseline-p46a.json`, regex P46) | 20 / 19 | 1,00 | 1,00 | 0,89 | – | 2153 |

- **Proč dev padá:** 34 ze 41 chybějících akcí je „slovník sloveso nezná“ (T3). Zbytek: `VERB_UNPROVED` dash 3×, štít 1×, úder 1× (T4–T7), ovládání bez akce (let bez dashe/štítu, střelec, bludiště) 6×, souboj v aréně 1×, 3× bez zapsaného důvodu.
- **Pasti s akcí:** v76 (holubi kradou → `grab`), v79 (stráže blokují → štít), v86 („refuses to shoot“ → střelba).
- **`draftMs` je čas stroje** – dva samostatné běhy dev daly p95 1720 a 1391 ms. P46A má p95 nad 2 s už ve výchozím stavu (2153 ms, souběžný běh dal 3075).
- **Zábava panelu P45** (`fun-baseline.json`): hratelných 40/40, mrtvý čas medián 4 s, gradace 0,63, chování medián 1, finále 0,38.

## Výsledek T11

Měřidlo T2 nad dev panelem a větami P46A (holdout ne), stroj bez souběžné zátěže. „Začátek T11“ = stav po T3–T10 před opravami T11.

| Sada | Stav | hasAction | botUsed | verbFired | spuriousRate (pasti) | p95 draftMs |
|---|---|---|---|---|---|---|
| dev panel | výchozí T2 (`baseline-dev.json`) | 0,16 | 0,24 | 0,24 | 0,20 (3 z 15) | 1391 |
| dev panel | začátek T11 | 0,62 | 0,74 | 0,72 | 0,00 | 1906 |
| dev panel | po T11 (`after-dev.json`) | **0,74** | **0,84** | **0,82** | **0,00** (0 z 15) | 1719 |
| věty P46A | výchozí T2 (`baseline-p46a.json`) | 1,00 | 1,00 | 0,89 | – | 2153 |
| věty P46A | po T11 (`after-p46a.json`) | **1,00** | **1,00** | **0,89** | – | 1988 |

- **Cíl dev (0,9 / 0,9 / 0,9, pasti ≤ 0,05) splněný jen u pastí.** Zbylých 14 vět níž – každá potřebuje novou mechaniku žánru nebo jiný výběr žánru, ne malou opravu.
- **Věty P46A:** hasAction a botUsed 1,00 jsou nad 0,88 / 0,92 z `actions-after.json`. verbFired 0,89 je pod 0,92 – stejně jako už ve výchozím stavu T2; chybí a02 a a07 (níž).
- **Opravy T11:** let `glide_course` bere akce (matice T9 je dokázala, rychlá verze je ale zahazovala podle generátoru) – v05, v10, v15, v24. Robot klouzání nevybije štít na útes, který sám obletí – v30, v39. Sloveso po místě s předložkou patří hrdinovi: „runs through the city dodging“ (demo, dash zpět) a „a thief on a skateboard grabs“ (P46A a18, od T3 bez krádeže).
- **Červené testy z T3–T6:** demo-game opravil slovník (výše). V p46-fixtures padalo o02 na chybu kódu – `addon_control` neznal holý souboj (`fight` bez průběhu hry), opraveno v knihovně. U j08 je nová položka `action` zamýšlená: od T6 souboj v aréně bere dash i štít, rychlá verze má štít z „defends“ a AI verze k němu přidá dash z odpovědi režiséra. `evals/play/p46e/after.json` je přeměřený, změnil se jen řádek j08 a souhrn (`action` 0 → 1).

### Co zbývá

- v13 „a stray dog ducks … and bites“, v40 „a gladiator blocks … and kicks“ – `VERB_UNPROVED:strike`: aréna se sběrem má jednoho pronásledovatele a robot ho přidělí dashi či štítu, úder nemá na koho. `enemiesFor` aréně nepřátele nepřidá, chtělo by to nové rozmístění.
- v17 „a hamster swerves … in a maze“ – `control walker takes no dash`; v41 „a sorceress shields … zaps … in the maze“ – `walker takes no shield/shoot`; v45 „a tiny wizard casts spells … castle maze“ – `walker takes no shoot`. Bludiště bere jen krádež; dash, štít a střelba v bludišti jsou nový žánr akcí jako T9 pro let.
- v61 „a sneaky boy pickpockets guards“ – `generator walker_stealth takes no grab`. Zkoušeno: se zapnutou krádeží robot plížení na 4 semínkách stráž neokrade (`VERB_UNPROVED:grab`).
- v18 „A mail carrier ducks under low branches“, v21 „a squid dashes away from fishing nets“, v70 „… dodges the barking dog“ – `VERB_UNPROVED:dash`: běžec ze vzorů má v každé řadě volný pruh, robot překážku nepotká. Zkoušeno: přejet s připraveným dashem do pruhu překážky (5 i 5–12 m) – dash se dokáže, ale robot prohraje na všech semínkách. Stejná příčina jako T4-R1.
- v20 „a gecko zips past hungry birds“ – akce ve hře je, ale robot intermediate na semínku publikace zmáčkne dash o 2 tiky pozdě a pravidlo se nespustí (dokonalý robot ho dokáže).
- v53 „an archer … snatches their loot bags“ – `control shooter takes no grab`; v55 „a space ranger blocks meteors“ – `shooter takes no shield`. Střelec akce nebere schválně (T9, `capabilities.ts`).
- v54 „an alien gunslinger duels the sheriff, firing a ray gun“ – `control duel takes no shoot`; v67 „a pickpocket duels another thief to swipe“ – `duel takes no grab`. Recept vybere souboj podle „duels“; přestřelka by chtěla jiný výběr žánru, ne akci.
- Věty P46A a02 (úder + střelba) a a07 (dash + úder) na běžci – na prvním vyhraném semínku publikace robot intermediate spustí jen jednu ze dvou akcí (běžec ze vzorů jako výše); v P46 `actions-after.json` obě ještě prošly.

## Výsledek T12

Commit měření `1593ad90`, 16. 10. 2026. Holdout otevřený **jednou** (`holdout-opened.json`: čas, commit, SHA-256 `f163a285…` – sedí s `holdout-seal.json`). Po otevření se nic neladilo.

| Sada | Stav | hasAction | botUsed | verbFired | spuriousRate (pasti) | p95 draftMs |
|---|---|---|---|---|---|---|
| dev panel | výchozí T2 (`baseline-dev.json`) | 0,16 | 0,24 | 0,24 | 0,20 (3 z 15) | 1391 |
| dev panel | po T11 (`after-dev.json`) | 0,74 | 0,84 | 0,82 | 0,00 (0 z 15) | 1719 |
| věty P46A | po T11 (`after-p46a.json`) | 1,00 | 1,00 | 0,89 | – | 1988 |
| **holdout** (27 vět / 20 chce akci) | T12 (`holdout.json`) | **0,65** | **0,70** | **0,70** | **0,14** (1 z 7) | **1611** |
| zapečetěná sada P45 (100 / 18), měřidlo P46 | P46 konečné (`../p46/final-actions.json`) | 0,72 | 0,67 | 0,67 | – | – |
| zapečetěná sada P45, měřidlo P46 | T12 (`sealed-recheck.json`) | 0,78 | 0,78 | 0,78 | – | – |

- **Cíl holdoutu (≥ 0,85 / 0,85 / 0,85, pasti ≤ 0,1) nesplněný v žádné ze čtyř hodnot.** Zapsáno poctivě, neladí se.
- **p95 draftMs ≤ 2000 ms splněno:** holdout 1611 ms (dev po T11 1719, P46A 1988). Stroj při běhu holdoutu vytížený na 10–26 % (cizí sezení).
- **Sealed-recheck – sada už otevřená, není to nezávislé měření.** Zapečetěnou sadu P45 otevřelo už konečné měření P46 (`../p45/sealed-opened.json`) a P47B ladila po něm. Číslo je jen zpráva vedle 0,72 / 0,67 / 0,67: 0,78 / 0,78 / 0,78 (chtěné akce z regexu P46, ne ze štítku).

**Fakta – co na holdoutu chybí (7 vět bez celé akce, 1 past):**

- Ovládání nebo generátor akci nebere – 5 vět: v01 „goat headbutts“ (`generator arena_catch takes no strike`), v09 „Grandma whacks the moles“ (`generator quest_spatial takes no strike`), v14 „knight bashes skeletons and steals“ v bludišti (`control walker takes no strike`, krádež je), v31 „goalkeeper octopus blocks shots“ (`control ball takes no shield`), v56 „chameleon zips … and spits goo“ (`control move_free takes no shoot`, dash je).
- Slovník sloveso nezná – 2 věty: v23 „darts“, v26 „veers away“ (obě dash).
- Akce ve hře je, robot ji nepoužil – 1 věta: v19 „matador sidesteps“ (dash v aréně).
- Past s akcí – v78 „enemy turrets fire missiles“ dostane střelbu, sloveso patří nepříteli.

**Odvozené (inference):** pět ze sedmi chyb je stejná třída jako „Co zbývá“ u dev – žánr, který akci nemá, ne slovník. Dvě slovesa, která slovník nezná, a past se slovesem nepřítele ukazují, že slovník T3 je laděný na slovesa dev panelu; na nových větách drží hůř (0,65 proti 0,74).

**Zábava panelu P45** (`fun-after.json` proti `fun-baseline.json`, totéž měřidlo `../p45/fun.measure.ts`): hratelných 40/40 → 40/40, mrtvý čas medián 4 → 3,64 s, gradace 0,63 → 0,65, chování medián 1 → 1, finále 0,38 → 0,38, události/s 1,18 → 1,18. Změnil se jen řádek j08 (souboj v aréně, štít z T6): nejdelší mezera 11,62 → 3,07 s, gradace ne → ano. Nic horší.

**E2E** (`npm run build`, `next start` na portu 3273, `FALLBACK_SMOKE_URL`): projekt `chromium` 50/50 zelených za 9,5 min – `interface-language` 3, `p35-perf` 17, `play-abilities` 8, `play-addons` 5, `play-arcade` 12, `play-drive` 4, `play-input` 1. Projekt `pixel7-touch` bere jen `play-touch` – navíc pušteno 5/5 zelených. Práh `p35-perf` beze změny (spec se na větvi nezměnil).

**Celá vitest sada** (samotná, JSON reportér; stroj ale vytěžovaly cizí procesy – ComfyUI, jiný vitest, Chrome, 40–90 % CPU): 14 212 testů, 14 183 prošlo, 23 padlo, 6 přeskočeno. Rozdělení:

- Prostředí worktree – 1: `scripts/__tests__/submission-check.test.ts` (ENOENT `plans/P8-odevzdani.md`, gitignorované).
- Červené už před P47B – 1: `evals/play/p45/__tests__/sealed.test.ts` „is not opened yet in the repository“. `sealed-opened.json` commitnul konečný P46 (`abe38f04`), test se od P45A nezměnil – červený od `abe38f04`, P47B ho nezpůsobila.
- Časový limit nebo časový práh pod zátěží, samotný soubor zelený – 20 testů v 6 souborech: `upgrade.test.ts` 13 (i práh 7759 < 6000 ms), `publish-moderation.test.ts` 2, `budgets.test.ts` 2, `external-import.test.ts` 1, `p41/golden.test.ts` 1, `compiled/compile-report.test.ts` 1 (práh 631,6 ≤ 500 ms). Navíc soubor `rules/coverage.test.ts` padl celý bez zprávy (3 testy přeskočené); samotný 25/25.
- `src/play/compile/__tests__/scenery-carve.test.ts` „the carve removes zero triangles“ – limit 30 s. Samotný 2× červený na limit (36 s, 33 s), s delším limitem zelený (aserce drží). Srovnání se základem `abe38f04` za stejné zátěže, střídavě: základ 34–58 s, HEAD 24–50 s. **Odvozené:** není to regrese P47B – test počítá geometrii mřížky (`src/play/compile`, `src/geom`), kterou větev nemění, a základ limit překročí stejně.

Testy přepsaly měřené artefakty `evals/play/compiled/report.json` a `evals/play/regression/p41-report.json` – vrácené (`git checkout`), závěr nemění. `npx tsc --noEmit` čisté.

## Rozhodnutí

- **T6 – souboj v aréně bere dash i štít, výchozí řešení z „Co nevíme“ nebylo potřeba.** Robot intermediate s akcí vyhraje 10/10 (štít, dash, oba), sloveso dokázané 4/4. Úder a krádež souboj nebere (`FIGHT_ABILITIES`): úder má vlastní Attack, krást není co. Novice: bez akce 6/10, štít 5/10, dash 6/10, **oba naráz 1/10** – robot novice s dvěma akcemi častěji stojí a čeká na blok, který mu pozdní reakce nevyjde. Brána hlídá jen horní mez (hra nesmí zlehčit); dvojice dash + štít ve větě o souboji je vzácná, proto zůstává zapsaná, ne opravená.
- **T4-R1 – dash běžce se složenými díly má cooldown 1,5 s místo 1 s (`guardParts`, `dashCooldown`).** Řady trati jdou v husté pasáži ~75 tiků po sobě a dash s 1 s prorazil každou: „a squirrel runs and dodges falling acorns“ novice 8/10 proti 5/10 bez akce (strop 0,7). S 1,5 s novice 6/10, intermediate 10/10, sloveso dokázané na semínkách 1–4. Běžec bez dílů a ostatní ovládání zůstávají na 1 s – fixtura P46A bránu drží (novice 1/10), v18, v21 a v70 překážku nepotkají. Dev panel beze změny (0,74 / 0,84 / 0,82, pasti 0).
- **T7 – zahazování po jedné akci, limit 2 s zatím nedržený, příčina není T7.** Pokus „bez neprokázané akce“ přibude jen receptu se dvěma akcemi (u jedné akce splývá s pokusem bez akcí), což je výchozí řešení z „Co nevíme“. Dev panel při zátěži stroje (CPU 76 %): stav po T6 p95 2183 ms, po T7 2250 ms (+3 %); `botUsed` 0,64 → 0,70. Proti výchozím 1391 ms je to +62 % – víc vět nese akci (T3–T6) a každá neprokázaná stojí běh robota navíc. Přeměří T11 a T12 v klidu; přeteče-li i tam, další krok je zkrátit pokus se šablonou, ne T7.
- **T12 – holdout pod cílem (0,65 / 0,70 / 0,70, pasti 0,14), zapsáno, neladí se.** Holdout byl jednorázový; každá oprava teď by se ladila na něm. Limit 2 s drží (p95 1611 ms), takže krok „zkrátit pokus se šablonou“ z T7 není potřeba. Další zlepšení je nová mechanika žánrů (úder v `arena_catch`, `quest_spatial` a bludišti, štít v míči, střelba ve volném pohybu) a měří se na nové slepé sadě, ne na tomhle holdoutu.
