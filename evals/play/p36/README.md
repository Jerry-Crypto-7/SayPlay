# Hloubka her – měřítko P36A (T1)

Výchozí stav změřený 2. 10. 2026 na větvi `features/p36a-depth` (kompilátor `play-compiler-v3/arcade-v2`). Proti němu porovnávají další úlohy P36A: T2 (životy), T3 (nebezpečí úkolu), T4 (délka 30–90 s), T5 (skóre), T10 a T11 (nové žánry). `depth.json` nese vždy poslední přeměření (teď po T5 – skóre, oddíl dole).

## Jak přeměřit

```
npx vitest run --config vitest.measure.mts evals/play/p36/depth.measure.ts
npx vitest run evals/play/p36/depth.test.ts
```

První příkaz přepíše `depth.json` (asi 10 s, bez modelu a bez sítě), druhý report hlídá. Režisér (T9) se měří zvlášť na lokálním modelu – `director.cmd`, viz oddíl T9. Report nenese žádný čas ani datum, takže nový běh bez změny kódu nechá `depth.json` v gitu beze změny. Výpočet je v `depth.ts`.

## Co se měří

Každá ze 200 vět poptávky (`../demand/corpus.json`) a 60 vět vývojové sady (`../p30/dev.json`) jde stejnou cestou jako hra z `/play`: rychlý návrh ze slov (semínko 1, bez modelu) → semínka publikace (`derivedSeeds(seedFrom(věta))`) → první semínko, na kterém robot vyhraje a nečinný hráč ne → `verifyArcade`. Dvacet vět vývojové sady je i v poptávce; počítají se v obou sadách, řádek má klíč `set` + `id`.

| pole | definice |
|---|---|
| `genre` | žánr a režim: `runner`, `platformer`, `arena.collect`, `arena.escape`, `arena.fight`, `quest.spatial`, `quest.station`, `voyage.race`, `voyage.land` |
| `winSeconds` | za kolik vyhraje perfektní robot (`runBot` s plánovačem jako při publikaci): tik konce / 60 Hz; `null` = nevyhrál |
| `inBand` | robot vyhrál za 30–90 s |
| `idle` | „nečinný hráč“: prázdné vstupy až do horizontu jádra (90 s = 5 400 tiků); `won` / `lost` / `unfinished` a tik konce |
| `lives` | životy na startu = čítač `health`. Souboj ho nepoužívá a nese HP hráče (`livesFrom: "hp"`). Hra bez obojího má 1 – první zásah běh ukončí (`livesFrom: "none"`) |
| `scoreDecides` | **definice T5:** cíl `score` (`score_bonus` s `target`, `scoreGoal` ho jmenuje), nebo robotova výhra je aspoň 2× nejhorší výhra na tomtéž světě (`worstScore`). Definice T1 (jen pravidlo čtoucí `score`, bez `grow_to`) platí pro řádky před T5 |
| `botScore` / `worstScore` | čítač `score` na konci robotovy výhry / nejhorší výhra na tomtéž světě: poslední život, aspoň jeden zásah, výhra na limitu, jen body, které výhra vyžaduje (`worstWinOf`); `null` = svět bez bonusu na konci |
| `said` / `carried` | číslo ve větě: životy („3 lives“, „one life“, „no lives“ = 1), cílové skóre („200 points“, „score of 50“), čas („30 seconds“, „two minute“). `carried` = hra ho nese: tolik životů na startu, práh pravidla skóre, `time_limit` nebo `survive_time` se stejnými sekundami |
| `playable` / `publishable` | robot vyhrál a nečinný nevyhrál / navíc prošly všechny kontroly `verifyArcade` |

Podíly v `summary` jsou ze všech vět sady – hra, která nevyšla, se počítá jako nesplněná. `summary.all` = všech 260 řádků.

## Výchozí stav (2. 10. 2026)

