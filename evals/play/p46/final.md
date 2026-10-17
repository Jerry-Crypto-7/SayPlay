# P46 – konečné měření na zapečetěné sadě (15. 10. 2026)

Zapečetěná sada P45 (100 vět) otevřená jednou (`evals/play/p45/sealed-opened.json`). A = `features/P45-demo-2026-10-12` (`491079b7`), B = integrační větev P46 (`5867439d`). Měří se rychlá verze (hra ze slov); nic se neladilo.

| Cíl | Splnit | Hodnota | Splněno |
|---|---|---|---|
| Slepý párový soud, podíl B | ≥ 0,70 | **0,805** (B 69, A 8, remíz 23) | ano |
| Mrtvý čas, medián celkem | ≤ 3 s | 4,6 s | ne |
| Mrtvý čas, běžec (8 vět) | ≤ 4 s | 5,44 s | ne |
| Mrtvý čas, řízení (10 vět) | ≤ 4 s | 3,22 s | ano |
| Mrtvý čas, skákačka | ≤ 4 s | – | žádná věta sady na skákačku nepadne |
| Stoupání | ≥ 0,7 | 0,65 | ne |
| Finále nebo boss | ≥ 0,8 | 0,38 | ne |
| Chování nepřátel, medián | ≥ 2 | 1 | ne |
| Akce z věty je ve hře (18 vět se slovesem) | ≥ 0,85 | 0,72 | ne |
| Robot akci použil / sloveso proběhlo | ≥ 0,85 | 0,67 / 0,67 | ne |
| Brány beze ztrát (hash, celá sada, e2e) | zelené | zelené v T7 | ano |

## Co splněné není a proč

- **Finále (0,38):** žánry, kterých se P46 týkala, ho mají všude – aréna boj 9/9, běžec 8/8, řízení 10/10, střílečka 2/2, rytmus 3/3. Chybí v aréně se sbíráním (5/33, třetina sady), questech (0/13), duelu (0/6) a hodu (0/4). Tyto žánry finále ani bosse zatím nedostávají.
- **Mrtvý čas a chování:** táhne je dolů tatáž aréna se sbíráním a questy. Volný pohyb a quest.spatial mají nejdelší mezery (8–12 s).
- **Akce (0,72 / 0,67):** chybí u 5 z 18 vět – dvakrát `shield`, dvakrát `dash`, jednou `shoot`. U x037 je strike ve hře, ale robot ho nepoužil. Na panelu P46A bylo 0,88 / 0,92; zapečetěná sada má víc sloves, která rychlá verze neumí.
- Párový soud cíl splnil s rezervou: B prohrála 8 ze 100.

Zdrojová data: `evals/play/p45/result-p46-final.json` (soud + měřidlo zábavy), `evals/play/p46/final-actions.json` (akce, `final-actions.measure.ts`).
