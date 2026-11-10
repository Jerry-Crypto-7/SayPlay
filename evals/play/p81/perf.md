# P81 – výkon telefonu (T6)

Profil Pixel 7 (UA a DPR, 390×844, CPU 4×, ANGLE d3d11, OpenXR vypnutý). A = `main` před P81 (`bab71daf`, port 3213), B = větev P81 (port 3212). Měřeno prokládaně A, B, A, B.

## Výsledek

| Kontrola | Mez | Výsledek |
|---|---|---|
| FPS v každé z 8 her (medián 3 běhů) | ≥ 40 | **drží** – nejnižší s1 41,5 |
| Věta → hratelná hra, párový medián B − A | ≤ +200 ms | **drží** – +26 ms (24 párů) |

## FPS (`perf-fps.json`, `p73d-perf.mjs`, build T5 `a459fc6c`, 9. 11. 19:30)

| Hra | main | P81 |
|---|---|---|
| s1 | 44,5 | 41,5 |
| s2 | 48,9 | 43,4 |
| s3 | 55,8 | 53,8 |
| s4 | 58,8 | 58,6 |
| s5 | 43,3 | 42,6 |
| s7 | 56,5 | 56,3 |
| s8 | 48,0 | 46,1 |
| s10 | 58,6 | 58,0 |

Měřeno před `82216a78`, který obrysům kulis jen ubral práci (na telefonní úrovni `medium` nejsou vůbec), takže čísla P81 platí jako spodní mez. Příznak `pass: false` v JSON patří p95 snímku 33,4 ms proti mezi 33,3 ms – stejně vychází i `main` (zaokrouhlení jednoho snímku při 30 Hz), FPS mez drží.

## Věta → hra (`perf-first-playable.json`, `first-playable-ab.mjs`, build `82216a78`, 9. 11. 21:25)

8 vět × 3 běhy na stranu, 0 selhání. Medián A 7 517 ms, B 7 420 ms; párový rozdíl mediánem **+26 ms**.

| Věta | A | B | párově |
|---|---|---|---|
| s1 kočka s pizzou | 6 842 | 6 936 | +94 |
| s2 koruna v hradu | 7 753 | 8 008 | +255 |
| s3 závod pod vodou | 8 070 | 7 987 | −18 |
| s4 věž z palačinek | 6 006 | 5 877 | −238 |
| s5 minigolf | 5 620 | 5 688 | +60 |
| s6 jablka | 5 956 | 5 633 | −323 |
| s7 sopka | 8 465 | 8 511 | −8 |
| s8 rytíř | 7 709 | 7 616 | +137 |

**Co pomohlo:** build T5 měl párově +487 ms. `82216a78` zapíná obrysy kulis jen na úrovni `high` a až ~2 s po startu (40 sítí na průchod); telefon startuje na `medium`, takže první snímek nestaví obaly ani jejich programy. Po změně rozdíl spadl na +26 ms, což je v šumu (jednotlivé věty −323 až +255 ms).