| | všech 260 | poptávka 200 | vývojová 60 | cíl plánu |
|---|---:|---:|---:|---:|
| robot vyhraje za 30–90 s | 20 = 7,7 % | 17 = 8,5 % | 3 = 5,0 % | ≥ 85 % |
| nečinný hráč prohraje | 217 = 83,5 % | 163 = 81,5 % | 54 = 90,0 % | ≥ 95 % |
| životy > 1 | 50 = 19,2 % | 39 = 19,5 % | 11 = 18,3 % | ≥ 80 % |
| skóre rozhoduje | 0 | 0 | 0 | T5 |
| hra vyšla / publikovatelná | 260 / 260 | 200 / 200 | 60 / 60 | |

Nečinný hráč nevyhraje nikde. Nedohraje 43 her – všechny skákačky (26) a celý sběr v aréně (17): kdo stojí na místě, tomu tam nic nehrozí.

### Po žánrech (všech 260)

| žánr | vět | medián výhry | rozsah | v pásmu | nečinný prohraje | životy > 1 |
|---|---:|---:|---:|---:|---:|---:|
| runner | 51 | 25,4 s | 25,4 s | 0 | 51 | 0 |
| platformer | 26 | 28,4 s | 27,3–30,3 s | 2 | 0 | 0 |
| arena.escape | 23 | 40,0 s | 3,1–40,0 s | 18 | 23 | 0 |
| arena.collect | 17 | 8,7 s | 7,3–11,9 s | 0 | 0 | 0 |
| arena.fight | 27 | 1,5 s | 1,5–1,6 s | 0 | 27 | 27 (5 HP) |
| quest.spatial | 48 | 9,3 s | 7,7–15,7 s | 0 | 48 | 0 |
| quest.station | 44 | 4,0 s | 1,0–4,0 s | 0 | 44 | 0 |
| voyage.race | 23 | 22,9 s | 22,9–24,1 s | 0 | 23 | 23 (3 životy) |
| voyage.land | 1 | 13,5 s | 13,5 s | 0 | 1 | 0 |

Rozpad po sadách je v `depth.json` (`summary.demand.byGenre`, `summary.dev.byGenre`).

### Čeho si všimnout

- **Délka skoro nezávisí na větě.** Běžec trvá 25,37 s u všech 51 vět, plavba 22,9 s, souboj kolem 1,5 s.
- **Útěk je v pásmu jen díky přežití 40 s** (18 her přesně na 40,0 s). Útěk s věcmi ke sebrání skončí dřív – „collect three keys … while dodging ghosts“ za 3,1 s.
- **Čísla z vět:** žádná z 260 vět neříká počet životů, cílové skóre ani čas (jen „for points“ bez čísla), proto jsou `said` i `carried` dnes všude `null`. Čtečku čísel drží test na vlastních větách; jak hra nese čísla z vět, změří až sada mechanik z T9.
- **Rozložení žánrů na poptávce:** úkol (quest) má 73 z 200 vět = 36,5 %, tedy už dnes nad stropem 35 % z T11. Běžec má 33 = 16,5 %.

## Po T2 – tři životy s milostí (2. 10. 2026)

Přeměřeno s kompilátorem `play-compiler-v4/arcade-v2`. `depth.json` teď nese tenhle stav; výchozí stav výš zůstává jako srovnání.

| | všech 260 | poptávka 200 | vývojová 60 | cíl plánu |
|---|---:|---:|---:|---:|
| robot vyhraje za 30–90 s | 20 = 7,7 % | 17 = 8,5 % | 3 = 5,0 % | ≥ 85 % (T4) |
| nečinný hráč prohraje | 217 = 83,5 % | 163 = 81,5 % | 54 = 90,0 % | ≥ 95 % |
| životy > 1 | **260 = 100 %** | 200 = 100 % | 60 = 100 % | ≥ 80 % – **splněno**, test přepnut na `it` |
| hra vyšla / publikovatelná | 260 / 260 | 200 / 200 | 60 / 60 | |

