# P37A T10 – po rodinách sloves: návrh ze slov proti baseline T2

Naměřeno 2026-10-04 na `bec99921` (zdroják hry poslední změna `50ebfc26`). Data: `after.json`, zapisuje ho `after.measure.ts`. Baseline T2: `baseline.md`, `baseline.json` (beze změny).

## Jak se měřilo

- **Sady:** `dev-150.json` (150 vět porotce) a `../p30/dev.json` (60 vět P30). Zapečetěná `test-200` zůstala zavřená.
- **Jen návrh ze slov, bez režiséra** – stejně jako T2: `next start` na portu 3371 bez režiséra, panoramat, hlasu a sdíleného úložiště; měření nic neplatilo.
- **Po:** offline na HEAD (`measureSentence`, `offlineChain`) + nové klipy `play-fidelity.mjs run --clip --draft-only --gpu` (běhy `p37a-t10-dev150`, `p37a-t10-p30dev`; robot hrál ve 210/210 klipech).
- **Před:** offline sloupce z `baseline.json` (měřeno na `ea31005f`) + tytéž klipy T2, **přesouzené slepým soudcem** (`b4475a4f`: soudce vidí jen `frame-N.png` v prázdné složce). Neslepý soudce T2 dal 5/150 a 11/60; slepý nad stejnými klipy 7/150 a 14/60. Srovnává se slepý se slepým.
- **Soudce:** astra přes `codex exec`, tři snímky po 0,5 s, jen vývojové měření (předplatné). Verdikt jednoho snímku se nepočítá.
- **Nové sloupce proti T2** (bez nich by tabulka neukázala, co rodiny změnily): *hrdina v klipu* (slepý soudce poznal všechny hrdiny věty), *položky ve specu* (podstatné jméno věty má ve hře roli), *sloveso čte ovládání* (řetěz věrnosti: ovládání, mechanika, pravidlo nebo režim žánru sloveso hraje).

## Čísla před → po

| sada | vět | sloveso v klipu | hrdina modelem | hrdina v klipu | položky ve specu | položky modelem | položky kostkou | sloveso čte ovládání | robot vyhraje | nečinný prohraje |
|---|---|---|---|---|---|---|---|---|---|---|
| **dev-150 celkem** | 150 | 7 → **13** (5 → 9 %) | 59 → **53**/104 (57 → 51 %) | 28 → 26/104 | 36 → **111**/199 (18 → 56 %) | 13 → **37**/199 (7 → 19 %) | 20 → 70/199 (10 → 35 %) | 63 → **110**/150 (42 → 73 %) | 150 → 150 | 150 → 150 |
| – unknown-verb | 60 | 2 → 1 | 35 → 28/60 | 17 → 13 | 12 → 41/71 | 2 → 10/71 | 10 → 30/71 | 30 → 55/60 | 60 → 60 | 60 → 60 |
| – non-game | 40 | 0 → 1 | 1 → 1/3 | 1 → 1/3 | 4 → 34/63 | 3 → 12/63 | 1 → 22/63 | 3 → 14/40 | 40 → 40 | 40 → 40 |
| – fantasy | 30 | 4 → 7 | 18 → 19/30 | 7 → 9 | 14 → 20/38 | 6 → 7/38 | 6 → 11/38 | 19 → 25/30 | 30 → 30 | 30 → 30 |
| – mix | 20 | 1 → 4 | 5 → 5/11 | 3 → 3 | 6 → 16/27 | 2 → 8/27 | 3 → 7/27 | 11 → 16/20 | 20 → 20 | 20 → 20 |
| P30 dev | 60 | 14 → 14 (23 %) | 32 → 32/35 (91 %) | 20 → 20/35 | 54 → 56/75 | 40 → 42/75 | 7 → 7/75 | 43 → 45/60 | 60 → 60 | 60 → 60 |

„Hrdina modelem“ a „hrdina v klipu“ se počítají jen u vět, jejichž checklist hrdinu jmenuje. P30 dev se skoro nepohnul – jeho věty mají herní slovesa, která návrh slyšel už před P37A.

