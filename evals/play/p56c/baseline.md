# P56C – výchozí čísla (T1, 21. 10. 2026)

**Co to znamená:** dnes hraje věta na desktopu v mediánu za 2,5 s od kliknutí, nejpomalejší za 8,6 s. Kompilace jedné hry stojí na serveru kolem 0,3 s a ověření robotem dalších 0,2 s. Řetěz pěti kol se do toho musí vejít (T4 porovná cenu kol s tímhle číslem).

Větev vychází z `origin/main` `ada7dd8b`, posunuté `--ff-only` na P55 `72665fdc` (pahýl čtení věty z P55 T3). Měřeno na `72665fdc` nad `npm run build` (webpack) + `next start -p 3111`, bez čtecího modelu, na stroji, kde souběžně běží další autopiloty (nikdy v klidu).

## Čas do hratelné hry (`scripts/p32/shots.mjs`, `runs/baseline/result.json`)

Sada `evals/play/p32/baseline-sentences.json`, 9 vět, 0 chyb. „Hratelná“ = sonda `data-input-tick` na `arcade-stage`: tik, ve kterém jádro zpracovalo skutečný vstup.

| Měření | Medián | p90 | Max |
|---|---|---|---|
| Desktop 1280×720, od kliknutí na „Play it“ (`timeToPlayableMs`) | **2488 ms** | 4644 ms | 8604 ms (cat) |
| Desktop, studené otevření odkazu `/play/<id>` (`open.timeToPlayableMs`) | 1695 ms | 2054 ms | 2132 ms |
| Pixel 7, CPU 4×, první snímek od navigace (`open.phoneFirstFrameMs`) | 8593 ms | 10341 ms | 11815 ms |
| Pixel 7, CPU 4×, medián FPS za 20 s robotovy hry (`fpsMedian`) | 32 | 41 | 49,2 |

`shots.mjs` na telefonu `timeToPlayableMs` neměří (sonda vstupu běží jen na desktopu); za telefon tu stojí první snímek a FPS. Brána T13 (≤ 1,1× mediánu a ≤ 1500 ms na větu řetězu) se vztahuje k desktopovému řádku od kliknutí.

| Věta | Žánr návrhu | Desktop od kliknutí | Studené otevření | Telefon první snímek | Telefon FPS |
|---|---|---|---|---|---|
| penguin | runner.default | 3159 | 1298 | 6988 | 31,5 |
| firefighter | platformer.default | 3076 | 1272 | 6968 | 37,4 |
| wizard | voyage.race | 1788 | 2035 | 11815 | 24,4 |
| pirate | voyage.race | 1279 | 1676 | 9904 | 20,3 |
| cat | runner.default | 8604 | 1695 | 9340 | 21,0 |
| chef | quest.station | 2206 | 1257 | 8593 | 17,4 |
| dog | quest.spatial | 3654 | 1974 | 5385 | 36,0 |
| knights | duel.default | 2488 | 2132 | 9972 | 38,4 |
| rocket | voyage.race | 1295 | 1860 | 7672 | 49,2 |

## Cena kompilace a ověření (`baseline.measure.ts` → `baseline-cost.json`)

`POST /api/play/games {sentence}` si u návrhu ze slov `timings` do hry neukládá (jen verze od režiséra), takže čísla z odpovědi serveru nejdou přečíst. Měření proto volá tutéž funkci jako server – `draftGameSpecWithMeta` a `publishReadSpec` nad paměťovým úložištěm se semínky z věty – a `compileMs` / `verifyMs` změří `publishReadSpec` sám. Každá věta 3×, medián.

| | Medián přes věty | Max |
|---|---|---|
| `compileMs` (skladba včetně robota skladatele, rozvržení) | **315,9 ms** | 845,7 ms (cat) |
| `verifyMs` (`reportFor` = `verifyArcade`: robot, nečinný, dvojí přehrání, svědci) | **229,3 ms** | 589,6 ms (firefighter) |

Rozptyl mezi třemi běhy téže věty ±10–30 %. Duel (knights) a závod rakety (rocket) stojí pod 30 ms – krátké světy.

**Pro T4:** ověření jedné hry ≈ 230 ms (medián), 1,5× = **~345 ms** na celé ověření řetězu 5 kol; kompilace + ověření jedné hry ≈ 545 ms.

Commit, ze kterého větev vychází: `72665fdc` (`test(play): P55 sealed genre holdout result`).