- **Každý žánr a režim začíná se 3 životy** (souboj: 3 knockouty po 5 HP). Semínka ani časy výhry robota se nepohnuly – robot do ničeho nenaráží.
- **Nečinný hráč prohrává dál, jen později:** medián konce běžec 2,7 → 8,4 s, útěk 5,4 → 10,0 s, souboj 8,4 → 22,9 s, přistání 5,4 → 16,2 s. Nedohraje dál 43 her (skákačka 26, sběr v aréně 17) – stát na místě je tam bezpečné; nebezpečí přidají T3 a T4.
- **Životy, které zatím nic nebere:** sběr v aréně (17), úkol na místě (44) a úkol v prostoru bez pronásledovatelů (46 ze 48). Hra je nese podle plánu (HUD a konec běhu pro P36B jsou ve všech žánrech stejné); co je bere, přidá T3 (nebezpečí úkolu) a T4 (vlny).

## Po T3 – nebezpečí v úkolu (2. 10. 2026)

Přeměřeno s kompilátorem `play-compiler-v5/arcade-v2`. Úkol v prostoru má vždy pronásledovatele (bez honičky ve větě jednoho výchozího, rychlost 60 jako dřív), úkol na místě přetéká: 8 s bez posunu cíle stojí život.

| | všech 260 | poptávka 200 | vývojová 60 | cíl plánu |
|---|---:|---:|---:|---:|
| robot vyhraje za 30–90 s | 20 = 7,7 % | 17 = 8,5 % | 3 = 5,0 % | ≥ 85 % (T4) |
| nečinný hráč prohraje | 217 = 83,5 % | 163 = 81,5 % | 54 = 90,0 % | ≥ 95 % |
| životy > 1 | 260 = 100 % | 200 = 100 % | 60 = 100 % | ≥ 80 % – splněno |
| hra vyšla / publikovatelná | 260 / 260 | 200 / 200 | 60 / 60 | |

| úkol | vět | robot – medián výhry | rozsah | nečinný hráč dřív | nečinný hráč teď |
|---|---:|---:|---:|---:|---:|
| quest.spatial | 48 | 9,3 → **13,9 s** | 7,7–26,3 s | prohra na hodinách 40 s (46 ze 48) | prohra po třech chyceních 9,6–10,6 s |
| quest.station | 44 | 4,0 s (beze změny) | 1,0–4,0 s | prohra na hodinách 40 s | prohra po třech přetečeních, 24,0 s u všech 44 |

- **Podíl prohry nečinného se nepohnul** (83,5 %): úkol prohrával už dřív – na hodinách. Teď prohrává na nebezpečí, dřív, než doběhne čas, a první život ztratí v prostoru asi po 5 s (férový start), na místě po 8 s. Nedohraje dál 43 her (skákačka 26, sběr v aréně 17) – to je T4.
- **Robot vyhrává všech 92 úkolů na stejných semínkách jako dřív.** V prostoru uhýbá pronásledovateli, proto výhra trvá déle; na místě posouvá cíl nejvýš po ~1,5 s, takže přetečení nikdy nezažije.
- **Rychlost pronásledovatele** (sonda, 100 semínek, jeden pronásledovatel): 60 a 70 robot vyhraje 100/100 u 5 cílů i u 8 cílů × 3 stavy, 80 už jen 80/100 u velkého úkolu, 90 15/100. Nečinný hráč při každé z nich přijde o první život po ~5,5 s a o hru po ~10,3 s (férový start roste s rychlostí). Zůstala 60 – nejvíc rezervy pro robota a nečinnému se nic nemění; rychlost je volná páka pro rostoucí tlak v T4.
- Ostatní žánry: řádky, semínka i časy beze změny.

## Po T4, část 1 – běžec a skákačka z úseků (2. 10. 2026)

