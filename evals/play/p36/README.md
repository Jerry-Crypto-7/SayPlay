# Hloubka her – měřítko P36A (T1)

Výchozí stav změřený 2. 10. 2026 na větvi `features/p36a-depth` (kompilátor `play-compiler-v3/arcade-v2`). Proti němu porovnávají další úlohy P36A: T2 (životy), T4 (délka 30–90 s), T5 (skóre), T10 a T11 (nové žánry).

## Jak přeměřit

```
npx vitest run --config vitest.measure.mts evals/play/p36/depth.measure.ts
npx vitest run evals/play/p36/depth.test.ts
```

První příkaz přepíše `depth.json` (asi 10 s, bez modelu a bez sítě), druhý report hlídá. Report nenese žádný čas ani datum, takže nový běh bez změny kódu nechá `depth.json` v gitu beze změny. Výpočet je v `depth.ts`.

## Co se měří

Každá ze 200 vět poptávky (`../demand/corpus.json`) a 60 vět vývojové sady (`../p30/dev.json`) jde stejnou cestou jako hra z `/play`: rychlý návrh ze slov (semínko 1, bez modelu) → semínka publikace (`derivedSeeds(seedFrom(věta))`) → první semínko, na kterém robot vyhraje a nečinný hráč ne → `verifyArcade`. Dvacet vět vývojové sady je i v poptávce; počítají se v obou sadách, řádek má klíč `set` + `id`.

| pole | definice |
|---|---|
| `genre` | žánr a režim: `runner`, `platformer`, `arena.collect`, `arena.escape`, `arena.fight`, `quest.spatial`, `quest.station`, `voyage.race`, `voyage.land` |
| `winSeconds` | za kolik vyhraje perfektní robot (`runBot` s plánovačem jako při publikaci): tik konce / 60 Hz; `null` = nevyhrál |
| `inBand` | robot vyhrál za 30–90 s |
| `idle` | „nečinný hráč“: prázdné vstupy až do horizontu jádra (90 s = 5 400 tiků); `won` / `lost` / `unfinished` a tik konce |
| `lives` | životy na startu = čítač `health`. Souboj ho nepoužívá a nese HP hráče (`livesFrom: "hp"`). Hra bez obojího má 1 – první zásah běh ukončí (`livesFrom: "none"`) |
| `scoreDecides` | **definice T1:** běh končí pravidlem, které čte čítač `score` (`scoreGoal` ho jmenuje). `grow_to` v aréně se nepočítá – `score` tam jen počítá sebrané věci a výhra přijde vždy při témže čísle. T5 definici zpřesní: cíl `score`, nebo se nejlepší a nejhorší výhra robota liší aspoň 2× |
| `botScore` | čítač `score` na konci robotovy výhry – jen pro srovnání, dnes nic nerozhoduje |
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

## Test (`depth.test.ts`)

- Každá věta obou sad je v reportu právě jednou a se svým textem.
- Souhrn se rovná přepočtu z řádků – ručně přepsaný souhrn neprojde.
- Pásmo platí jen u výhry robota za 30–90 s.
- Čtečka čísel z věty na vlastních větách.
- **Cíle plánu jako `it.fails`** (životy > 1 překlopila T2 na `it`, zbývají pásmo délky a nečinný hráč) (≥ 85 % v pásmu, nečinný prohraje u ≥ 95 %, životy > 1 u ≥ 80 %). Dnes procházejí, protože report je pod cílem. Úloha, která cíl splní a report přeměří, uvidí svůj test zčervenat a přepne `it.fails` na `it`: životy T2, délka T4, nečinného hráče ta z T2–T4, která ho dotáhne.
