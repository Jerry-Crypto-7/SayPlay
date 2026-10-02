# PLAY – regresní harness nad 40 zlatými větami

Naměřeno 2026-10-02T06:19:00.743Z, semínko 1, bez modelu (návrh ze slov). Generuje `golden.test.ts`.

Spec platný 40/40 · zkompilováno 40/40 · publikovatelné 40/40 · žánr trefen 26/32 · kompilace medián 99.1 ms, p90 273.3 ms

| id | kbelík | archetyp | žánr | trefa | kompilace | publikovatelné | keypointy | výhra (tik) | entity | pravidla | kompilace ms | kontrola ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chase_escape-1 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 3 | 3 | 513.9 | 390.8 |
| chase_escape-2 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 3 | 3 | 233.9 | 291 |
| chase_escape-3 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 3 | 3 | 188.6 | 285.8 |
| chase_escape-4 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 3 | 3 | 248.9 | 283.3 |
| collect_exit-1 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 300 | 9 | 3 | 75 | 18.9 |
| collect_exit-2 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 436 | 13 | 3 | 87.1 | 24.2 |
| collect_exit-3 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 169 | 6 | 3 | 14 | 12.8 |
| collect_exit-4 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 397 | 10 | 3 | 17.4 | 28.2 |
| survival_timer-1 | survival_timer | survival_timer | arena.escape | ano | ano | ano | 4/4 | 3600 | 3 | 3 | 273.3 | 326 |
| survival_timer-2 | survival_timer | hazard_crossing | runner.default | **ne** | ano | ano | 4/4 | 2897 | 111 | 4 | 168.1 | 145.4 |
| survival_timer-3 | survival_timer | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2700 | 3 | 3 | 372.1 | 478.1 |
| survival_timer-4 | survival_timer | survival_timer | arena.escape | ano | ano | ano | 4/4 | 4800 | 3 | 3 | 397.4 | 604.5 |
| checkpoint_race-1 | checkpoint_race | hazard_crossing | voyage.race | ano | ano | ano | 4/4 | 1374 | 48 | 5 | 99.1 | 97 |
| checkpoint_race-2 | checkpoint_race | hazard_crossing | voyage.race | ano | ano | ano | 4/4 | 1374 | 48 | 5 | 74.1 | 49.5 |
| checkpoint_race-3 | checkpoint_race | switch_puzzle | quest.spatial | **ne** | ano | ano | 5/5 | 998 | 11 | 4 | 117.7 | 103.3 |
| checkpoint_race-4 | checkpoint_race | hazard_crossing | runner.default | **ne** | ano | ano | 4/4 | 2897 | 111 | 4 | 144.4 | 155.5 |
| delivery-1 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 510 | 11 | 4 | 20.5 | 25.3 |
| delivery-2 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 970 | 10 | 4 | 54.3 | 81.1 |
| delivery-3 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 970 | 10 | 4 | 76.3 | 83.4 |
| delivery-4 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 970 | 10 | 4 | 82.3 | 47.6 |
| switch_puzzle-1 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 970 | 10 | 4 | 81.4 | 49 |
| switch_puzzle-2 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 183 | 8 | 4 | 6.9 | 8.3 |
| switch_puzzle-3 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 970 | 10 | 4 | 99.4 | 173.5 |
| switch_puzzle-4 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 970 | 10 | 4 | 37.5 | 111.9 |
| hazard_crossing-1 | hazard_platforming | hazard_crossing | platformer.default | ano | ano | ano | 4/4 | 2430 | 71 | 7 | 187.8 | 162.1 |
| hazard_crossing-2 | hazard_crossing | hazard_crossing | platformer.default | ano | ano | ano | 4/4 | 2430 | 71 | 7 | 124.4 | 141.3 |
| hazard_crossing-3 | hazard_crossing | hazard_crossing | runner.default | **ne** | ano | ano | 4/4 | 2897 | 111 | 4 | 145 | 191.7 |
| hazard_crossing-4 | hazard_crossing | hazard_crossing | platformer.default | ano | ano | ano | 4/4 | 2430 | 71 | 7 | 160.3 | 209.9 |
| combat_lite-1 | combat_lite | combat_lite | arena.fight | ano | ano | ano | 4/4 | 415 | 4 | 3 | 24.5 | 65.5 |
| combat_lite-2 | combat_lite | combat_lite | arena.fight | ano | ano | ano | 4/4 | 415 | 4 | 3 | 29.7 | 20.5 |
| combat_lite-3 | combat_lite | switch_puzzle | quest.spatial | **ne** | ano | ano | 5/5 | 998 | 11 | 4 | 82.9 | 122.4 |
| combat_lite-4 | combat_lite | switch_puzzle | quest.spatial | **ne** | ano | ano | 5/5 | 970 | 10 | 4 | 66.1 | 57.5 |
| ambiguity-1 | ambiguity | hazard_crossing | runner.default | – | ano | ano | 4/4 | 2897 | 111 | 4 | 148.7 | 131 |
| contradiction-1 | contradiction | hazard_crossing | runner.default | – | ano | ano | 4/4 | 2897 | 111 | 4 | 120 | 180.6 |
| scale-1 | scale | survival_timer | arena.escape | – | ano | ano | 4/4 | 4800 | 3 | 3 | 499 | 584.5 |
| remix-1 | remix | hazard_crossing | runner.default | – | ano | ano | 4/4 | 2897 | 111 | 4 | 90.3 | 158.9 |
| remix-2 | remix | hazard_crossing | runner.default | – | ano | ano | 4/4 | 2897 | 111 | 4 | 73.6 | 131.2 |
| remix-3 | remix | hazard_crossing | runner.default | – | ano | ano | 4/4 | 2897 | 111 | 4 | 84.9 | 157.1 |
| count-1 | count | hazard_crossing | runner.default | – | ano | ano | 4/4 | 2897 | 111 | 4 | 159.3 | 180.1 |
| relation-1 | relation | survival_timer | arena.escape | – | ano | ano | 4/4 | 2400 | 3 | 3 | 200.5 | 165.9 |
