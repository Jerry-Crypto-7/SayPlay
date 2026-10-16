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

## Rozhodnutí

- **T6 – souboj v aréně bere dash i štít, výchozí řešení z „Co nevíme“ nebylo potřeba.** Robot intermediate s akcí vyhraje 10/10 (štít, dash, oba), sloveso dokázané 4/4. Úder a krádež souboj nebere (`FIGHT_ABILITIES`): úder má vlastní Attack, krást není co. Novice: bez akce 6/10, štít 5/10, dash 6/10, **oba naráz 1/10** – robot novice s dvěma akcemi častěji stojí a čeká na blok, který mu pozdní reakce nevyjde. Brána hlídá jen horní mez (hra nesmí zlehčit); dvojice dash + štít ve větě o souboji je vzácná, proto zůstává zapsaná, ne opravená.
- **T7 – zahazování po jedné akci, limit 2 s zatím nedržený, příčina není T7.** Pokus „bez neprokázané akce“ přibude jen receptu se dvěma akcemi (u jedné akce splývá s pokusem bez akcí), což je výchozí řešení z „Co nevíme“. Dev panel při zátěži stroje (CPU 76 %): stav po T6 p95 2183 ms, po T7 2250 ms (+3 %); `botUsed` 0,64 → 0,70. Proti výchozím 1391 ms je to +62 % – víc vět nese akci (T3–T6) a každá neprokázaná stojí běh robota navíc. Přeměří T11 a T12 v klidu; přeteče-li i tam, další krok je zkrátit pokus se šablonou, ne T7.
