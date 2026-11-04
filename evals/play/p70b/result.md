# P70B – výsledek na zapečetěné sadě (T5, 4. 11. 2026)

**Golf teď znamená minigolf: 19/20 vět (na `main` 7/20). Zvíře z věty je hrdinou u 21/30 vět (na `main` 17/30),
cíl 27/30 nesplněný.** Obecné věty se nezhoršily. Hratelnost G2 je 29/52 (cíl ≥ 95 % nesplněný) – všech 23 chyb je
ve starých žánrech, kde vyhraje i slabý hráč, a stejných 23 vět padá stejně i na `main` (17/40).

| Cíl (plán T5, AC2) | `main` před P70B | větev | práh | splněno |
|---|---|---|---|---|
| zvíře z věty je hrdina | 17/30 | 21/30 (70 %) | ≥ 90 % = 27/30 | ✗ |
| golf → minigolf | 7/20 | 19/20 | ≥ 18/20 | ✓ |
| obecné věty: chybně poslané | 5 z 20 | 5 z 20, 0 přesunů | ≤ `main` | ✓ |
| G2 hratelnost správně poslaných | 17/40 (43 %) | 29/52 (56 %) | ≥ 95 % | ✗ |

## Jak se měřilo

- Sada: 70 vět z T1 (30 se zvířetem přes 15 riggovaných druhů, 20 golfových, 20 obecných přes 14 starých žánrů),
  zapečetěná před první změnou směrování, otevřená jednou 4. 11. v 15:58 UTC (`holdout-opened.json`). Na sadě
  se nic neladilo.
- Strany: `main` = `0d3fa930` (stav před P70B), větev = `be96cde6` (P70B T1–T4 + `origin/main` `03893239`).
- Směrování (`route-*.json`): hra a hrdina, které dá rychlá hra (`draftGameSpecWithMeta(věta, 1)`), hrdina =
  `heroModel(spec)`. Hrdina sedí, když je to jeden z modelů zvířete ze štítku.
- G2 (`gameplay-*.json`): nad větami, které daná strana poslala do správné hry – robot vyhraje, nečinný i slabý
  hráč prohraje a požadované akce her P68 proběhnou. Staré žánry nemají vlastní seznam akcí, jedou jen první tři
  kontroly (oprava `assertGame` v T5; dřív na nich měření spadlo).
- Surová čísla: `result.json`; přepočet a kontrola tohoto souboru: `__tests__/result.test.ts`.

## Kde to chybí

**Hrdina (9 minutých):**

- **Správná hra, jiný hrdina (5):** králík v `hole` dostal kovboje (`p70b-002`), mláďata králíků v `defense`
  mimino (`003`), alpaka v `shooter` kovboje (`029`); ve `voyage` řídí raketu tučňáka (`010`) a jetpack krávy
  (`019`) samotné vozidlo bez zvířete.
- **Jiná hra, zvíře jde s ní (4):** tučňák a slučování ryb → `arena` místo `merge` (`009`), lední medvěd na
  rampách → `runner` místo `stunt` (`012`), kuře přes plot → `voyage` místo `flap` (`026`), krab a racci →
  `quest` místo `whack` (`027`). Stejně je pošle i `main`.

**Golf (1):** „a frog that golfs on lily pads“ → `throw` (`047`).

**Obecné (5, stejně jako `main`):** `059`, `061`, `063`, `066` a „whack the gophers popping out of the golf course
holes“ (`065`) → `minigolf`, ten i na `main`.

**G2 (23 z 52):** překlad 52/52, robot vyhraje 52/52, nečinný prohraje 52/52, akce her P68 (minigolf 19, drawsave 1,
railfps 1) všechny prošly. Padá jen „slabý hráč prohraje“: 23 vět ve 14 starých žánrech (`hop`, `runner`,
`shooter`, `quest`, `throw`, `rhythm`, …), kde slabý robot hru vyhraje. Na `main` padá tatáž kontrola u týchž
23 vět – P70B ji nezpůsobil. 12 vět, které větev poslala správně navíc (hlavně golf → minigolf), prošlo všech 12.

## Co z toho plyne

**Fakta:** golf je vyřešený, hrdina se zlepšil o 4 věty, ale 5 vět má správnou hru a pořád jiného hrdinu. Pravidlo
„slabý hráč prohraje“ zavedl P68 jen pro nové hry; staré žánry ho nikdy neplnily.

**Inference:**

- Kovboj a mimino jsou náhradní hrdinové žánrů `hole`, `defense` a `shooter` – zvíře z věty se tam ke hrdinovi
  nedostane stejnou cestou, kterou T3 opravil v deseti jiných žánrech. Vozidlo ve `voyage` potřebuje zvíře jako
  řidiče, ne místo něj.
- 4 minutí hrdinové jsou chyba směrování do žánru, ne výběru postavy.
- G2 u starých žánrů je otázka definice: buď staré hry dostanou slabšího robota, nebo se pro ně kontrola slabého
  hráče vypne. Na verdikt P70B to vliv nemá, chyba je stejná na obou stranách.

## Doporučení

1. Hrdina v `hole`, `defense`, `shooter` a zvíře jako řidič ve `voyage` – 5 vět, cíl 27/30 by to skoro dorovnalo
   (26/30). Ladit na otevřených sadách, ověřit na nové pečeti.
2. Rozhodnout, zda „slabý hráč prohraje“ platí i pro staré žánry; dokud ne, G2 nad starými žánry počítat bez ní
   a zapsat to jako změnu brány.
3. „golf course“ jen jako místo (`065`) nemá znamenat minigolf – drobná oprava pravidla z T2.