Přeměřeno s kompilátorem `play-compiler-v7/arcade-v2`. Běžec: trať ze tří úseků (rozjezd, hustší, nejtěžší), každý o stupeň hustší a o 10 % rychlejší; řad tolik, kolik věta počítá (překážky nebo věci ke sběru), bez počtu 22–30 podle semínka, pak natažená nebo zkrácená do 33–84 s robota. Skákačka: tři úseky od lehčí po těžší obtížnost, druhý a třetí začínají checkpointem, ve třetím jezdí pohyblivá plošina; věc ke sběru nad pět přidá dvě plošiny; odhad robota 36–62 s a hodiny = odhad × 1,6 + 10 s, nejvýš 88 s.

| | všech 260 | poptávka 200 | vývojová 60 | cíl plánu |
|---|---:|---:|---:|---:|
| robot vyhraje za 30–90 s | 20 → **95 = 36,5 %** | 71 = 35,5 % | 24 = 40,0 % | ≥ 85 % (části 2–3 T4) |
| nečinný hráč prohraje | 217 → **243 = 93,5 %** | 186 = 93,0 % | 57 = 95,0 % | ≥ 95 % |
| životy > 1 | 260 = 100 % | 200 = 100 % | 60 = 100 % | ≥ 80 % – splněno |
| hra vyšla / publikovatelná | 260 / 260 | 200 / 200 | 60 / 60 | |

| žánr | vět | robot – medián výhry | rozsah | v pásmu | nečinný hráč |
|---|---:|---:|---:|---:|---|
| runner | 51 | 25,4 → **40,0 s** | 35,1–48,0 s (46 různých časů) | 0 → 51 | prohraje 51/51 nárazy, 6,6–31,3 s (medián 12,9 s) |
| platformer | 26 | 28,4 → **42,5 s** | 35,1–51,3 s | 2 → 26 | dřív nedohrál 26/26, teď prohraje 26/26 na hodinách, 71–88 s |

- **Délka podle věty:** žádná z 260 vět počet překážek ani věcí neříká, rozptyl dělá semínko věty (počet řad a plošin). Počet z věty trať natáhne: „run and dodge 20 cars“ / „… 45 cars“ a „collect 3 flies“ / „… 8 flies“ drží test `src/play/genre/__tests__/sections.test.ts`.
- **Nečinný běžec** prohraje později než dřív (8,4 → 12,9 s medián): rozjezd má jednu překážku v řadě, takže do startovního pruhu narazí řidčeji.
- Semínka se nepohnula u žádné věty, ostatní žánry beze změny. Pásmo a nečinného hráče dotáhnou části 2 (aréna: sběr 17 vět bez nebezpečí, souboj, útěk) a 3 (úkol, plavba).

## Po T4, část 2 – aréna ve vlnách (2. 10. 2026)

Přeměřeno s kompilátorem `play-compiler-v8/arcade-v2`. Všechny tři režimy arény jdou ve vlnách, každá další je těžší. Sběr: počet z věty je věcí v jedné vlně, první vlna bez nebezpečí, od druhé vbíhá pronásledovatel (od čtvrté druhý) a každá vlna je rychlejší; hodiny = odhad robota × 1,5 + 15 s, nejvýš 88 s. Útěk s věcmi: totéž od startu s pronásledovateli z věty, každá druhá vlna přivede dalšího (do tří). Přežití: délka 20 s + 10 s na pronásledovatele (aspoň 35 s), na třetinách času přiběhne další. Souboj: ležící soupeři vstanou s HP navíc, přidají se noví (nejvýš tři) a zrychlí; vln tolik, aby odhad přesáhl 44 s + 4 s na soupeře z věty.

