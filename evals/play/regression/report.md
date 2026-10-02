# PLAY – regresní harness nad 40 zlatými větami

Naměřeno 2026-10-02T16:36:58.717Z, semínko 1, bez modelu (návrh ze slov). Generuje `golden.test.ts`.

Spec platný 40/40 · zkompilováno 40/40 · publikovatelné 40/40 · žánr trefen 26/32 · kompilace medián 96.4 ms, p90 201.1 ms

| id | kbelík | archetyp | žánr | trefa | kompilace | publikovatelné | keypointy | výhra (tik) | entity | pravidla | kompilace ms | kontrola ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| chase_escape-1 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 4 | 5 | 177.1 | 151.4 |
| chase_escape-2 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 4 | 5 | 127.9 | 115.1 |
| chase_escape-3 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 4 | 5 | 102.1 | 115.2 |
| chase_escape-4 | chase_escape | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2400 | 4 | 5 | 81 | 101.2 |
| collect_exit-1 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 3240 | 8 | 6 | 94.3 | 111.6 |
| collect_exit-2 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 2144 | 11 | 6 | 54.6 | 97.6 |
| collect_exit-3 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 2157 | 6 | 6 | 53.1 | 62.4 |
| collect_exit-4 | collect_exit | collect_exit | arena.collect | ano | ano | ano | 4/4 | 3381 | 9 | 6 | 66 | 130.1 |
| survival_timer-1 | survival_timer | survival_timer | arena.escape | ano | ano | ano | 4/4 | 3600 | 4 | 5 | 116.5 | 145.9 |
| survival_timer-2 | survival_timer | collect_exit | arena.collect | **ne** | ano | ano | 4/4 | 3787 | 13 | 6 | 92 | 145.5 |
| survival_timer-3 | survival_timer | survival_timer | arena.escape | ano | ano | ano | 4/4 | 2700 | 4 | 5 | 75.2 | 106.7 |
| survival_timer-4 | survival_timer | survival_timer | arena.escape | ano | ano | ano | 4/4 | 4800 | 4 | 5 | 162 | 212.8 |
| checkpoint_race-1 | checkpoint_race | hazard_crossing | voyage.race | ano | ano | ano | 4/4 | 2446 | 106 | 6 | 128.2 | 100.3 |
| checkpoint_race-2 | checkpoint_race | hazard_crossing | voyage.race | ano | ano | ano | 4/4 | 2446 | 106 | 6 | 95.3 | 91.7 |
| checkpoint_race-3 | checkpoint_race | switch_puzzle | quest.spatial | **ne** | ano | ano | 5/5 | 4201 | 13 | 6 | 270.6 | 259.3 |
| checkpoint_race-4 | checkpoint_race | hazard_crossing | runner.default | **ne** | ano | ano | 4/4 | 2897 | 112 | 5 | 83.1 | 79.2 |
| delivery-1 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 5181 | 13 | 6 | 250.8 | 330.8 |
| delivery-2 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 4192 | 12 | 6 | 201.1 | 225.7 |
| delivery-3 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 4192 | 12 | 6 | 143.3 | 283.9 |
| delivery-4 | delivery | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 4192 | 12 | 6 | 190 | 202.5 |
| switch_puzzle-1 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 4192 | 12 | 6 | 192.9 | 217.3 |
| switch_puzzle-2 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 4938 | 10 | 6 | 279.9 | 415.5 |
| switch_puzzle-3 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 4192 | 12 | 6 | 145.4 | 205.7 |
| switch_puzzle-4 | switch_puzzle | switch_puzzle | quest.spatial | ano | ano | ano | 5/5 | 4192 | 12 | 6 | 141.6 | 210.5 |
| hazard_crossing-1 | hazard_platforming | hazard_crossing | platformer.default | ano | ano | ano | 4/4 | 2430 | 72 | 8 | 89.5 | 64.9 |
| hazard_crossing-2 | hazard_crossing | hazard_crossing | platformer.default | ano | ano | ano | 4/4 | 2430 | 72 | 8 | 49.4 | 47.4 |
| hazard_crossing-3 | hazard_crossing | hazard_crossing | runner.default | **ne** | ano | ano | 4/4 | 2897 | 112 | 5 | 43.6 | 90.6 |
| hazard_crossing-4 | hazard_crossing | hazard_crossing | platformer.default | ano | ano | ano | 4/4 | 2430 | 72 | 8 | 38.2 | 57.3 |
| combat_lite-1 | combat_lite | combat_lite | arena.fight | ano | ano | ano | 4/4 | 3565 | 5 | 5 | 60.5 | 71.3 |
| combat_lite-2 | combat_lite | combat_lite | arena.fight | ano | ano | ano | 4/4 | 3565 | 5 | 5 | 28.6 | 61 |
| combat_lite-3 | combat_lite | switch_puzzle | quest.spatial | **ne** | ano | ano | 5/5 | 4201 | 13 | 6 | 216.7 | 218.4 |
| combat_lite-4 | combat_lite | switch_puzzle | quest.spatial | **ne** | ano | ano | 5/5 | 4192 | 12 | 6 | 183.4 | 254.8 |
| ambiguity-1 | ambiguity | collect_exit | arena.collect | – | ano | ano | 4/4 | 3787 | 13 | 6 | 90.7 | 135.6 |
| contradiction-1 | contradiction | collect_exit | arena.collect | – | ano | ano | 4/4 | 3787 | 13 | 6 | 92.9 | 167.2 |
| scale-1 | scale | survival_timer | arena.escape | – | ano | ano | 4/4 | 4800 | 4 | 5 | 169.9 | 311.2 |
| remix-1 | remix | collect_exit | arena.collect | – | ano | ano | 4/4 | 3787 | 13 | 6 | 143 | 170.7 |
| remix-2 | remix | collect_exit | arena.collect | – | ano | ano | 4/4 | 3787 | 13 | 6 | 100.7 | 133.6 |
| remix-3 | remix | collect_exit | arena.collect | – | ano | ano | 4/4 | 3787 | 13 | 6 | 96.4 | 168.4 |
| count-1 | count | collect_exit | arena.collect | – | ano | ano | 4/4 | 3787 | 13 | 6 | 80 | 143.4 |
| relation-1 | relation | survival_timer | arena.escape | – | ano | ano | 4/4 | 2400 | 4 | 5 | 82.4 | 104 |
