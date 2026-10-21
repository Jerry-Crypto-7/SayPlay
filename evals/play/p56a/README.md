# P56A – věta je vidět

Plán `plans/P56A-veta-je-videt-2026-10-21.md` (necommitovaný). Větev `features/P56A-veta-je-videt-2026-10-21` z tipu P55 `72665fdc`.

## Výchozí stav (T1)

`baseline.md` a `baseline.json` (`P56A_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p56a/baseline.measure.ts`, latence `latency.mjs`): žánr, hrdina a protivník s modelem, sada vzhledu, název a cílový řádek bez čtečky na dev sadách a na `audit-12.json`.

## Sady (T2)

- **Ladí se výhradně na dev:** p55 `holdout.json` (otevřený v P55 T9, od té doby dev), p54c `dev.json` + `holdout.json`, p30 `dev.json`, p43 `panel.json` (sloty hero/role) a `audit-12.json` (12 vět auditu živého `/play` z 21. 10., ruční štítky).
- **`holdout.json`** – 80 vět, které 21. 10. napsal nezávislý subagent bez přístupu k repozitáři (kód, plány ani sady nečetl). Dostal jen 25 jednovětých popisů režimů 19 žánrů z pohledu hráče, seznam 18 světů, tvar záznamu a pokyn psát jako hráč 13+ (opisy, slang, bez jmen žánrů, hrdina a protivník konkrétní, asi čtvrtina vět bez hrdiny). 60 cílů (každý žánr ≥ 3, aréna, plavba, úkol a načasování po režimech) a 20 pastí s polem `lure` (žánr, kam věta láká) a `genre` (správný žánr, u 8 z nich `null`). Každý záznam nese `hero`, `foe`, `item` a `world`. Soubor zapsal sám a vrátil jen otisk a počty; v relaci ho nikdo nečetl. **SHA-256 nad LF bajty: `3dd3b9ebcabaa72b2f7ee275e188e80fab213de44da24d474dd78ca227e64999`**.
- `__tests__/sets.test.ts` hlídá otisk, počty, tvar a nulový průnik (po `normalizeSentence`, na výstup jen id) se všemi sadami, na kterých se ladilo nebo které kdo otevřel: p30 dev + test-200, p43 panel + sealed-100, p45 panel + sealed-100, p52 dev + holdout, p54c dev + holdout, p55 holdout, demand corpus a audit-12. Otevře ji jen `holdout.measure.ts` v T13, jednou: `openSealedOnce` (`seal.ts`, pečeť P55) zapíše `holdout-opened.json` před prvním čtením a druhé otevření odmítne.
