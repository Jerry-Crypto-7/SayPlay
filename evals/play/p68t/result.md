# P68T – výsledek na zapečetěné sadě (T3, 4. 11. 2026)

**Druhé kolo směrování posunulo nad práh jednu hru navíc: `drawsave` 14 z 15 a `minigolf` 12 z 15 vět dojde do své
hry, `railfps` 8 a `buildshift` 9 z 15 ne (práh 12).** Proti `main` před P68T přidal `railfps` 4 věty, `buildshift`
1, `drawsave` a `minigolf` stojí. Obecné věty se nezhoršily.

Každá věta, která do své hry dojde, se dá dohrát: 43 ze 43. Pořád chybí jen cesta od věty ke hře.

## Jak se měřilo

- Sada: 90 vět P68T (15 na každou ze čtyř her, 30 obecných přes 22 starých žánrů), zapečetěná v T1 před první
  změnou `classify.ts`, otevřená jednou 4. 11. v 08:17 UTC (`holdout-opened.json`, otisky sady i štítků sedí
  se `seal.ts`). Na sadě se nic neladilo.
- Strany: `main` = `0d432d79` (rodič commitu pečeti `7fe5c421`, stav před P68T), větev = `origin/main` `17c85b15`
  po T2 (#87). Prahy z `p68/gates.json` beze změny.
- Měří se jen G1 (směrování) a G2 (hratelnost): T2 měnil jen směrování, žádnou hru, scénu ani sestavení. FPS,
  čas do hratelnosti a determinismus her platí, jak je zapsal P68R T6.
- Surová čísla: `result.json`; přepočet a kontrola tohoto souboru: `__tests__/result.test.ts`.

## Hry

| Hra | G1 směrování (≥ 12/15) | `main` před P68T | P68R T6 (jiná sada) | G2 hratelnost (≥ 12/15) | Verdikt G1+G2 |
|---|---|---|---|---|---|
| `minigolf` | 12/15 ✓ | 12/15 | 13/15 | 12/15 ✓ | **splněno** |
| `railfps` | 8/15 ✗ | 4/15 | 8/15 | 8/15 ✗ | **nesplněno** |
| `buildshift` | 9/15 ✗ | 8/15 | 10/15 | 9/15 ✗ | **nesplněno** |
| `drawsave` | 14/15 ✓ | 14/15 | 11/15 | 14/15 ✓ | **splněno** |

- **G1** = hra, kterou dá skladatel rychlé hry (`draftGameSpecWithMeta(věta, 1)`), tedy hra, kterou hráč dostane.
  Sloupec P68R je tentýž ukazatel na zapečetěné sadě P68R (jiné věty).
- **Obecné věty beze zhoršení:** 30 obecných vět sady chybně 6 = `main` 6; sada 200 chybně 64 ze 175 = `main`;
  0 přesunů mezi starými žánry na sadě i na štítcích P68 T2. Jedna obecná věta (`p68t-073`, kuchař knedlíčků
  u stánku) přešla z `quest` do `buildshift`, obojí je pro ni přijatelné.
- **G2:** 43 ze 43 vět, které rychlá hra pošle do správné hry, robot vyhraje, nečinný i slabý hráč prohraje a všechny
  požadované akce proběhnou. Věta poslaná jinam se počítá jako selhání, proto G2 = G1.

## Kam šly minuté věty

- **`railfps` (7):** šest do `voyage`, jedna do `platformer`. Hráče veze něco, co znaky z T2 neznají nebo co jede
  bez slovesa jízdy: sáně „on a set path“, žebřík hasičského vozu, monorail, výtah do vesmíru, jeep „on safari track“,
  zahradní traktor „along the path“, poštovní vlak, na který skáčou psi.
- **`buildshift` (6):** dvakrát `quest`, dvakrát `arena`, `voyage`, `throw`. Podnik bez slovesa obsluhy a vedení:
  „owner of tea house“, „my space gas station“, „design a school cafeteria“, „waiting at a smoothie bar“, „pet groomer
  shop“, „rushing my hot dog stand“.
- **`drawsave` (1):** „my finger lines are the only thing between them“ – čára jako ochrana bez slovesa.
- **`minigolf` (3):** golf v pekárně s masovou koulí do hrnce, perla do škeble, planeta do černé díry „in few strokes“.

## Co z toho plyne

**Fakta:**

- Na ladicí sadě (otevřená P68R) měly všechny čtyři hry 15/15, na nové sadě `railfps` 8, `buildshift` 9. Mezera mezi
  ladicí a zapečetěnou sadou je menší než v P68R (`drawsave` 15 → 14), ale u dvou her pořád velká.
- `railfps` se proti `main` zlepšil o 4 věty, `buildshift` o 1; `drawsave` byl na této sadě 14/15 už na `main`.

**Inference:**

- Znaky z T2 zachytí věty, které jmenují vozidlo i výstřel, nebo podnik se slovesem vedení. Minuté věty říkají totéž
  bez těch slov („on a set path“, „my … stand“) – další seznam slov by zase sedl na ladicí sadu víc než na hráče.
- Rychlá hra pro `railfps` a `buildshift` asi potřebuje jiný druh signálu než další vzory – např. čtení věty modelem,
  které už existuje pro AI verzi.