| | všech 260 | poptávka 200 | vývojová 60 | cíl plánu |
|---|---:|---:|---:|---:|
| robot vyhraje za 30–90 s | 95 → **144 = 55,4 %** | 108 = 54,0 % | 36 = 60,0 % | ≥ 85 % (část 3 T4) |
| nečinný hráč prohraje | 243 → **260 = 100 %** | 200 = 100 % | 60 = 100 % | ≥ 95 % – **splněno**, test přepnut na `it` |
| životy > 1 | 260 = 100 % | 200 = 100 % | 60 = 100 % | ≥ 80 % – splněno |
| hra vyšla / publikovatelná | 260 / 260 | 200 / 200 | 60 / 60 | |

| žánr | vět | robot – medián výhry | rozsah | v pásmu | nečinný hráč |
|---|---:|---:|---:|---:|---|
| arena.collect | 17 | 8,7 → **49,2 s** | 33,8–63,3 s | 0 → 17 | dřív nedohrál, teď prohraje 17/17 na hodinách 88 s |
| arena.escape | 23 | 40,0 s | 40,0–72,6 s | 18 → 23 | prohraje 23/23, ~10 s |
| arena.fight | 27 | 1,5 → **49,8 s** | 39,1–62,2 s | 0 → 27 | prohraje 27/27, ~23 s |

- **Délka podle věty:** „collect 3 batteries“ / „… 20 batteries“, „collect three keys … dodging ghosts“ / „… 20 keys …“, „escape from one ghost“ / „… 4 ghosts“ a „fights a robot“ / „… three robots“ – druhá věta hraje déle, drží `src/play/genre/__tests__/waves.test.ts`. Na 260 větách počet skoro nikdo neříká, rozptyl dělá semínko.
- **Dvě vady, které vlny odkryly:** (1) dva pronásledovatelé z opačných stran se u stojícího hráče zastavili těsně před dotykem (odstup od sebe přetlačil tah k hráči) – nečinný hráč v útěku „20 keys“ neprohrál; ve světě s vlnami odstup u hráče neplatí. (2) Poslední věc vlny uprostřed arény robot nesebral nikdy – krouží před pronásledovatelem a ten je vždy uvnitř kruhu (4 ze 40 semínek sběru 5 věcí prohrál na hodinách, remix „harder“, který čip zkouší na jediném semínku, pak vracel 422). Věci dalších vln leží aspoň 7 m od středu: 40/40.
- Uložená hra bez `waves` staví týž svět a robot vyhraje na tomtéž tiku (test `stored arena games without waves`). Úkol a plavba beze změny – ty dotáhne část 3.

## Po T4, část 3a – úkol po kolech (2. 10. 2026)

Přeměřeno s kompilátorem `play-compiler-v9/arcade-v2`. Úkol jde po kolech: když jsou všechny cíle hotové, přijde další kolo a vyhrává se až v posledním. V prostoru hotové cíle zmizí a nové leží jinde (mezikruží 7–15 m od středu), každé druhé kolo přiběhne další pronásledovatel (do tří) a všichni zrychlí. Na místě začnou tatáž stanoviště znovu (další objednávka) a lhůta přetečení se po kolech zkracuje z 8 s na 4,5 s. Kol je tolik, aby odhad robota dosáhl 36 s + 1 s na krok kola; stanoviště se dvěma stavy (oprava) drží 1 s, jinak by kolo trvalo 1 s. Hodiny = odhad × 1,5 + 15 s, nejvýš 88 s.

| | všech 260 | poptávka 200 | vývojová 60 | cíl plánu |
|---|---:|---:|---:|---:|
| robot vyhraje za 30–90 s | 144 → **236 = 90,8 %** | 181 = 90,5 % | 55 = 91,7 % | ≥ 85 % – **splněno**, test přepnut na `it` |
| nečinný hráč prohraje | 260 = 100 % | 200 = 100 % | 60 = 100 % | ≥ 95 % – splněno |
| životy > 1 | 260 = 100 % | 200 = 100 % | 60 = 100 % | ≥ 80 % – splněno |
| hra vyšla / publikovatelná | 260 / 260 | 200 / 200 | 60 / 60 | |

