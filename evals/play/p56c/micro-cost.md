# P56C T4 – mikrohry a cena jejich ověření (21. 10. 2026)

**Co to znamená:** řetěz má 16 mikroher nad 10 různými ovládáními, každou robot vyhraje za 3–8 s (boss za 7–13 s) a nečinný hráč prohraje. Ověření celého řetězu 5 kol stojí i v nejdražší skladbě kolem 0,3 s, tedy pod 1,5× ověření jedné hry (345 ms). Svědci (`witnessRuns`) se proto ověřují u všech kol, žádná zkratka není potřeba.

## Rozhodnutí o ceně

- Základ (`baseline.md`): ověření jedné hry `verifyMs` medián **229 ms**, mez řetězu 1,5× = **345 ms**.
- Řetěz 5 kol (4 kola + boss, žádné ovládání dvakrát – pravidlo T7), součet mediánů z tabulky:
  - nejdražší skladba: běžec 163 + přeskákání 60 + pruhy 30 + skákačka 21 + boss střelba 30 = **304 ms**; s bossem v pruzích (41) a bez pruhů v kolech 296 ms;
  - běžná skladba (medián kola 11 ms × 4 + medián bosse 30 ms) ≈ **74 ms**.
- **Rozhodnutí: plné `verifyArcade` u každého kola** (svědci, důkaz sloves, robot, nečinný, dvojí přehrání). Záloha z plánu (svědci jen u kola 1, ostatní kola jen `bot_wins` / `idle_loses` / `replay_equal`) se nezapíná.
- Riziko: součet nejhorších běhů (sloupec max) nejdražší skladby je 664 ms, přes mez. Řetěz s během i přeskákáním je vzácný; T6 změří skutečné řetězy a T13 čas do hratelné hry. Levná cesta bez svědků stojí u běžce 43 ms místo 163 ms – je to páka, kdyby T13 nevyšel.
- Kompilace kol (`compileGenre` + `arcadeWorldOf`) tu změřená není; zachytí ji T13 v `timeToPlayableMs`.

## Tabulka `MICRO` (`src/play/chain/micro.ts`)

Měřeno `micro-cost.measure.ts` → `micro-cost.json`: věta „a fox in a forest“, semínka 1, 2, 8, 9, 13, 20, 3 opakování, medián; stroj sdílený se dvěma dalšími autopiloty (čísla orientační, rozptyl až 2×). Robot a nečinný ze sond kalibrace, potvrzené testem `src/play/chain/__tests__/micro.test.ts` (123 testů).

| Záznam | Ovládání | Druh | Hodiny | Úprava kola | Robot vyhraje | Nečinný prohraje | `verifyArcade` ms (max) | bez svědků ms |
|---|---|---|---|---|---|---|---|---|
| `runner.default` | runner | survive | 6 → 5 s | `lengthM` 60 | v hodinách | 2,7–2,8 s | 163 (347) | 43 |
| `platformer.default` | platform | achieve | 8 s | `lengthM` 60, `items` 1, cíl 10 | 3,9–5,2 s | 10 s | 21 (45) | 11 |
| `hop.default` | hop | survive | 8 → 7 s | `rows` 18 | v hodinách | 6,0 s | 60 (158) | 54 |
| `flap.default` | flap | survive | 6 → 5 s | `lengthM` 60 | v hodinách | 0,6 s | 10 (18) | 6 |
| `shooter.default` | shooter | achieve | 8 s | `waves` 1, `enemies` 4, `targets` 3 | 3,5–4,0 s | 10 s | 11 (34) | 5 |
| `timing.stack` | timing | achieve | 8 s | `rounds` 10 | 5,0 s | 2,0 s | 6 (15) | 3 |
| `timing.precision` | timing | achieve | 8 s | `rounds` 10 | 5,0 s | 2,0 s | 5 (6) | 2 |
| `rhythm.default` | rhythm | survive | 6 → 5 s | `seconds` 10 | v hodinách | 3,3 s | 5 (10) | 4 |
| `catch.default` | lanes | achieve | 8 s | `items` 10, cíl 40 | 6,0–7,2 s | 10 s | 27 (46) | 17 |
| `whack.default` | lanes | achieve | 8 s | `targets` 10, cíl 40 | 5,5–6,5 s | 10 s | 21 (35) | 13 |
| `defense.default` | lanes | achieve | 8 s | `enemies` 10, cíl 50 | 5,4–6,0 s | 5,3 s | 30 (63) | 20 |
| `duel.default` | duel | achieve | 8 s | `rounds` 1 | 6,6–7,1 s | 2,0–2,1 s | 5 (10) | 3 |
| `crowd.default` | crowd | achieve | 8 s | cíl 20 | 4,2–4,5 s | 10 s | 7 (15) | 3 |
| `shooter.default.boss` | shooter | boss | 15 s | `waves` 2, `enemies` 4, `targets` 3 | 11,5–11,8 s | 15 s | 30 (33) | 14 |
| `defense.default.boss` | lanes | boss | 15 s | `enemies` 10, cíl 120 | 7,4–8,5 s | 5,3 s | 41 (51) | 29 |
| `duel.default.boss` | duel | boss | 15 s | `rounds` 2 | 11,9–13,0 s | 2,0–2,1 s | 8 (21) | 5 |

