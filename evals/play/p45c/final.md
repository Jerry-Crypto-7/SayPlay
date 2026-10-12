# P45C – konečné měření (T19)

11. 10. 2026, `final.json`. **A** = `origin/main` `fc6b99ba` (P45A + P45E, hraje tytéž hry jako `0714a352`) z dočasného worktree na 3218, **B** = tato větev `91d8e4bb` na 3217; obě strany po čerstvém `npm run build`, bez `.env.local` a s prázdným `PLAY_STORE_DIR`. Jen vývojový panel P45A (40 vět), zapečetěná sada neotevřená – tu otevře až společné měření po sloučení C a D:

```
node --experimental-strip-types scripts/play-fidelity.mjs fun --set p45-panel --base-a http://127.0.0.1:3218 --base-b http://127.0.0.1:3217 --run p45c-t19-final --commit-a fc6b99ba --gpu   # --ignore-budget
```

`final.json`: `result` = výstup nástroje doslova (`evals/play/p45/result-p45c-t19-final.json`, ten v gitu není), `byGenre` = rozpad po žánrech se sloupcem T17 (`mid`), `pairs` = každý pár se zdůvodněním soudce a výsledkem téhož páru v T17. Telemetrie běží jen nad B, sloupec `main` je `evals/play/p45/baseline.json`. 40 volání soudce, čísla jednoho běhu, nic se nepřeměřovalo ani neladilo.

## Výsledek

| Cíl | `main` | T17 | **T19** | Cíl | Splněno |
| --- | --- | --- | --- | --- | --- |
| Párový soud nová vs `main` (`bShare`) | – | 0,638 | **0,675** (20 výher, 6 proher, 14 remíz; `leftWinShare` 0,475) | ≥ 0,55 | **ano** |
| Mrtvý čas – medián `longestGapS` | 6,37 s | 6,79 s | **6,79 s** | ≤ 3 s | ne |
| Podíl her, kde intenzita stoupá (`rising`) | 0,40 | 0,57 | **0,57** | ≥ 0,70 | ne |
| Rozmanitost chování – medián `behaviourCount` | 1 | 1 | **1** | ≥ 2 | ne |
| Podíl her s finále | 0,15 | 0,33 | **0,33** | ≥ 0,50 | ne |
| Medián událostí za sekundu | 0,94 | 0,89 | **1,02** | – | – |

Párový soud splněný, čtyři cíle telemetrie ne. Na 28 větách, které P45C mění (vše kromě plošinovky a nativních `control:*`), je podíl pro novou (19 + 3/2) / 28 = **0,73**. Šum panelu je ~0,08 (40 párů), platí jen směr.

Proti T17 se otočily čtyři páry: `h05` souboj a `m08` běžec z prohry na výhru (opravy T18 a R2), `m01` útěk v aréně z výhry na prohru a `m09` plošinovka z remízy na výhru. **Odvozeno (ne změřeno):** hry `m01` a `m09` se od T17 nezměnily (T18 ani R2 na arénu a plošinovku nesahají), takže tyhle dva obraty jsou šum klipu a soudce – stejně velký jako zisk z oprav.

## Beze ztrát

Kód hry se od T18 změnil jen v kreslení (`91d8e4bb`, výstřely chování), takže prahy z T18 platí beze změny a nepřeměřovaly se.

| Brána | Hodnota | Zdroj | Práh | Splněno |
| --- | --- | --- | --- | --- |
| Hratelné hry | 40/40 | tento běh | 100 % | ano |
| Přehrání = hash | 100 % | `after.json` (T18), brána přehrání 39/39, e2e přehrání 51/51 | 100 % | ano |
| p95 návrhu (`buildMs`) | 1554 ms | `after.json` (T18) | ≤ 2 s | ano |
| Nečinný hráč nevyhraje | 100 % | `depth.json` (T18) | 100 % | ano |
| Délka 30–90 s | 90 % | `depth.json` (T18); mimo pásmo jen nativní hry bez průběhu | ≥ 85 % | ano |
| Začátečník 0,3–0,7 | 54/54 buněk | `difficulty.json` (T18) | každá živá buňka | ano |
| Pokročilý | min 0,90 | `difficulty.json` (T18) | ≥ 0,8 | ano |
| `e2e/p35-perf.spec.ts` | zelené, práh beze změny | tento běh | – | ano |

## Po žánrech

Hodnoty `main → T19` (mrtvý čas je medián žánru), jen hratelné hry.

