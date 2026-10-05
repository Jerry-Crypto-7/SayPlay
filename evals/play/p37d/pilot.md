# P37D T2 – pilot 20 modelů: co výroba skutečně dodá

**Měřeno:** 3. 10. 2026, RTX 3090 pod `gpu-lock.mjs`, `ops/gen3d/batch.py --seeds 1,2,3` (výroba), `quality_gate.py` (brána), `scripts/p37d/judge-sheet.mjs` (slepý soudce nad listem čtyř pohledů), pak prohlédnutý každý list. Vstup: 20 nejčastějších jmen z `missing.json` (`d7150a60`). Surová čísla po modelech: `pilot.json`. Listy a GLB: `D:/caches/p37d/pilot/` (mimo repo).

## Rozhodnutí o rozsahu

- **Vyrábět všech 221 chybějících jmen**, ne výběr. Strop není GPU, ale zásoba jmen: 201 zbylých × ~2 min ≈ **6,7 h GPU = 4 dávky** po ≤ 110 min (~55 jmen na dávku), v pořadí `missing.json` (dávka 1 = pořadí 21–75, 2 = 76–130, 3 = 131–185, 4 = 186–221).
- Do 22. 10. zbývá 18 dní; i když GPU polovinu času drží P37A (lokální režisér na `dev-150` a `test-200` jsou jednotky hodin), zbývá desetinásobek potřeby. Pátá dávka je rezerva na opakování zamítnutých s jiným semínkem.
- **Odhad přijatých: ~145 z 221** (odvozeno, ne změřeno – viz tabulka tříd níž). Zbytek padne na tenké a ploché věci a na role lidí; ty zůstanou na tabulce nejbližšího modelu (P37A).
- Velikost neomezuje: ~145 × (78 + 20) KB ≈ 14 MB proti stropu ~150 MB.

## Čísla

| Co | Výsledek |
|---|---|
| čas na model, včetně neúspěšných semínek | medián **97 s**, p90 198 s, max 256 s, celkem 40 min za 20 |
| brána kvality napoprvé (semínko 1) | 15/20 (75 %) – 5× „shredded mesh“ |
| brána kvality do třetího semínka | **20/20** (vše nejpozději semínkem 2) |
| slepý soudce (jméno sedí, síť neporušená) | **8/20** (40 %), top1 6 |
| po prohlédnutí listů | **10/20** (50 %) – navíc „bug“ (soudce: beetle) a „investor“ (businessman) |
| LOD0 | medián 78 KB, max 94 KB (strop ×1,5 mediánu výroby = 141 KB) |
| LOD1 | medián 20 KB, max 34 KB |
| soudce | medián 15 s na list, souběh 3 → 221 listů ≈ 20 min |

**Brána kvality nic neříká o tom, co model je:** „paper“ prošel jako kostka, „frisbee“ jako sud. Rozhoduje až soudce nad listem.

## Kde výroba selhává – podle tříd

| Třída | V pilotu | Přijato (po prohlédnutí) | Ve zbylých 201 jménech | Odhad přijatých |
|---|---|---|---|---|
| pevný předmět, zvíře, vozidlo, stroj | frog, squirrel, submarine, bug, monster truck, water gun, washing machine, conveyor belt | 8/8 | ~143 (wolf, forklift, kettle, pretzel…) | ~125–130 |
| tenké, ploché, drobné | rope, paper, frisbee, mahjong tile, paper ball, puddle, ramp | 0/7 | ~47 (pencil, playing card, towel, snowflake…) | ~7 |
| role člověka | sumo, investor, stickman, vet, owner | 2/5 | ~11 (spy, cashier, mailman, santa…) | ~4 |

- **Tenké a ploché:** obrázek je dobrý, síť TRELLIS z něj udělá objem – provaz je tyč, papír kostka, kaluž koberec. Opravovat prompt teď nestojí za to (jednorázová ztráta ~40 jmen); kdyby se ukázalo, že na nich porotci stojí, pátá dávka zkusí prompt „lying flat, seen from above at 3/4“.
- **Role:** „owner“, „vet“ nejsou vidět, jen „člověk“. „Investor“ jako muž v obleku je v pořádku, „stickman“ vyšel jako obyčejný muž.

## Kalibrace soudce (před pilotem)

Soudce se nejdřív zkusil na 16 modelech, které člověk dřív schválil (`approved.json`), a na 7, které výroba udělala a člověk nevzal:

| Verze | Schválené přijaté | Zamítnuté přijaté | Shoda s člověkem |
|---|---|---|---|
| původní | 10/16 | 3/7 | 61 % |
| zaslepená | 7/16 | 1/7 | 57 % |
| **zaslepená + „poškozené“ jen vážně (použitá)** | **11/16** | **2/7** | **70 %** |

- **Původní soudce nebyl slepý.** List se jmenoval `ramp.png` a pracovní adresář obsahoval seznam jmen; dveře soudce nazval „ramp“, kaluž „puddle“. Teď každá otázka dostane prázdný adresář se souborem `sheet.png`; po zaslepení jsou to „door“ a „frisbee“.
- **„Neporušený“ byl moc přísný:** shodil 7 schválených modelů (gorila, kompas, jukebox) za hrubé fasety. Otázka se teď ptá jen na rozpadlé střepy, velké díry a roztavené hroudy; potrhanou starou veverku pořád chytí.
- **Lidské štítky jsou samy zašuměné:** schvalovalo se hromadně z přehledu 28. 9.; schválený jukebox je stejně zmačkaný jako zamítnutá pračka. 70 % je proto strop toho, co se tu dá změřit, ne vada soudce.
- **Soudce kolísá mezi běhy:** tentýž list jukeboxu dvakrát poznal a jednou nazval „trash bin“. Jeden dotaz na model stačí pro třídění, ne pro závěr o jednom modelu – druhé kolo jinou otázkou je T5.

## Pro T3 a T4

1. **Soudce porovnávat se všemi jmény, pod kterými se model zapíše** (`nouns[]` dávky), ne jen s hlavním: „bug“ ↔ beetle, insect; „investor“ ↔ businessman. V pilotu by to přidalo 2 přijaté bez ručního zásahu.
2. Každou dávku po soudci prohlédnout přehledem (`batch-sheet.png`); prohlédnutí smí model jen vyřadit nebo přijmout nadřazené jméno, s důvodem v záznamu dávky.
3. Pilotní přijaté pro T3: frog, squirrel, submarine, monster truck, water gun, washing machine, conveyor belt, sumo + po prohlédnutí bug, investor. Jako e2e hrdinu brát „frog“ nebo „squirrel“ (mají třídu hrdiny).
