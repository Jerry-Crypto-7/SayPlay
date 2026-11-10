# P83E T8 – druhá brána obchodu se součtem (sada `sealed2`, otevřená poprvé 10. 11. 2026)

**Výsledek: brána NEPROŠLA – neslučovat.** Do obchodu jdou jen 3 věty z 10. Co do obchodu dojde, funguje (robot 3/3, věci, místo a součet podle věty), ale čtení věty pozná obchod jen podle uzavřeného seznamu míst (pult, váha, mísa…).

Sadu napsal samostatný agent před opravami T7 (`65b408c0`), opravy T7 ji neviděly. Měřeno na kódu `65792a18`.

| Měřítko | Mez | Naměřeno | |
|---|---|---|---|
| Směrování do `shop` (rychlá verze, bez modelu) | ≥ 7/10 | **3/10** | ❌ |
| Robot vyhraje směrované hry (`verifyArcade`, semínko 1) | všechny | **3/3** (v prohlížeči taky 3/3, 0 chyb stránky) | ✅ |
| Počet věcí ve hře = počet z věty | všechny, kde ho věta říká | **2/5** (2/2 směrované; 3 věty s počtem nesměrované) | ❌ |
| Slepý soud `codex exec` | ≥ 7/10 | **nespuštěn** – běh s `--no-codex`; nesměrované věty se počítají jako ne, takže nejvýš 3/10 a bránu soud nezvrátí | ❌ |

## Věta po větě (fakta)

| # | Věta (zkráceně) | Typ | Hra | Robot (prohlížeč) |
|---|---|---|---|---|
| 1 | flower shop, **five** bunches of roses on the counter, how much they cost | shop | 5 věcí „bunch“, $, pult | výhra, $29.00 |
| 2 | fisherman, **four** crabs to the harbour scale, adds up their weight | shop | 4 kraby, kg, váha, kotvy | výhra, 20 kg |
| 3 | hardware store, fill a toolbox, bill exactly 18 dollars | quest.station | – | – |
| 4 | airport, **six** suitcases onto the baggage belt, how heavy all together | arena.collect | – | – |
| 5 | **three** pieces of sports gear to the cash desk, pay the total | timing.stack | – | – |
| 6 | garden centre, seed packets into the wheelbarrow, count seeds altogether | arena.collect | – | – |
| 7 | crab, seashells into a bucket, points to the total | quest.spatial | – | – |
| 8 | stationery shop, till adds up notebook, pen and ruler | shop | 3 medvídci, $, pult | výhra, $10.00 |
| 9 | camping, logs to the campfire, warmth adds up to exactly 40 | quest.spatial | – | – |
| 10 | astronaut, **seven** moon rocks to the rover, total weight | quest.spatial | – | – |

Snímky a/b/c směrovaných her: `D:/tmp/p83e/gate2/sheets/{1,2,8}-{a,b,c}.png`, řádky měření `D:/tmp/p83e/gate2/gate-rows.json`.

## Proč (odvozeno z kódu, neověřeno opravou)

1. **Znak `tally` chce místo z uzavřeného seznamu** (`TALLY_PLACE` v `src/play/genre/classify.ts:114`: counter, checkout, till, register, scale, belt, cauldron, pot, bowl, tray, cart). Věty 3, 5, 7, 9, 10 mají slovo součtu (bill, total, adds up, exactly 40), ale místo mimo seznam: toolbox, cash desk, bucket, campfire, rover. Tvar věty „nesu věci DO/NA *cokoli* + součet“ znak nečte.
2. **Chybí obraty součtu** „how heavy … all together“ (věta 4 – „belt“ na seznamu je, součet ne) a „count how many … altogether“ (věta 6, wheelbarrow taky mimo seznam).
3. **Vyjmenované věci se nečtou jako věci** (věta 8: „notebook, pen and ruler“ → výchozí medvídci). Bez počtu ve větě hra dá výchozí 3 – tady náhodou sedí.

## Co z toho plyne (odvozeno)

Opravy T7 zvedly spálenou sadu ze 7 na 9 z 10, ale na nové sadě je směrování 3/10, horší než první brána (7/10). Seznam míst a obratů roste s každou sadou – další oprava stejného druhu by naladila zase jen viděné věty. Obecnější cesta je číst tvar věty (sloveso nesení + cíl s předložkou into/onto/to + obrat součtu) místo seznamu míst, a to je rozhodnutí o rozsahu pro majitele.