| Žánr | Věty | Nová / `main` / remíza | Podíl pro novou | T17 | Mrtvý čas (s) | `rising` | Chování | Finále |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `arena.collect` | 3 | 2 / 0 / 1 | 0,83 | 0,83 | 9,92 → 10,48 | 0 → 0,67 | 1 → 4 | 0 → 0,67 |
| `arena.escape` | 3 | 2 / 1 / 0 | 0,67 | 1 | 24,67 → 15,87 | 0 → 0,33 | 2 → 4 | 0 → 0,33 |
| `arena.fight` | 2 | 2 / 0 / 0 | 1 | 1 | 4,95 → 6,90 | 0 → 0,5 | 2 → 4 | 1 → 1 |
| `shooter` | 2 | 2 / 0 / 0 | 1 | 1 | 4,35 → 5,67 | 0 → 1 | 1 → 2,5 | 0 → 1 |
| `quest.spatial` | 3 | 3 / 0 / 0 | 1 | 1 | 14,70 → 10,32 | 0 → 0,33 | 1 → 2 | 0 → 0 |
| `quest.station` | 3 | 2 / 0 / 1 | 0,83 | 0,83 | 1,80 → 1,80 | 0,33 → 0,33 | 0 → 0 | 0 → 0 |
| `flap` | 2 | 2 / 0 / 0 | 1 | 1 | 2,68 → 2,98 | 1 → 1 | 0 → 0 | 0 → 0 |
| `throw` | 1 | 1 / 0 / 0 | 1 | 1 | 1,28 → 2,27 | 0 → 0 | 0 → 0 | 0 → 0 |
| `timing.stack` | 3 | 1 / 1 / 1 | 0,5 | 0,5 | 1,25 → 1,90 | 1 → 1 | 0 → 0 | 0 → 0 |
| `duel` | 2 | 1 / 1 / 0 | 0,5 | 0 | 2,26 → 2,26 | 1 → 1 | 1 → 1 | 0 → 0 |
| **`rhythm`** | 2 | 0 / 2 / 0 | **0** | 0 | 3,00 → 4,00 | 1 → 1 | 0 → 0 | 0 → 1 |
| `runner` | 2 | 1 / 1 / 0 | 0,5 | 0 | 21,10 → 18,06 | 1 → 1 | 0,5 → 1,5 | 1 → 1 |
| `platformer` | 3 | 1 / 0 / 2 | 0,67 | 0,5 | 8,38 beze změny | 0 | 1 | 0 |
| `control:steer` | 3 | 0 / 0 / 3 | 0,5 | 0,5 | 21,25 beze změny | 0,67 | 0 | 0,67 |
| `control:walker` | 3 | 0 / 0 / 3 | 0,5 | 0,5 | 21,92 beze změny | 0,33 | 0 | 0 |
| `control:ball` | 1 | 0 / 0 / 1 | 0,5 | 0,5 | 3,27 beze změny | 0 | 0 | 0 |
| `control:glide` | 1 | 0 / 0 / 1 | 0,5 | 0,5 | 2,15 beze změny | 0 | 0 | 0 |
| `control:move_free` | 1 | 0 / 0 / 1 | 0,5 | 0,5 | 6,32 beze změny | 1 | 1 | 0 |

## Prohry – co soudce viděl a proč

- **`rhythm` `u01`, `u02` – prohra i po T18.** Soudce u nové verze dál vidí noty, které zůstávají daleko od lišty, a tichou lištu v úvodu. Příčina z T18: první nota čeká na řídký úvod křivky (`placeByCurve` váží `intenzita − spawnFloor`), `RHYTHM_CURVE` mění jen počet not; mrtvý čas 4,42 → 4,00 s, `main` 3,00 s.
- **`duel` `f02`** – soupeř opakuje týž pohyb, v `main` se mění častěji. `h05` se po T18 otočil na výhru; zbytek délky souboje (42,6 s proti ~34 s v `main`) drží strop agresivity 1200 kvůli začátečníkovi (T18).
- **`runner` `s003`** – soudce u `main` vidí víc těsných průjezdů kolem nábytku. `m08` se po R2 (hrozby v pruzích) otočil na výhru.
- **`timing.stack` `d09`** – nová verze staví věž déle a skončí později; stejná prohra jako v T17 (mrtvý čas 1,25 → 1,90 s, čekání na další průjezd jezdce).
- **`arena.escape` `m01`** – soudce u nové verze vidí prázdnou arénu v 31,5 s. Hra je stejná jako v T17, kdy tentýž pár vyhrála – šum (výše).

