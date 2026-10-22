# P55 – výchozí čísla (T1, 21. 10. 2026)

**Co to znamená:** na větách, na kterých se klasifikátor ladil (p54c dev), trefí žánr vždy. Na větách nezávislého autora (p54c holdout, od P54C T16 otevřený, teď vývojová data) jen 37 z 60 a čtyři pruhové žánry jen 14 z 32. Pruhové hry mají dnes kolem jedné události za sekundu; obrana pruhů má až 8 s bez události.

Měřeno na `origin/main` `ada7dd8b` skriptem `baseline.measure.ts` (`P55_OUT=baseline`), řádek po řádku v `baseline.json`. Cesta jako v produkci bez modelu: klasifikátor a rychlý návrh na semínku 1.

## Žánr z věty

| Sada | Cílové věty hrají svůj žánr | Pasti / rušivé věty v novém žánru |
|---|---|---|
| p54c dev (80: 64 cílů, 16 pastí) | **64/64** | 0/16 |
| p54c holdout-opened (80: 60 cílů, 20 rušivých) | **37/60 = 0,62** | 0/20 |
| p30 dev (60, bez očekávaného žánru) | – (řádky v `baseline.json`; „beze ztráty“ = řádek se nepohne) | – |

p54c holdout-opened po žánrech:

| Žánr | Správně |
|---|---|
| catch | **2/8** |
| whack | 4/8 |
| defense | **3/8** |
| slice | 5/8 |
| hop | 6/7 |
| crowd | 4/7 |
| merge | 7/7 |
| push | 6/7 |
| **pruhové (catch, whack, defense, slice)** | **14/32 = 0,44** |

Shoduje se s `evals/play/p54c/final.md` – od T16 se klasifikátor nepohnul.

## Dění v pruhových hrách (buňka `<žánr>.default`, semínko 1, robot `intermediate`)

| Žánr | Robot vyhraje za | `eventsPerS` | `longestGapS` | `medianGapS` | Stoupá | Finále |
|---|---|---|---|---|---|---|
| catch | 35,0 s | 1,14 | 1,82 | 0,85 | ano (3,0×) | climax |
| whack | 34,7 s | 1,18 | 1,82 | 0,76 | ano (2,5×) | climax |
| slice | 42,2 s | 2,06 | 2,68 | 0,22 | ano (2,2×) | climax |
| defense | 47,8 s | 2,76 | **8,28** | 0,10 | ano (3,85×) | boss |

Prahy P55 (T5, T7): `eventsPerS` ≥ 1,5× tohoto čísla (catch ≥ 1,71, whack ≥ 1,77, slice ≥ 3,09, defense ≥ 4,14), `longestGapS` ≤ 3 s, výhra 30–90 s.
