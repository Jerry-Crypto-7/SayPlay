# P58E T4 – řetěz dostane čtení: hra od příchodu čtení na zapečetěné sadě P58B

**Brána nesplněna.** Hra, kterou hráč hraje od příchodu čtení, má žánr věty u **46/60** cílů (brána 48) a pasti obchází u **20/20** (brána 18). P58D bez čtení řetězu: 32/60 a 20/20. Všech 14 chybějících cílů je řetěz, kterému čtení řetěz potvrdilo – hráč dál hraje řetěz mikroher. Hra ze čtení by u všech 14 měla žánr věty; nevznikne, protože pravidlo `chainOrSingle` se čtením řekne znovu řetěz (možnost (b) majitele přepíná jen tam, kde se čtením řetěz nevznikne).

## Výsledek (`result.json`)

| | P58E | P58D | rychlá hra | brána |
|---|---|---|---|---|
| cíle se žánrem věty | 46/60 | 32/60 | 25/60 | ≥ 48 |
| pasti mimo lákavý žánr | 20/20 | 20/20 | 15/20 | ≥ 18 |
| věty v řetězu bez čtení (= placené čtení navíc) | 39/80 | 40/80 | – | – |
| řetěz → hra ze čtení | 19 (14 cílů, 5 pastí) | 0 | – | – |
| řetěz zůstane řetězem | 20 (14 cílů, 6 pastí) | 40 | – | – |
| robot vyhraje / nečinný prohraje / replay | 60/60 her (19 ze řetězu) | 40/40 | – | každá |

- Všech 19 her ze čtení řetězu prošlo publikací jako dítě řetězu; 14 cílů má žánr věty, žádná z 5 pastí nehraje lákavý žánr.
- Čtení dorazí u řetězů, které přejdou, za p50 2,6 s, max 4,5 s (uložené časy P58B).
- s68 počítal P58D jako řetěz. Jeho řetěz ale neprojde vlastní kontrolou (hraje 28,1 s, povoleno 30–90 s), route ho zahodí a hraje jednu hru – měřidlo teď publikuje řetěz jako route, proto 39 řetězů místo 40.
- **Kdyby řetěz přešel na hru ze čtení vždy** (možnost (a) z P58D): 60/60 a 20/20. Čtení je zaplacené v obou případech, takže (a) by nestála nic navíc.

### Proč brána nepadla – věty

Čtení dá u všech 14 správný žánr, `chainOrSingle` se čtením přesto řekne řetěz:

| věta | žánr věty | čtení | hraje |
|---|---|---|---|
| s01, s02 | runner | runner.default | řetěz |
| s05 | platformer | platformer.default | řetěz |
| s11 | arena.escape | arena.escape | řetěz |
| s12 | arena.fight | arena.fight | řetěz |
| s15 | voyage.land | voyage.land | řetěz |
| s19, s21 | shooter | shooter.default | řetěz |
| s27 | timing.bridge | timing.bridge | řetěz |
| s36 | flap | flap.default | řetěz |
| s39 | catch | catch.default | řetěz |
| s42 | whack | whack.default | řetěz |
| s54 | crowd | crowd.default | řetěz |
| s58 | push | push.default | řetěz |

Podle sady se nic neladilo; změna pravidla `chainOrSingle` je mimo rozsah P58E.

## Útrata navíc

- **Cena jednoho čtení: 0,031 USD** (živá kontrola: 5 čtení za 0,157 USD, ~2 430 tokenů dovnitř, 120–170 ven, astra 10/50 USD za milion).
- Na sadě: 39 čtení × 0,031 = 1,23 USD za 80 vět.
- **Měsíc s 1 000 hrami:** když bude řetězem stejný podíl vět jako na sadě (49 %), je to ~490 čtení ≈ **15 USD, tedy 15 % stropu 100 USD**. Kdyby byla řetězem každá věta, 31 USD. *Odhad: podíl řetězů ve skutečném provozu nikdo neměřil; tatáž věta se v době platnosti cache odpovědí neplatí znovu, takže skutečné číslo může být nižší.*

## Jak se měří

```
npx vitest run --config vitest.measure.mts evals/play/p58e/holdout.measure.ts
```

Bez nového volání: čtení jsou uložená z P58B T8 (`p58b/readings/holdout.astra.json`, astra `low`, verze promptu `24ae3babe923814f` – stejná jako dnes). Věta jedné hry jde jako v P58D. Věta, kterou rozhodnutí bez čtení pošle do řetězu, se publikuje přes `publishChain` jako route; potom jako `runChainReading`: se čtením `chainOrSingle` znovu, a když řekne jedna hra, návrh ze čtení projde `publishReadSpec` jako dítě řetězu. Žánr hry jako v P58B (`meta.genre` návrhu). Sada je otevřená od P58B T8; měřilo se na ní jednou.

`__tests__/result.test.ts` přepočítá bránu z řádků proti prahům plánu a ověří, že řetěz přejde jen tam, kde čtení řekne jedna hra, a že výsledek i tohle README hlásí verdikt, který z řádků vychází.

## Živá kontrola (`live.json`, `live.mjs`, `live-chain-reading.png`)

Produkční build (`next start`), čtečka astra přes klíč z worktree P58B (do repa ani logu se nedostal). Režisér má adresu, která nikam nevede: řetěz ho nevolá, brána čtení řetězu potřebuje jen jeho nastavení. 5 řetězových vět z dev sady (`p56a/holdout.json`), vybraných předem podle uložených čtení.

- **4 z 4 řetězů přešly na hru ze čtení** podle předpovědi: s12 rhythm, s16 flap, s25 catch, s63 throw – každá `relation: 'reading'`, rodič je řetěz. s01 zůstal řetězem (konec `CHAIN` bez hry ze čtení), také podle předpovědi.
- Od odeslání věty do hry ze čtení **p50 3,4 s, max 5,9 s** (max je s12, první věta na čerstvém serveru – samotný POST trval 2,0 s).
- Snímek (s12, Pixel 7): stránka řetězu přešla sama na rytmickou hru, přepínač `Quick | Matched`, Matched zvýrazněný, žádné Full detail, žádné kolo řetězu ani věta o řetězu.
- **Útrata 0,157 USD** (5 čtení, z počtu tokenů, které vrátil OpenAI), strop 0,50 USD.

## Co kontrola ukázala mimo bránu

- **Bez `VERCEL_ENV` se čtení řetězu na místním serveru nikdy nezaplatí.** Kniha útraty režiséra vznikne místně jen s `VERCEL_ENV=production|preview` (`spend-store.ts:459`); bez ní strop režiséra odmítá všechno, brána `mayPayChainRead` je zavřená a řetěz zůstane bez čtení. První běh tak skončil 5× `CHAIN` bez jediného volání. Na Vercelu proměnnou nastavuje platforma, produkci se to netýká; místní měření ji potřebuje.
- Telefon přešel na hru ze čtení 7,2 s po otevření stránky, i když čtení bylo hotové dřív. Čas zahrnuje první načtení stránky na čerstvém serveru a první dotaz; rozložený není.

## Rozhodnutí pro majitele

Brána 48/60 se možností (b) na této sadě nesplní (46/60). Možnosti: (a) přecházet z řetězu na hru ze čtení vždy, když čtení dá hru – 60/60 a 20/20, útrata stejná, jen se změní pravidlo; (b) nechat dnešní stav, 46/60; (c) upravit pravidlo `chainOrSingle` tak, aby se čtením řetěz vznikal méně často – samostatná úloha s laděním na dev sadě.