## Nesplněné cíle – příčina

Žádný ze čtyř cílů telemetrie se od T17 nepohnul: T18 změnil jen souboj a rytmus a medián ani podíly to nepřeklopilo.

- **Mrtvý čas 6,79 s (cíl ≤ 3 s, `main` 6,37 s).** 27 ze 40 her má nejdelší mezeru nad 3 s. 11 z nich jsou nativní hry, na které P45C nesahá (`control:steer`, `control:walker`, plošinovka ~8–22 s). Zbylých 16 jsou žánry s průběhem: aréna sběr/útěk/souboj a prostorový úkol 10 her, běžec, střelnice a rytmus po dvou; kde jejich mezery leží, rozebírá README (T18) – u souboje v aréně a střelnice uprostřed hry, u rytmu na začátku. Medián ≤ 3 s by chtěl aspoň 20 her pod 3 s, dnes jich je 13.
- **Stoupání 0,57 (cíl ≥ 0,70).** Nestoupá 17 her: 8 nativních bez průběhu a 9 s průběhem – útěk a prostorový úkol po dvou, sběr a souboj v aréně po jedné, úkol na stanovišti 2 a hod 1. Na cíl chybí 5 her.
- **Chování medián 1 (cíl ≥ 2).** Chování ≥ 2 má 13 her, všechny ze žánrů s hrozbami a průběhem. 18 her nemá hrozbu vůbec: 7 nativních a 11 statických žánrů (rytmus, načasování, hod, poletování, úkol na stanovišti), kterým P45C podle plánu nepřidává nepřátele („Co nevíme“). Medián 2 chce 20 her.
- **Finále 0,33 (cíl ≥ 0,50).** Finále má 13 her. P45A pozná jen poraženého bosse (≥ 3 zásahy, pak zmizí) nebo zhoustlý konec vyhraného běhu. Finále statických žánrů (náhlá smrt, závěrečný sprint, dvojí úkol) P45A nevidí, pokud konec není 1,5× hustší; prostorový úkol (3 hry) končí velkým strážcem nad posledním cílem, který zásahy nebere, takže se jako poražený boss nezapočte (odvozeno z T12). Na cíl chybí 7 her.

**Odvozeno (ne změřeno):** všechny čtyři cíle drží dvě skupiny vět, na které P45C nemůže: 12 nativních her bez průběhu a 11 her statických žánrů bez hrozeb – dohromady 23 ze 40 vět panelu.

## Sloučení s `main`, testy a hranice

- **Sloučení:** `git fetch` 11. 10. nepřinesl nic nového – `origin/main` `fc6b99ba` (P45A + P45E) je ve větvi od T17 (`c9c3d91b`), bez konfliktů. **P45B a P45D v `main` nejsou (nesloučeno).** Otázku, kolik her ztratí bosse, když se do stropu 16 pravidel vejde i P45B, proto změřit nejde; patří do společného měření po sloučení.
- **Celá sada sama** (`npx vitest run`, stroj v klidu): 12376 prošlo, 35 červených, 6 přeskočených. Všech 35 byly časové limity a jeden chybějící gitignorovaný plán (`submission-check`, `plans/P8-odevzdani.md`). Opakování 26 souborů najednou: 17 červených, opět jen limity. Každý z 12 zbylých souborů samotný: 11 zelených, `director.test.ts` jednou přes limit 30 s – změřeno samotné s delším limitem: test trvá 25,3 s na větvi a 23,4 s na `main`, prošel. Přepsané měřené artefakty (`evals/play/compiled/report.json`, `evals/play/regression/p41-report.json`) vrácené.
- **Brána přehrání** 39/39, `tsc` čistý.
- **e2e /play** (`E2E_PORT=3217`, 8 souborů): první běh 49/51. **Chyba nalezená a opravená:** scéna běžce stahovala neexistující `sniper_shot-lod1.glb` (404) – výstřely chování neměly model; `91d8e4bb` je kreslí jako střelu, test `pacing-models` je hlídá (mutace červená). Po opravě 50/51; zbývající `play-physics-replay` chce server s `PLAY_LAB=1` (laboratoř je jinak v produkci 404, padá stejně i na `main`) – s ním 1/1.
- **Hranice:** `kernel.ts` a `rules/**` beze změny proti `origin/main`, `contract.ts` a `verify.ts` jen připsané řádky (0 odebraných).
