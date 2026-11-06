# P73D T8 – výkon a první snímek na telefonu

Měřeno 6. 11. 2026. **A** = `main` `3a0cfb75` (odbočení větve, export `git archive`, vlastní build, port 3205), **B** = větev `119cbc58` po T7 (port 3204). Oba produkční build (`next start`), lokálně, bez modelu (okamžitá verze hry).

## FPS telefonu

Skript `scripts/play/p73d-perf.mjs`, data `perf-fps.json`. Telefon jako P70D: Pixel 7 (UA, hustota pixelů, dotyk), okno 390×844, CPU 4×, ANGLE d3d11, OpenXR vypnuté. Hra se stejnou větou a semínkem na obou stranách (`p73d-shots.mjs`), dotažená, pak 10 s ukázky robota v reálném čase a intervaly `requestAnimationFrame`. 4 opakování prokládaně A B, B A, A B, B A, hra po hře (paměť perf-measure-interleaved-no-calm); v tabulce mediány.

| Hra | Věta | FPS A | FPS B | p95 A (ms) | p95 B (ms) | volání A → B |
|---|---|---|---|---|---|---|
| honička město (s3) | A cat delivering pizzas across rooftops while avoiding seagulls | 57,5 | 57,4 | 16,8 | 16,8 | 85 → 90 |
| quest hrad (s8) | Find the lost crown in an old castle | 47,7 | 48,8 | 33,4 | 33,4 | 78 → 89 |
| závod pod vodou (s2) | An underwater race between a turtle and a shark | 45,3 | 45,9 | 33,4 | 33,4 | 107 → 107 |
| stohování (s4) | Balance a tower of pancakes on a windy day | 59,5 | 59,4 | 16,8 | 16,8 | 69 → 68 |
| golf (s7) | Play mini golf in a candy land | 57,6 | 56,6 | 16,8 | 16,8 | 58 → 71 |
| chytání (s10) | A farmer catches falling apples in the orchard | 59,6 | 59,5 | 16,8 | 16,8 | 46 → 49 |
| běh sopka (s1) | Escape a volcano before the lava reaches you | 46,2 | 45,3 | 33,4 | 33,4 | 124 → 124 |
| plošinovka (s5) | A knight jumps across floating islands to rescue a dragon egg | 50,6 | 50,5 | 33,4 | 33,4 | 84 → 84 |

**Medián ≥ 40 FPS: drží všech 8.** B se od A liší nejvýš o 1,1 FPS oběma směry (golf −1,0, quest +1,1), tedy v rozptylu měření.

**p95 ≤ 33,3 ms: doslovně ne u 4 z 8 her – a stejně na `main`.** Fakta:
- p95 intervalu snímku vychází jen 16,8 nebo 33,4 ms: prohlížeč kreslí v taktu 60 Hz, takže interval je vždy jeden nebo dva takty. 33,4 ms jsou přesně dva takty (2 × 16,68 ms), tedy hranice 30 FPS, kterou mez 33,3 ms (= 1000/30) míní.
- Ve všech čtyřech hrách (quest, závod, běh, plošinovka) má A stejné p95 jako B. Běh a plošinovka mají stejný počet volání kreslení na obou stranách.
- Stávající brány repa (`e2e/play-buildshift.spec.ts`, `play-drawsave.spec.ts`) p95 ≤ 33,3 ms hlídají na desktopu, telefony jen zapisují.

Inference: P73D p95 na telefonu nezhoršil; čtyři hry s p95 na dvou taktech tak byly už na `main`. Úleva z plánu („nejdřív vypnout DoF a stíny navíc na `mid`“) by na tom nic nezměnila: hloubka ostrosti běží jen na `high` a telefon kreslí na `medium` (hry s p95 na dvou taktech jedou `medium`). Režie se proto neubírala.

Kvalita na konci okna (`data-quality`, 4 běhy na stranu): honička, quest, závod, běh a plošinovka `medium`, stohování a chytání `high` na obou stranách. Golf A 3× `medium` a 1× `high`, B 3× `high` a 1× `medium` – B tedy kreslil golf častěji na vyšší kvalitě a stejně držel 56,6 FPS. Na `low` spadl jeden běh na straně: quest B, závod B, běh A.

## Věta → hra

Skript `scripts/measure/first-playable-ab.mjs` (P50/P68I), nastavení `first-playable.config.json`, data `perf-first-playable.json`. Stejných 8 vět napsaných na `/play` a odeslaných, profily desktop 1280×720 a telefon Pixel 7 s CPU 4×, 3 běhy na větu a stranu, dvojice A+B hned po sobě se střídáním pořadí. **Hratelné** = po klepnutí roste `data-inputs` i `data-tick` (rozlišení jeden pokus vstupu, hrubší než první snímek); **první snímek** = konec prvního snímku WebGL plátna (bez zrnitosti pokusů). 96/96 běhů hratelných.

| Profil | Metrika | A medián | B medián | párový rozdíl B − A | Mez | Výsledek |
|---|---|---|---|---|---|---|
| desktop | věta → hratelná | 2,22 s | **2,40 s** | +0,14 s | ≤ 3,0 s a ≤ +0,2 s | drží |
| desktop | první snímek | 1,45 s | 1,57 s | +0,11 s | – | – |
| telefon CPU 4× | věta → hratelná | 7,22 s | 7,54 s | **+0,34 s** | ≤ +0,2 s | **nedrží** |
| telefon CPU 4× | první snímek | 4,35 s | 4,68 s | +0,17 s | – | – |

Brána nástroje (`gate`): selhání 0, medián B na desktopu 2 396 ms ≤ 3 000, párový rozdíl desktop 142,5 ms ≤ 200, **telefon 336,5 ms > 200 → `pass: false`**.

Telefon po hrách (medián 3 běhů, hratelná / první snímek, ms):

| Hra | A | B | rozdíl |
|---|---|---|---|
| honička město | 6 796 / 4 134 | 7 153 / 4 356 | +357 / +222 |
| quest hrad | 7 769 / 4 967 | 7 834 / 5 080 | +65 / +113 |
| závod pod vodou | 7 580 / 4 517 | 8 042 / 4 931 | +462 / +414 |
| stohování | 5 695 / 4 085 | 6 045 / 4 294 | +350 / +209 |
| golf | 4 897 / 3 500 | 5 367 / 3 630 | +470 / +130 |
| chytání | 5 281 / 3 932 | 5 536 / 4 042 | +255 / +110 |
| běh sopka | 7 610 / 4 801 | 7 816 / 5 036 | +206 / +235 |
| plošinovka | 7 618 / 5 086 | 7 882 / 5 256 | +264 / +170 |

Fakta:
- Mez 3,0 s je u nástroje jen pro desktop; na telefonu s CPU 4× ji nedrží ani `main` (7,2 s).
- B je na telefonu pomalejší ve všech 8 hrách, i v plošinovce, kde P73D mění jen světlo a obzor.
- Úleva z plánu se na telefon nevztahuje: hloubka ostrosti běží jen na `high`, P73D přidal stíny jen jako příjem (`receiveShadow`, žádné kreslení navíc do mapy stínů) a jeden vrhající pás mantinelu závodu.

Inference: cenu nese společná režie, ne jedna scéna – nejvíc závod (+0,41 s do prvního snímku: písek s drobky, dvoubarevné mantinely), honička a sopka (podstavec, kaňon). Kde přesně, ukáže až profil procesoru prvního načtení na telefonu (paměť `perf-drop-without-calls-is-cpu`). Zapsáno do plánu jako směrovaný úkol T8b před T10.
