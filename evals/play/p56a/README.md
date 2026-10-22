# P56A – věta je vidět

Plán `plans/P56A-veta-je-videt-2026-10-21.md` (necommitovaný). Větev `features/P56A-veta-je-videt-2026-10-21` z tipu P55 `72665fdc`.

## Výchozí stav (T1)

`baseline.md` a `baseline.json` (`P56A_OUT=baseline npx vitest run --config vitest.measure.mts evals/play/p56a/baseline.measure.ts`, latence `latency.mjs`): žánr, hrdina a protivník s modelem, sada vzhledu, název a cílový řádek bez čtečky na dev sadách a na `audit-12.json`.

## Sady (T2)

- **Ladí se výhradně na dev:** p55 `holdout.json` (otevřený v P55 T9, od té doby dev), p54c `dev.json` + `holdout.json`, p30 `dev.json`, p43 `panel.json` (sloty hero/role) a `audit-12.json` (12 vět auditu živého `/play` z 21. 10., ruční štítky).
- **`holdout.json`** – 80 vět, které 21. 10. napsal nezávislý subagent bez přístupu k repozitáři (kód, plány ani sady nečetl). Dostal jen 25 jednovětých popisů režimů 19 žánrů z pohledu hráče, seznam 18 světů, tvar záznamu a pokyn psát jako hráč 13+ (opisy, slang, bez jmen žánrů, hrdina a protivník konkrétní, asi čtvrtina vět bez hrdiny). 60 cílů (každý žánr ≥ 3, aréna, plavba, úkol a načasování po režimech) a 20 pastí s polem `lure` (žánr, kam věta láká) a `genre` (správný žánr, u 8 z nich `null`). Každý záznam nese `hero`, `foe`, `item` a `world`. Soubor zapsal sám a vrátil jen otisk a počty; v relaci ho nikdo nečetl. **SHA-256 nad LF bajty: `3dd3b9ebcabaa72b2f7ee275e188e80fab213de44da24d474dd78ca227e64999`**.
- `__tests__/sets.test.ts` hlídá otisk, počty, tvar a nulový průnik (po `normalizeSentence`, na výstup jen id) se všemi sadami, na kterých se ladilo nebo které kdo otevřel: p30 dev + test-200, p43 panel + sealed-100, p45 panel + sealed-100, p52 dev + holdout, p54c dev + holdout, p55 holdout, demand corpus a audit-12. Otevře ji jen `holdout.measure.ts` v T13, jednou: `openSealedOnce` (`seal.ts`, pečeť P55) zapíše `holdout-opened.json` před prvním čtením a druhé otevření odmítne.

## Věta ve hře v prohlížeči (T12)

`visible-dev.json` (`visible.mjs play|judge|report`): 12 vět auditu na `next start`, snímek jen plátna po 3 s hry robota, slepý soudce (Codex, prázdný `mkdtemp` jen se `sheet.png`) dostane jen slova hrdiny a protivníka – bez protivníka věc věty.

| | A `72665fdc` (bez čtečky) | B `7e34c2a8` (čtečka gpt-oss-20b) |
|---|---|---|
| Soudce vidí všechna slova věty | 2/12 | **5/12** (cíl 10/12 – nesplněno) |
| Slova jednotlivě | 5/18 | 10/18 |
| Čtení modelem | 0/12 | 12/12 |

- **Proč B nevidí zbytek:** u šesti ze sedmi chybějících slov spec nese správné jméno a knihovna má model na úrovni `identity`. Soudce postavu nepoznal: zombie a brankář jsou „příliš malí“ (a02, a07), ninja „zelená kápě dobrodruha“ (a03, `rogue-hooded`), kuchař „oranžový kvádr“ (a10), ovoce „béžové kvádry“ (a03), asteroid „kameny“ (a09). Žralok (a04) je ve specu hrdina, závodní režim (`voyage.race`) ho ale nakreslí jako závodní auto – stejně jako žábu na straně A. To je vzhled, velikost a kamera – rozsah P56B a knihovny modelů, ne čtení věty. Jediná chyba specu: a11 „drum to the beat“ – rytmická hra nemá bubny, jen dlaždice a údery.
- **e2e `play-sentence-visible.spec.ts`** 24/24 (desktop 1280×800, telefon 390×844): přečteno modelem, hrdina a protivník věty ve specu, hra běží, žádná `pageerror`. Bez čtečky padá na `readBy`.
- **Prostředí (T12):** ComfyUI držel 12 GB RTX 3090, gpt-oss-20b proto běžel s experty na CPU (`llama-server --cpu-moe`); první čtení věty 25–45 s, proto rozpočet 60 s. Režisér (AI verze) na serverech nebyl – soudí se jen rychlá verze, co AI verze přepíše, změřeno není.

## Zapečetěná sada otevřená (T13)

`holdout.json` otevřel 22. 10. `holdout.measure.ts` (`holdout-opened.json`); od té doby je to **dev sada**. Výsledek a výklad v `final.md` + `final.json`, čtení v `readings/holdout.gpt-oss-20b.json`, snímky a soud v `visible-holdout.json` (`visible.mjs report` bez `--a` = jen strana B). Cíle 31/60, pasti 13/20, robot/nečinný/replay 80/80, viditelnost 13/80, latence v mezích – žánr, pasti a viditelnost nesplněny.
