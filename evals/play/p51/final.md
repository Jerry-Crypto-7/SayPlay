# P51 – konečné měření na novém holdoutu (18. 10. 2026)

Holdout `evals/play/p51/holdout.json` (60 vět, které napsal nezávislý subagent) otevřený poprvé `2026-10-18T16:43:23Z` (`holdout-opened.json`); otisk SHA-256 nad LF bajty ověřen před čtením obsahu: `3b36fe64a2d7864245799f62bf91ce8a0423c45c7900c36efa640f03db321352` (shoda s otiskem ze vzniku sady). A = `0618344a` (T2: značka `genre.v5`, na kterou nic nečeká – svět `origin/main` `04700849`, viz `baseline.json`), B = `1b8204b9` (HEAD větve, `genre.v5`), obojí týmž měřidlem (`finale.measure.ts` s `P47A_SET=p51 P47A_HOLDOUT=1`), robot `intermediate`, semínko publikace. Měří se rychlá verze; po otevření holdoutu se nic neladilo.

| Cíl (holdout, 60 vět) | Splnit | A | B | Splněno |
|---|---|---|---|---|
| Finále nebo boss | ≥ 0,8 | 0,77 | **0,93** | ano |
| Chování nepřátel, medián | ≥ 2 | 2 | 2,5 | ano |
| Mrtvý čas (nejdelší mezera), medián | ≤ 3 s | 3,22 s | 2,5 s | ano |
| Mrtvý čas, nejhorší žánr | ≤ 4 s v každém | 18,18 s (chodec) | **7,93 s** (aréna boj), míč 4,31 s | **ne** |
| Stoupání | ≥ 0,7 | 0,78 | 0,93 | ano |
| Hratelné | 100 % | 60/60 | 60/60 | ano |
| Párový soud nad větami panelu, které P51 mění, podíl B | ≥ 0,6 | – | **0,66** (B 12, A 6, remíza 1) | ano |

## Po žánrech (holdout)

| Žánr | Vět | Finále A | Finále B | Mrtvý čas A | Mrtvý čas B | Chování A → B | Stoupá A → B |
|---|---|---|---|---|---|---|---|
| aréna se sbíráním | 13 | 11/13 | 13/13 | 2,22 s | 2,22 s | 3 → 4 | 0,85 → 1 |
| chodec | 6 | 0/6 | 5/6 | 18,18 s | 2,55 s | 0,5 → 0,5 | 0,17 → 0,83 |
| řízení | 6 | 5/6 | 5/6 | 3,22 s | 3,22 s | 2 → 2 | 1 → 1 |
| běžec | 9 | 9/9 | 9/9 | 4,98 s | 2,5 s | 3 → 3 | 1 → 1 |
| skákačka | 5 | 5/5 | 5/5 | 3,1 s | 3,1 s | 3 → 3 | 1 → 1 |
| souboj | 3 | 3/3 | 3/3 | 2,23 s | 2,23 s | 1 → 2 | 1 → 1 |
| stanoviště | 3 | 3/3 | 3/3 | 1,9 s | 1,67 s | 0 → 2 | 1 → 1 |
| rytmus | 3 | 3/3 | 3/3 | 4 s | 4 s | 0 → 0 | 1 → 1 |
| míč | 2 | 0/2 | 2/2 | 3,27 s | **4,31 s** | 0 → 1 | 0 → 1 |
| klouzání | 2 | 0/2 | **0/2** | 1,87 s | 1,87 s | 0,5 → 0,5 | 0 → 0 |
| aréna boj | 2 | 2/2 | 2/2 | 7,93 s | **7,93 s** | 4 → 4 | 0,5 → 0,5 |
| quest v prostoru | 2 | 2/2 | 2/2 | 2,5 s | 2,5 s | 3 → 3 | 1 → 1 |
| střílečka | 2 | 2/2 | 2/2 | 6,56 s | 3,5 s | 2,5 → 2,5 | 1 → 1 |
| hod | 1 | 1/1 | 1/1 | 1,47 s | 1,47 s | 1 → 2 | 0 → 1 |
| načasování | 1 | 0/1 | 1/1 | 1,02 s | 1,25 s | 0 → 0 | 1 → 1 |

Na holdoutu nemá žádná věta v B horší finále než v A (finále neztratila žádná, boss se nikde nezměnil na climax). Mezera delší o víc než 1 s je u dvou vět míče, které finále získaly (h029 3,33 → 4,35 s, h043 3,2 → 4,28 s).

## Co splněné není a proč

