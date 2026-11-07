# P76 T3 – telefon: věta → hratelná hra

**Výsledek:** párový medián B − A **+139 ms** (mez +200), **0 selhání** z 48 běhů. Brána telefonu drží (P75 T7b: +215 ms).

- Měřeno 7. 11. `node scripts/measure/first-playable-ab.mjs evals/play/p76/first-playable-t3.config.json`, profil `pixel7-cpu4`, 8 vět × 3 běhy, A a B prokládaně.
- A = `main` bez P75 (`e8998770`, worktree `D:/caches/p75/main`, port 3208), B = tato větev po T3 (port 3207).
- Souhrnné `gate.pass: false` v `perf-first-playable-t3.json` jsou jen chybějící desktopové řádky – konfigurace měří jen telefon.
- Surová data: `D:/tmp/p76-t3-raw`, souhrn `perf-first-playable-t3.json`.

| věta | A medián (ms) | B medián (ms) | párově B − A |
|---|---|---|---|
| s1 kočka s pizzou na střechách | 6730 | 6824 | +94 |
| s2 koruna ve starém hradu | 7453 | 7402 | −91 |
| s3 podmořský závod | 7509 | 7674 | +175 |
| s4 věž z palačinek ve větru | 5621 | 5938 | +317 |
| s5 minigolf v cukrové zemi | 5281 | 5435 | +142 |
| s6 farmář chytá jablka | 5436 | 5441 | −11 |
| s7 útěk před lávou | 8312 | 8400 | +273 |
| s8 rytíř na létajících ostrovech | 7385 | 7600 | +203 |
| **celkem (24 párů)** | **7050** | **7140** | **+139** |

## Co P75 přidal a co T3 odložil

Profil prvních 4 s hry po prvním snímku (`scripts/play/p76-ff-profile.mjs --path game --after 4000`, s3, s8, s5 × 3, CDP `Profiler` + počítadla WebGL):

| | před T3 (`ff-profile-game.json`) | po T3 (`ff-profile-t3.json`) |
|---|---|---|
| nahrávání textur A / B (ms) | 17 / 56 | 22 / 23 |
| JS navíc v B (ms) | +119 | +89 |
| první snímek A / B (ms) | 5027 / 5126 | 4963 / 4976 |

- Nejdražší položka P75 po prvním snímku byla malovaná obloha: jedno nahrání obrazu 1024×512 webp do GPU = 35 ms hlavního vlákna, protože se obraz dekódoval až při nahrání.
- T3: obraz se stahuje až po načtení modelů scény (`loadsIdle` v `look/pending-loads.ts`, nejdéle 5 s) a dekóduje se mimo hlavní vlákno (`ImageBitmapLoader`, `createImageBitmap` s `imageOrientation: 'flipY'`).
- Okem (`evals/play/p76/t3/s8-*`): hrad na telefonu i desktopu má malovanou oblohu stejnou jako před T3, obraz není převrácený.

## Odhad – co zbývá (inference, neměřeno zvlášť)

- Zbylých ~+90 ms JS v prvních 4 s je pravděpodobně záběr zblízka na startovní kartě (`RestShot`: kamera a póza každý snímek, hledání hrdiny průchodem scény každých 20 snímků). Neověřeno ablací.
- Rozptyl po větách je velký (−91 až +317 ms při rozlišení pokusu ~0,6 s); s4 a s7 nad mezí jsou v tomto šumu.