**Žánr na dev-150:** dřív `arena.collect` 98 ze 150, teď `arena.collect` 29, `quest.spatial` 26, `quest.station` 24, `arena.escape` 22, `rhythm` 12, `timing.stack` 7, `voyage.race` 7, `duel` 6, `arena.fight` 5, `runner` 3, `throw` 3, `platformer` 2, `shooter` 2, `flap` 1, `voyage.land` 1.

## Brány z Goal

| brána | cíl | po T10 | stav | příčina |
|---|---|---|---|---|
| sloveso poznané z klipu (dev-150) | ≥ 60 % | 13/150 (9 %) | **nesplněno** | viz níž – mechanika se hraje, činnost hrdiny se nekreslí |
| hrdina modelem (dev-150) | ≥ 90 % | 53/104 (51 %) | **nesplněno** | rytmus hrdinu nekreslí (−7 vět), katalog nemá povolání (gardener, mole, lumberjack, mechanic, baker …) |
| robot vyhraje | ≥ 92 % | 210/210 (100 %) | splněno | |
| nečinný prohraje | ≥ 95 % | 210/210 (100 %) | splněno | |
| AI verze, která není lepší, se nenabídne | – | brána zastaví 25/27 horších, nabídne 20/150 (13 pravých výher) | částečně | měřeno v T8 (`director.md`), tady se nepřeměřovalo – běh bez režiséra; brána blokuje 29 pravých výher, protože checklist z věty zná jen jména, která použil návrh |
| zapečetěná sada otevřená jednou | – | zavřená | čeká | T11 po schválení |

### Proč sloveso z klipu nevidí

**Naměřeno:** rodiny sloves změnily hru – sloveso čte ovládání u 110/150 vět (dřív 63), podstatná jména věty mají roli u 111/199 položek (dřív 36), sběr v aréně spadl z 98 na 29 vět. Soudce ale sloveso pozná jen u 13/150. U vět s vyplněným `heroAction` je to 5/63 (`stir` 3/11, `fix` 1/4, `dig` 1/2; `sweep` 0/13, `knit` 0/8, `chop` 0/8, `stack` 0/7), bez něj 8/87. Podle žánru: `quest.station` 4/24, `quest.spatial` 2/26, `arena.collect` 1/29, `arena.escape` 1/22, `rhythm` 0/12.

**Co soudce píše** (výběr, běh `p37a-t10-dev150`):
- u03 „stir“ (stanice): *„Food and effects change, but no utensil visibly stirs.“*
- u06 „water“ (úkol v prostoru): *„Plant grows, but no watering motion or flowing water appears.“*
- u11 „sweep“ (aréna): *„Character moves and glowing objects disappear; no sweeping motion is visible.“*
- u01 „knit“ (rytmus): *„Moving blocks show no knitting action, needles, or yarn.“*
- u24 „repair“ (stanice): *„Changing glow, sparks, and smoke show no clear repair activity.“*

**Závěr (inference):** soudce vidí, že se hra mění (rostlina roste, bloky mění barvu, věci mizí), ale ne činnost, kterou věta jmenuje. `heroAction` stopa A plní, kreslí ho až P37B – bez animace činnosti hrdiny klip sloveso ukázat nemůže. Druhá půlka jsou cíle úkolů a stanic kreslené kostkou nebo pevným modelem typu úkolu: položky `no-model` v `quest.spatial` a `quest.station` ve 48 větách (soup pot, bread, sunflowers, acorns, garden gnomes) – render P37B a modely P37D. Z 13 poznaných sloves na dev-150 je 8 nových (plant, change, light, gallop, transform, make, chase, jump): soudce je pozná tam, kde je sloveso pohyb (cválat, skákat, honit) nebo viditelný výsledek (klíček roste, lucerna se rozsvítí).

**Šum soudce:** 5 vět změnilo verdikt bez změny žánru a bez `heroAction` (u46, u57, s095 ztratily; s008, s050 získaly). Rozdíl 7 → 13 na dev-150 je tedy jen o málo nad šumem jednoho běhu.