| žánr | vět | robot – medián výhry | rozsah | v pásmu | nečinný hráč |
|---|---:|---:|---:|---:|---|
| quest.spatial | 48 | 13,9 → **55,6 s** | 44,1–76,8 s | 0 → 48 | prohraje 48/48, ~10 s |
| quest.station | 44 | 4,0 → **40,0 s** | 32,0–40,0 s | 0 → 44 | prohraje 44/44, 24 s |
| voyage.race | 23 | 22,9 s | 22,9–24,1 s | 0 | část 3b |
| voyage.land | 1 | 13,5 s | | 0 | část 3b |

- **Délka podle věty:** „light two candles …“ / „light eight candles …“ a „flip one pancake in the kitchen“ / „flip three pancakes …“ – druhá věta hraje déle, drží `src/play/genre/__tests__/quest-rounds.test.ts`. Na 260 větách počet skoro nikdo neříká (prostor má 47× pět cílů), rozptyl dělá semínko.
- **Jedno kolo zbude dlouhé práci:** 8 hořících stromů se třemi pronásledovateli trvá samo ~48 s – žánr pak `rounds` nepíše.
- Uložená hra bez `rounds` staví týž svět a robot vyhraje na tomtéž tiku jako na v8 (test `stored quest games without rounds`, tři věty z `depth.json` v8).

## Po T4, část 3b – plavba ve třetinách (2. 10. 2026)

Přeměřeno s kompilátorem `play-compiler-v10/arcade-v2`. Závod nové hry má 620 m místo 350 m a ve třetinách trati houstnou překážky (rozestup 20 → 15 → 11 m) a zrychlují dělové koule (100 → 115 → 130 %). **V pásmu 236 → 259 = 99,6 %** (poptávka 199/200, vývojová 60/60); voyage.race 22,9 → **40,2 s** (40,2–41,5 s, 0 → 23/23), nečinný prohraje 23/23 na hodinách (~71 s).

- **Mimo pásmo zůstává jediná věta, přistání** („flip a bottle so it lands standing“, 13,5 s): je to jeden dotyk; víc přistání za sebou by byly fáze hry, které plán P36A vylučuje.
- **Houstnutí není vidět na každé trati:** kde má poslední třetina jen krátké rovinky, vejde se na každou jedna překážka („boat race through a jungle river…“). Rozptyl délky mezi větami je malý (40–42 s) – délku trati mění jen `lengthM` od režiséra (T8).
- Uložený závod bez `sections` (350 m) jede na tomtéž tiku jako dřív (test `stored voyage races without sections`); připíchnutá čísla rozvržení piráta (`voyageLayout.test.ts`) čtou uložený 350m závod.

## Po T5 – skóre, které rozhoduje (2. 10. 2026)

Přeměřeno s kompilátorem `play-compiler-v11/arcade-v2`. Každá nová hra žánru má `scoring`: kombo za sebrání v řadě (do 1,5 s, ×2 … ×5, ztráta života ho shodí), na konci výhry bonus 50 za každý zbylý život, 100 bez ztráty života a 5 za každou celou sekundu pod limitem (časový limit hry, jinak 90 s). **Skóre rozhoduje 0 → 260/260 = 100 %**; pásmo, nečinný hráč a životy beze změny (99,6 %, 100 %, 100 %), hratelných 260/260.

