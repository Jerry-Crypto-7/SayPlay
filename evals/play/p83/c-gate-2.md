# P83C T8 – druhá brána klikací simulace (10. 11. 2026)

**Výsledek: brána 2 NEPROŠLA – neslučovat.** Směrování 5/10 (mez ≥ 7). Slepý soud 4/10 (mez ≥ 7).

Data: `c-gate-2.json` (směrování, snímání, odpovědi soudce u každé věty). Listy se snímky: `D:/tmp/p83c/seal2/<id>-sheet.png` (mimo repo).

## Jak se měřilo
- 10 vět druhé zapečetěné sady (`c-sentences.json` → `sealed2`, `111b9c2a`). Psal je samostatný agent před opravami T7, tahle větev je četla poprvé až tady; nikdo je neladil.
- Stejná metoda a stejné skripty jako první brána (`c-gate.md`): rychlá verze bez modelu (`draftGameSpecWithMeta(text, 1)`), produkční build `30bdfd2d`, `next start` na 3213, Chromium d3d11, desktop 1280 × 720.
- Start hry jedním klikem na prázdnou zem u levého okraje, snímek A po 5 s, pak tři kliky na věci (klikací simulace: na věci z `data-orrery-things`; jiné typy: střed plochy), snímek B.
- Soudce: `codex exec -i sheet.png` v prázdném dočasném adresáři, kontrakt v `task.md` + schéma odpovědi, po jedné, bez web searche. „Ano“ = A ukazuje větu a B ukazuje odezvu na kliky.

## Věty

| Věta | Typ hry | Odezva (počítadlo) | Ukazuje větu | Reaguje | Ano |
|---|---|---|---|---|---|
| 01 lidská kostra, kost ukáže jméno | sbírání (arena) | – | ne | ano | ❌ |
| 02 vesmírná stanice: astronaut, anténa, panel, kapsle | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 03 velká klávesnice, klávesa se zvětší | klikací simulace | 0 → 3 | ne | ano | ❌ |
| 04 pirátská loď: kapitán, papoušek, truhla, kotva | sbírání (arena) | – | ne | ne | ❌ |
| 05 výloha pekárny: croissant, chléb, preclík, dort | sbírání (arena) | – | ne | ne | ❌ |
| 06 větrné mlýny na kopci, lopatky se zrychlí | sbírání (arena) | – | ne | ne | ❌ |
| 07 bedna s nářadím: kladivo, klíč, šroubovák, pila | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 08 balony nad údolím, balon se nafoukne | běh (voyage) | – | ne | ano | ❌ |
| 09 přístav v noci: maják, rybářská loď, plachetnice | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 10 letiště: letadla kolem řídicí věže | klikací simulace | 0 → 3 | ano | ano | ✅ |

Klikací simulace sama: 4 z 5 her „ano“, odezvu na kliky soudce viděl u všech pěti. Proti první bráně (6 z 8) drží obraz; propadlo směrování.

## Proč šest „ne“ (fakta ze soudu a ze směrování)
- **01, 05, 06 – věta do klikací simulace nedošla, klasifikátor nenašel narážku (`no cue`)** → výchozí sbírání („Collect the bones!“, „Collect the windmills!“). Cíl klepnutí je tu „each bone … when clicked“, „touch one and it puffs up“, „tap a windmill and its blades spin faster“ – ani jedna z frází, které T7 přidala.
- **04 – „explore a pirate ship … show their names when you tap them“:** sloveso „explore“ se přečetlo jako `search` → sbírání mincí. Věc z věty (loď) je jen hráčova postava.
- **08 – „when you tap a balloon it inflates and grows“:** hlavní sloveso `make` → běh (voyage), soudce viděl běžce v lese.
- **03 – klávesnice nepoznal:** pět samostatných klíčů se jmenovkou „Key“ na hnědé zemi; celek „keyboard“ ani písmena na klávesách nejsou.

## Inference (ne měřeno)
- Opravy T7 sedí na frázích ze spálené sady (10/10 tam), na nových tématech se znak `explore` chytá jen tehdy, když věta jmenuje věci výčtem a „tap/touch/click them/each“. Věta s jednou opakovanou věcí („a windmill“, „a balloon“, „each bone“) nebo s vlastním slovesem odezvy („puffs up“, „inflates“) ho mine. Další kolo oprav na slovníku frází by nejspíš opakovalo totéž; obecnější pravidlo by bylo „věta popisuje místo/předmět a klepnutí vyvolá změnu vzhledu nebo pohybu“.
- Obraz uvnitř typu je stabilní (jmenovky od startu fungují: 02, 07, 09, 10 soudce poznal podle jmen). Slabé místo zůstává celek bez vlastního tvaru (03 klávesnice, dřív 06 město, 07 srdce).

## Vedlejší pozorování
- 07 přidá k nářadí pátou věc „tool“ (žlutý předmět, počítadlo 0/5) – slovo z věty „touch each tool“.
- 09 (3 věci) skončí po třetím kliku obrazovkou „565 points“; soudce to bral jako odezvu.
- Chyba stránky se v žádné z deseti her neobjevila.