### Proč hrdina modelem klesl

**Naměřeno:** 7 vět rodiny řemeslo (u01, u02, u16, u35, u37, u41, u59 – pletení, šití, skládání) přešlo ze sběru v aréně do rytmu, a rytmus hrdinu nekreslí: na snímku `u01-draft-clip-2.png` jsou jen dráhy s notami a ulice, babička-kočka ani krb nejsou vidět (řetěz věrnosti: `not-read-by-control`). u54 (girl) přešla do závodu, kde ji řetěz vede jako `no-model`. Dvě věty se zlepšily (u32 teenager, f09 mořská panna). Zbylé ztráty jsou hrdinové bez modelu v katalogu: 10× `quest.spatial` (gardener, mole, street artist, lumberjack, shepherd), 9× `quest.station` (mechanic, diver, postman, zookeeper, baker).

**Závěr (inference):** cesta k 90 % vede přes modely povolání (P37D) a přes rozhodnutí, jestli rodina řemesla má hrát rytmus, který hrdinu ani prostředí neukáže, nebo stanici (`quest.station`), kde hrdina vidět je. To je ladění – patří až do nového běhu.

## 10 největších skupin ztrát po T10

Seřazeno podle počtu postižených vět (dev-150 + P30 dev). Skupina = `why × role × žánr`.

| # | why | role | žánr | vět | příklady | kam patří |
|---|---|---|---|---|---|---|
| 1 | no-model | item | quest.spatial | 26 | u06:sunflowers, u07:acorns, u10:garden gnomes, u18:train, u20:pumpkins | cíl úkolu se kreslí pevným modelem typu úkolu – render P37B; chybějící modely P37D |
| 2 | not-recognized | verb | arena.collect | 25 | u05:lasso, u09:rake, u11:sweep, u12:mop, u13:vacuum | `heroAction` bez animace – P37B |
| 3 | not-recognized | verb | quest.spatial | 24 | u06:water, u08:dig, u10:mow, u18:paint, u19:sculpt | totéž |
| 4 | no-model | item | quest.station | 22 | u03:soup pot, u04:bread, u23:swords, u24:robots, u27:letters | jako #1 |
| 5 | not-recognized | verb | quest.station | 21 | u03:stir, u04:bake, u23:hammer, u24:repair, u25:weld | jako #2 |
| 6 | not-in-spec | item | arena.collect | 20 | u11:dust, u13:sofa, u14:storm, u28:mom, u33:pen | podstatné jméno bez role i po rodině – A, nový běh |
| 7 | not-recognized | verb | arena.escape | 20 | n02:fall asleep, n08:wait, n13:refuse, n19:wait, n26:ignore | absurdní přenos hraje útěk, sloveso mimo hry pohybem ukázat nejde |
| 8 | not-recognized | setting | quest.spatial | 17 | u06:rooftop garden, u07:burned forest, u19:winter festival, u20:barn | prostředí – mimo A (P37B, kulisy P37D) |
| 9 | not-recognized | setting | arena.collect | 15 | u11:magic tower, u13:apartment, u15:river, u26:haunted mansion | totéž |
| 10 | not-recognized | setting | quest.station | 15 | u04:bakery, u24:junkyard garage, u27:post office, u40:snowy village | totéž |

Další v pořadí: `not-in-spec|item|quest.station` 14, `not-in-spec|verb|arena.collect` 13 (n07:call, n18:remember, n22:start – slovesa, pro která rodina není), `not-recognized|item|arena.escape` 13 (dentist, neighbor, teacher – lidé věty mimo hry jako soupeři), `not-in-spec|item|arena.escape` 12.

**Proti T2:** skupiny `not-in-spec` (#1, #2, #6 v T2, dohromady 99 + 83 + 20 vět) spadly na 20 + 13 + 11 – rodiny dostaly podstatná jména a sloveso věty do hry. Na jejich místo nastoupily `not-recognized` a `no-model`: věc je ve hře, ale klip ji neukáže. To je hranice stopy A; další krok je render (P37B) a modely (P37D), ne další rodiny.
