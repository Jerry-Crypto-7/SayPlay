# P45 – měřidlo zábavy

Měření hloubky a zábavy her: telemetrie robota, slepý párový soud a formulář majitele. Plán: P45A (interní), spec `docs/specs/2026-10-08-p45-hloubka-a-zabava.md` (interní).

## `panel.json` – vývojový panel, 40 vět

Vybraný jednou 8. 10. 2026 nad `main` `0714a352` dřív, než se P45 dotkl kódu (`panel.select.ts`, holý Node se zavaděčem `scripts/ts-paths.mjs`). 25 vět z `p37a/dev-150.json`, 15 z `p30/dev.json`; ladí se jen na něm.

- **Žánr** = žánr rychlého návrhu (semínko 1, bez modelu) jako `p36/depth.ts`; věty, které spadnou do mřížky, vypadly – nemají arkádový běh, který by robot změřil.
- **Pořadí výběru:** skupiny sady se střídají (`group` v `dev-150`, `source` v `p30/dev`), uvnitř skupiny podle id; věta se vezme, dokud její žánr nemá svůj podíl (strop kvóta / počet žánrů), zbytek kvóty doplní další věty v tomtéž pořadí. Čisté pořadí podle id by z `dev-150` vzalo jen `f*` a `m*` a panel by neměl jedinou větu s neznámým slovesem.
- **Nepřítel** = tělo role `chaser` nebo `enemy` ve světě na semínku 1 (živé i předloha vln).
- Pokrytí: 18 žánrů, 18 vět s nepřítelem. `genre` a `enemy` jsou zapsané u každé věty v době výběru – pozdější změna hry je nepřepisuje.
- Žádná věta se po normalizaci neshoduje s `p30/test-200.json` ani se zapečetěnými sadami P43, P44C a P44E. Výběr drží `__tests__/panel.test.ts` (změna = červený).

Ids: `f01` `f02` `f03` `f05` `f10` `f12` `f17` `f18` `m01` `m02` `m03` `m04` `m06` `m07` `m08` `m09` `m11` `m16` `n01` `n02` `n04` `u01` `u02` `u03` `u06` (dev-150) · `d01` `d03` `d04` `d09` `h02` `h03` `h05` `j01` `j04` `j05` `j08` `s002` `s003` `s021` `s035` (p30 dev).