- **Definice T5:** `scoreDecides` = cíl `score` (`score_bonus` s `target`), nebo robotova výhra (`botScore`) je aspoň dvojnásobek nejhorší výhry na tomtéž světě (`worstScore`: poslední život, aspoň jeden zásah, výhra na limitu, jen body, které výhra sama vyžaduje – cíl `grow_to` nebo `target`). Poměr `botScore / worstScore`: nejmíň 2,0, medián 9,1, nejvýš 12,6.
- **Inference:** 100 % nese hlavně bonus za životy a čas – nejhorší výhra má jeden život a nulový čas, takže 2× splní skoro každá hra konstrukcí. Kombo samo přidá jen tam, kde robot sbírá v řadě (běžec, skákačka, plavba); robot běžce a skákačky mince cíleně nehoní.
- **Aréna kombo nemá:** `score` je tam velikost hrdiny a postup k `grow_to` – násobič by cíl zkrátil. Dostává jen bonus na konci.
- **Cílové skóre z věty** („score 100 points“, „get 500“, `readTargetScore`) dnes v korpusu ani ve vývojové sadě není (`said.score` 0). Kompilátor ho ořízne na skóre, které robot na tom světě opravdu dosáhne (dolů na desítky), takže hra jde vždy vyhrát; dosažený cíl = výhra hned, výhra jinou cestou pod cílem = prohra.

## T9 – režisér s poli hloubky na lokálním gpt-oss-20b (2. 10. 2026)

Měřeno na `2ea6234e` skriptem `director.measure.ts` (spouští ho `director.cmd` pod zámkem GPU, příkaz je v hlavičce skriptu): kompaktní režisér, llama.cpp, teplota 0, strop 4 000 výstupních tokenů – stejné nastavení jako P29B T9 (`../local-director.json`). Robot (`check`) se nepouští, stejně jako tehdy. Výstup `director.json`; srovnání se základem větve ve stejné relaci GPU je v `director-ab.json`.

| | cíl T9 | 26. 9. (P29B) | dnes, běh 1 | dnes, běh 2 (A/B) | základ větve `1d85e991` (A/B) |
|---|---:|---:|---:|---:|---:|
| platná hra, korpus 30 | ≥ 28/30 | 28/30 | **24/30** | 24/30 | 24/30 |
| medián odezvy | ≤ 5,9 s (1,3 × 4,5 s) | 4,5 s | **26,2 s** | 23,7 s | 17,5 s |
| p90 odezvy | | 11,1 s | 56,5 s | 56,2 s | 59,1 s |
| systémový prompt (kompaktní) | | | 5 471 B | | 4 961 B |
| schéma odpovědi (JSON bez mezer) | | | 18 408 B | | 39 245 B |

Vývojová sada `d01–d20`: platná hra 15/20, medián 27,9 s. Věrnost (podíl položek checklistu, které hra přečte / vykreslí): korpus 0,809 / 0,745 (rychlý návrh 0,800 / 0,736), vývojová 0,753 / 0,658 (návrh 0,712 / 0,616).

- **Platných her je pod cílem, ale P36A to nezpůsobil.** Základ větve dává ve stejné relaci taky 24/30. Oba dnešní běhy selhaly na týchž šesti větách (s008, s050, s095, h02, h04, h08), základ na jiných šesti. Všech dvanáct selhání je „cut at max_tokens“: model spotřeboval celých 4 000 tokenů na přemýšlení a nevrátil žádný text.
- **Proč (fakt):** požadavek do llama.cpp nese `max_tokens` a `temperature: 0`, ale ne `reasoning_effort` (`src/server/upstream.ts:1016`) – `effort: 'low'` z konfigurace k modelu nedojde a gpt-oss přemýšlí výchozí délkou. Hostovaná cesta (Groq) `reasoning_effort` posílá, produkční režisér tím tedy postižený není. **Inference:** teplota 0 vysvětluje, proč selhávají pořád tytéž věty; propad z 28/30 vznikl mezi 26. 9. a základem větve (mezi tím přišla mimo jiné odpověď žánrem z P32B), ne v T7/T8. Oprava je úloha F4 v plánu.
- **Odezva:** karta byla během měření sdílená (tři klienti Unrealu a Playwright z jiných worktree, generování ~53 tokenů/s), takže absolutní čísla proti 26. 9. srovnatelná nejsou. Ve stejné relaci je dnešek proti základu 1,35× (jen platné hry 18,6 s proti 13,9 s = 1,34×), těsně nad hranicí 1,3×. **Inference:** prompt je o 10 % delší (pole hloubky v pěti žánrech a `enemyMoves`), délku odezvy ale drží hlavně přemýšlení – rozhodne až měření po F4.

