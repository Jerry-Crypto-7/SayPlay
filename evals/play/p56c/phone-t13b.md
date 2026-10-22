# P56C T13b – přechod kola na telefonu s opravou `dpr` a bez ní (22. 10. 2026)

**Co to znamená:** oprava `dpr` (`acfeef9e`, plátno po překreslení drží úroveň kvality) přechod mezi koly nezhoršila – mediány vyšly s opravou o 8–12 ms níž, což je pod jeden snímek a v šumu. Nečinný řetěz s opravou má medián přechodu 91,8 ms (brána 100 ms). Nejhorší přechod v jednotlivém běhu přes 100 ms vyšel u obou verzí (117–133 ms), protože se měřilo během generování P57A na téže grafické kartě (průměr 27–47 %, špičky 100 %); v klidném okně T13a dalo bez opravy 100 / 99,9 ms.

## Jak se měřilo

- Dva `next start` vedle sebe nad týmž commitem `6708533d`: A bez opravy (`StageHost.tsx` z `acfeef9e^`, :3112), B s opravou (:3111).
- `node evals/play/p56c/phone.mjs --runs 1` prokládaně A, B, A, B … 4 cykly (Pixel 7 emulovaný, CPU 4×); zátěž GPU zapsaná každé 2 s.
- Metrika: `chainIdle` – řetěz bez robota, kola běží sama a prohrávají; 2 přechody na běh.

## Výsledek

| běh | verze | nečinný nejhorší (ms) | nečinný medián (ms) | FPS kol | GPU průměr / max (%) |
|---|---|---|---|---|---|
| 0 | A | 133,3 | 125 | 59 | 35 / 98 |
| 1 | B | 100,1 | 91,8 | 57 | 47 / 100 |
| 2 | A | 116,6 | 91,7 | 54 | 45 / 100 |
| 3 | B | 133,2 | 91,6 | 60 | 46 / 100 |
| 4 | A | 116,6 | 100 | 59 | 47 / 100 |
| 5 | B | 100,1 | 91,8 | 57 | 43 / 100 |
| 6 | A | 116,7 | 108,4 | 60 | 41 / 100 |
| 7 | B | 116,6 | 108,3 | 58 | 27 / 100 |

- **A (bez opravy):** medián nejhoršího přechodu běhu 116,7 ms, medián přechodu 104,2 ms, nejhorší 133,3 ms.
- **B (s opravou):** medián nejhoršího přechodu běhu 108,4 ms, medián přechodu 91,8 ms, nejhorší 133,2 ms.
- Snímek je 16,7 ms; rozdíly mezi verzemi jsou 0–2 snímky na běh.

Co to neříká: absolutní „nejhorší ≤ 100 ms v každém běhu“ se pod souběžnou zátěží GPU ukázat nedá u žádné verze; měřítko je proto srovnání A/B na mediánu.
