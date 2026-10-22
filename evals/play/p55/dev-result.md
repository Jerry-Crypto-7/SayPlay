# P55 – žánr z věty na vývojových větách (T3 + T4)

**Co to znamená:** na 60 cílových větách nezávislého autora (otevřený holdout P54C) hraje svůj žánr 59, dřív 37. Čtyři pruhové žánry 32/32, dřív 14/32. Na starých sadách se nepohnula žádná věta. Zálohu přes tabulku sloves nebylo potřeba stavět. Jestli to není přeučení na těchto větách, ukáže až zapečetěná sada P55 v T9.

Měřeno `P55_OUT=dev-result npx vitest run --config vitest.measure.mts evals/play/p55/baseline.measure.ts` (klasifikátor + rychlý návrh na semínku 1), řádky v `dev-result.json`, výchozí stav v `baseline.md`.

## Výsledek

| Sada | Výchozí (T1) | Teď | Brána T4 |
|---|---|---|---|
| p54c holdout-opened, cíle | 37/60 | **59/60 = 0,98** | ≥ 52/60 ✅ |
| – pruhové (catch, whack, defense, slice) | 14/32 | **32/32** | každý ≥ 6/8 ✅ |
| – fáze 3 (hop, crowd, merge, push) | 23/28 | **27/28** | každý ≥ 6/7 ✅ |
| p54c holdout-opened, rušivé věty v novém žánru | 0/20 | 0/20 | 0 ✅ |
| p54c dev (80) – změněné řádky návrhu | – | 0 | 0 ✅ |
| p30 dev (60) – změněné řádky návrhu | – | 0 | 0 ✅ |
| golden + demand (240 vět) – změněný žánr | – | 1 („bumper cars arena“: jízda → vytlačování, správně) | – |

Po žánrech: catch 8/8, whack 8/8, defense 8/8, slice 8/8, hop 7/7, crowd 7/7, merge 7/7, push 6/7.

## Co se přidalo (rodiny opisů, vždy věc + pohyb)

- **catch:** sebrat, chytit nebo sníst to, co padá („collect falling stars in a basket“); věc padá a hráč ji chytá nebo pod ni strká nádobu („candy falls from the ceiling and i slide my bowl under it“); nádoba posouvaná pod věci („move a bucket left and right to catch raindrops“).
- **whack:** něco vykoukne a hráč do toho udeří zájmenem („ghosts appear in windows, tap them“).
- **defense:** zastavit mnohé, než dojdou k místu; vlna (množné číslo před slovesem) se valí k pevnosti („orcs march down three lanes toward my castle“); chránit místo házením nebo stavěním.
- **slice:** věc vyhozená nebo vyskočivší, pak řez zájmenem („pumpkins get thrown up and you slice them“); tah prstem přes to, co letí; ryby, které vyskakují.
- **crowd:** brány, které dav násobí („x2 gates“, „doubling hoops“, „gates that add more“).
- **hop:** „lanes of cars“ je provoz.
- **„bumper cars“ nejsou závodní auta** – jméno jízdy je přestalo slyšet.

## Zbylá chyba

- **h19 push → jízda** („Bumper cars on a floating platform, knock the others off but stay on yourself“): klasifikátor slyší skok kvůli slovu „platform“, návrh pak skládá jízdu. Shodit „the others off“ bez jména ringu za „off“ by slovo „off“ četlo i v plošinovce („knock enemies off“) – oprava jen pro tuhle větu se nedělá.

## Záloha přes tabulku sloves

Nestavěla se – regexy daly 59/60, nad bránou 52/60. Otázku „je tabulka sloves P44C na cestě rychlé verze“ tak T4 neotevřela.