- **Mrtvý čas v aréně boj 7,93 s** (h015 „ninja frog vs sumo crab, best of three rounds“ 5,93 s, h046 „wizard school snowball fight…“ 9,93 s). P51 arénu boj neměnil – rozsah mrtvého času byl chodec, střílečka, běžec a rytmus. A i B mají táž čísla. Dev sada arénu boj nemá a na panelu P45 jsou obě věty pod 4 s (f10 2,17 s, j08 3,07 s), proto ji plán nejmenoval.
- **Mrtvý čas míče 4,31 s.** Obě věty míče finále získaly (soupeř-boss za terči, T4), a s ním i delší konec hry: mezera vzrostla o ~1 s, stejně jako na dev sadě v T4 (3,35 → 4,02 s). Fakt: mezera roste s finále; proč přesně (čekání na soupeře, nebo míč na cestě) se na holdoutu nezkoumalo.
- **Klouzání 0/2 a chodec h013 bez finále.** Všechny tři hry mají díly P42 (`assemblyParts`: h014 a h048 padající překážka, h013 padající věc k chytání – ověřeno přečtením specu, nic se neladilo). Podle rozhodnutí T3 hra s díly P42 značku nové hry nedostane a staví trať `genre.v4`, takže průběh ani finále nemá (důvod `entry`). Klouzání a chodec bez dílů mají finále na dev sadě 9/9 a na panelu 4/4.
- **h058 „Snow falling softly on an empty train station at night“** (řízení, věta bez hry) je bez průběhu v A i B.
- Rytmus je přesně na hranici 4 s (h033 4,25 s); P51 ho podle rozhodnutí T7 neměnil.

## Panel P45 a vývojová sada

| Sada | Strana | Finále | Chování (medián) | Mrtvý čas (medián) | Stoupání | Hratelné |
|---|---|---|---|---|---|---|
| panel P45 (40) | A | 0,68 | 1,5 | 2,76 s | 0,85 | 40/40 |
| panel P45 (40) | B | 0,93 | 2 | 2,5 s | 1 | 40/40 |
| dev (30, ladilo se na ní) | A | 0,27 | 0,5 | 5,21 s | 0,57 | 30/30 |
| dev (30, ladilo se na ní) | B | 0,97 | 1 | 2,5 s | 0,97 | 30/30 |

Na panelu nemá žádná věta v B horší finále ani mezeru delší o víc než 1 s.

## Srovnání s P47A

| | Finále | Chování (medián) | Mrtvý čas (medián) | Stoupání |
|---|---|---|---|---|
| P47A B na holdoutu P47A (`p47a/final.json`) | 0,72 | 2,5 | 2,99 s | 0,78 |
| A na holdoutu P51 (kód P47A) | 0,77 | 2 | 3,22 s | 0,78 |
| **B na holdoutu P51** | **0,93** | 2,5 | 2,5 s | 0,93 |

Holdouty mají jiné věty: kód P47A dává na holdoutu P51 finále 0,77, na svém 0,72. Férový přírůstek P51 je proto A → B na téže sadě: finále +0,16, mrtvý čas −0,72 s, stoupání +0,15.

## Párový soud

Slepý párový soud P45A (Codex nad listem dvou klipů, list jako `sheet.png` v prázdné dočasné složce) nad 19 větami panelu P45, u kterých se řádek měřidla mezi A a B liší (finále, chování, mezera nebo stoupání); ostatních 21 vět má v A i B týž výsledek měřidla. A = `0618344a` na 3292, B = `1b8204b9` na 3291, oba servery jen rychlá verze (bez klíče modelu): **B 12, A 6, remíza 1, podíl B 0,66** (cíl ≥ 0,6), 19 volání Codexu bez chyby (ze sdíleného denního stropu 50 jich jiné projekty vybraly 21, celý panel by se nevešel). Strana buildu se losovala ze semínka; soudce volil levý sloupec ve 0,447 případů.

| Žánr | Věty | B | A | Remíza |
|---|---|---|---|---|
| chodec | f18, m07, j04 | 3 | 0 | 0 |
| běžec | m08, s003 | 2 | 0 | 0 |
| stanoviště | m04, u03 | 2 | 0 | 0 |
| aréna se sbíráním, chytání, míč, hod | m02, m11, d01, h03 | 4 | 0 | 0 |
| střílečka | f03, d04 | 1 | 1 | 0 |
| klouzání | f12 | 0 | 1 | 0 |
| souboj | f02, h05 | 0 | 2 | 0 |
| načasování | n01, n04, d09 | 0 | 2 | 1 |

- **Souboj a načasování soudce u B nevolil ani jednou.** Fakt: změna P51 je u souboje hozená věc každý třetí útok, u načasování rychlých posledních 20 kol. Domněnka: osm snímků klipu věc ani zrychlený konec nezachytí, nebo zrychlený konec vypadá hůř – ověřit soudem nad klipem posledních 10 s, ne laděním.
- Příkaz `play-fidelity.mjs fun` filtr `--only` nebere, proto běžely jeho kroky zvlášť: `run --set p45-panel --pace-clip --draft-only --gpu --only …` proti 3292 a 3291, pak `pairwise --concurrency 1`; skript potřebuje `node --experimental-strip-types`. Výsledek `evals/play/fidelity/runs/p51-t11-pairwise.json` (gitignorovaný).

Zdrojová data: `evals/play/p51/final.json` (cíle, souhrny A a B, po žánrech, řádky po větách holdoutu i panelu), otevření `holdout-opened.json`, měřidlo `evals/play/p47a/finale.measure.ts`.