### Sada mechanik (`mechanics.json`)

Dvacet vlastních vět, které říkají životy, cílové skóre, časový limit nebo chování nepřítele (`expect` u každé věty). Hra rychlého návrhu i hra režiséra se postaví cestou publikace (první semínko z `derivedSeeds`, na kterém `compileArcade` projde) a měří se, jestli svět nese, co věta říká.

| pole | věty ho říkají | rychlý návrh nese | režisér nese |
|---|---:|---:|---:|
| životy | 7 | 7 | 7 |
| cílové skóre | 4 | 3 | 2 |
| časový limit | 5 | 1 | 2 |
| chování nepřítele | 9 | 3 | 3 |
| **celkem** | 25 | **14 = 56 %** | **14 = 56 %** |
| věta nese všechno | 20 | 10 | 10 |

„Nese“ znamená: životy = čítač `health` na startu; skóre = cíl `score_bonus.target` přesně jako ve větě (ořez na dosažitelné se nepočítá); limit = `time_limit` nebo `survive_time` s týmiž sekundami; nepřítel = pravidlo `blaster` (`shoot`), klíč `patrol` (`patrol`), pronásledovatel kdekoli ve světě (`chase`). Režisér vrátil platnou odpověď u 15 z 20 vět; u pěti (cut at max_tokens) hraje rychlý návrh a počítá se do sloupce režiséra.

- **Životy** nesou oba vždy – T8 dává životy z věty do týchž `params`, které režisér vidí ve výchozím bodě.
- **Hlídka 0 ze 4 u obou:** věty s hlídkou padnou do sběru v aréně (m11, m18), úkolu na místě (m12) a běžce (m20). Hlídku umí jen úkol v prostoru a útěk se sběrem (T8). Sběr v aréně má pronásledovatele z vln vždy, proto se čte jako `chase`.
- **Střelba 0 ze 2:** střílečka zatím není žánr (T10).
- **Čas:** návrh nese 1 z 5 (úkol v prostoru), režisér 2 z 5 (navíc závod lodí přes `timeLimit`). Sběr v aréně a běžec čas z věty nenesou ani u režiséra.
- **Nevyhratelné hry:** m10 „pop the balloons at the fair in 30 seconds“ – návrh i režisér dají úkol v prostoru s hodinami 30 s, ale kola z T4 se plánují na 36 s a víc, takže robot prohraje na všech čtyřech semínkách (úloha F3). m06 u režiséra: sběr v aréně, který robot nedohraje ani bez cíle skóre (měření bez `check` hru neopraví; v produkci by šla do opravného kola). m19: cíl 150 kompilátor ořízl na 100, víc robot nedosáhne.

## Test (`depth.test.ts`)

- Každá věta obou sad je v reportu právě jednou a se svým textem.
- Souhrn se rovná přepočtu z řádků – ručně přepsaný souhrn neprojde.
- Pásmo platí jen u výhry robota za 30–90 s.
- Čtečka čísel z věty na vlastních větách.
- **Cíle plánu jako `it.fails`** (životy > 1 překlopila T2 na `it`, nečinného hráče T4 část 2, pásmo délky T4 část 3a – teď jsou všechny tři `it`) (≥ 85 % v pásmu, nečinný prohraje u ≥ 95 %, životy > 1 u ≥ 80 %). Dnes procházejí, protože report je pod cílem. Úloha, která cíl splní a report přeměří, uvidí svůj test zčervenat a přepne `it.fails` na `it`: životy T2, délka T4, nečinného hráče ta z T2–T4, která ho dotáhne.