„Hodiny 6 → 5 s“: přežití se po kolech zkracuje o 1 s až na `fastest` (`roundSeconds`); test ověřuje kolo 1 i kolo 5.

**Přeměřeno v T7 na semínkách řetězu.** Semínka 1–40 dávají generátorům málo rozptýlený stav (xoroshiro ze malého čísla) a „šťastné“ úrovně: na 60 semínkách z celého rozsahu, jaká losuje řetěz, robot vyhrál chytání s cílem 40 jen 39/60 a bouchání 41/60 (na 1–40 vždy 40/40). Cíl obou je proto **20** (60/60, robot 5,2–6,9 s). Boss obrany končil za 6,5–9,5 s, tedy kratší než běžné kolo v tempu 1300 – teď **`enemies` 16, cíl 240** (40/40, 8,7–12,4 s, jako ostatní bossové). `micro.test.ts` ověřuje i 6 semínek z `roundSeeds`. Řádky tabulky výš jsou z T4 a pro tyto tři záznamy už neplatí.

## Jak kolo vznikne (zjištěno kalibrací)

- **Parametry žánru jdou rovnou do `compileGenre`**, mimo `readGenreSpec`: jeho meze hlídají celou hru 30–90 s (catch `items` ≥ 13, hop `rows` ≥ 45). Generátory mají vlastní spodní meze (catch, whack, slice, defense ≥ 10) – tabulka je drží.
- **Prohrávací hodiny `achieve` = vestavěné `time_limit`** přes `withDepth({ timeLimit })`. Kompilátor je zaokrouhlí na nejméně 10 s (`limitSeconds`, `src/play/arcade/compile.ts`), takže nestihnuté kolo skončí v 10 s, ne v 8. Kratší mez by změnila přehrání uložených her s krátkým limitem. Pravidlo `every` s prohrou místo něj neprojde `verifyArcade`: robot, který vyhraje, ho nikdy nespustí (`VERB_UNPROVED:hurry`).
- **Hodiny `survive` = pravidlo specu `every` s výhrou** (sloveso `survive`). Robot ho spustí tím, že přežije, takže důkaz sloves projde. Hodiny `timer` s `onEnd: 'win'` kompilátor nečte (jen `lose`). Trať musí být delší než hodiny: přeskákání s 10 řadami robot na semínku 1 dojde do cíle za 7,0 s a sloveso `survive` se nespustí – proto 18 řad.
- Počty z věty (`counts`) `microSpec` zahodí, jinak by úroveň zase natáhly.

## Co vypadlo (robot do 8 s nevyhraje nebo nečinný nepropadne)

- `arena.escape` – s hodinami 5 s přežije i nečinný; se 7 s lovci dostihnou robota i nečinného za 5,3 s.
- `arena.collect`, `arena.fight` – robot do 8 s nevyhraje ani s cílem skóre 10 (sebrání, souboj).
- `throw.default` – robot do 8 s nevyhraje ani s cílem 10; jako přežití vyhraje i nečinný.
- `voyage.race` – robot do 8 s nedojede; jako přežití vyhraje i nečinný (jede rovně a nenarazí).
- `slice.default` – cíl skóre skáče kombem: na semínkách 1, 2, 9 robot vyhraje za 0,9 s, na ostatních za 9,1–9,6 s (cíl 30–50).
- Dav jako boss – vlastního bosse na konci trati robot do 15 s nedojde; dav zůstává jako běžné kolo s cílem 20.
- Jiný druh u žánrů v tabulce: běžec jako `achieve` (cíl 10 jen na 1 ze 6 semínek), skákačka jako `survive` (nečinný přežije), přeskákání jako `achieve` (cíl 10 za 0,1 s), rytmus jako `achieve` (7,5–8,3 s, přes 8 s).
