# P56C T18 – přechod do kola Run! na emulovaném telefonu

Věta „a hedgehog paramedic rolls through traffic, rescues hurt pigeons and races to the vet“, emulovaný Pixel 7, CPU 4×.
Prokládaně A (`9d233891`, bez oprav T18) / B (oprava chyby stránky `9d2b7bb8` + terén běžce ve workeru), 4 cykly A,B,A,B,
v každém běh prsty (`human`) a robotem (`bot`), GPU každé 2 s (průměr běhů 9–74 %, generování P57 neodstaveno – pravidlo
majitele „neměřit v klidu“). Hodnota = nejhorší snímek přechodu (ms).

| Běh | A Run! | B Run! | A chyba stránky | B chyba stránky |
|---|---|---|---|---|
| prsty (4×) | 483 / 500 / 483 / 483 | 133 / 117 / 133 / 133 | 1 / 4 | 0 / 4 |
| robot (4×, všech 5 kol, výhra) | 567 / 617 / 483 / 650 | 150 / 167 / 167 / 167 | 4 / 4 | 0 / 4 |
| **medián** | prsty 483, robot 592 | **prsty 133, robot 167** | | |

Brána T18 (Run! ≤ 200 ms, 0 chyb stránky): **splněna** – nejhorší přechod B ve všech 8 bězích 167 ms, ostatní přechody B 67–167 ms.
Běh prsty končí prohrou po 2–3 kolech (nikdo neťuká), robot projde všech 5 kol.

Příčina zaseknutí: kolo běžce stavělo údolí a pás cesty pro celou 446m trať mikro běžce (65 892 vrcholů) v jednom snímku
(profil CDP: 547 ms z 583ms snímku). Teď ho staví worker hned po montáži řetězu (`runner/terrain.ts`, `terrain-worker.ts`)
a scéna kola vezme hotová pole; jedna hra staví na místě jako dřív.
