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

## Rozhodnutí

- **T6 – souboj v aréně bere dash i štít, výchozí řešení z „Co nevíme“ nebylo potřeba.** Robot intermediate s akcí vyhraje 10/10 (štít, dash, oba), sloveso dokázané 4/4. Úder a krádež souboj nebere (`FIGHT_ABILITIES`): úder má vlastní Attack, krást není co. Novice: bez akce 6/10, štít 5/10, dash 6/10, **oba naráz 1/10** – robot novice s dvěma akcemi častěji stojí a čeká na blok, který mu pozdní reakce nevyjde. Brána hlídá jen horní mez (hra nesmí zlehčit); dvojice dash + štít ve větě o souboji je vzácná, proto zůstává zapsaná, ne opravená.
