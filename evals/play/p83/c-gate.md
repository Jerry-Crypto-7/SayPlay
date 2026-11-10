# P83C T5 – brána klikací simulace (10. 11. 2026)

**Výsledek: brána NEPROŠLA – neslučovat.** Slepý soud 6/10 (mez ≥ 7). Směrování 8/10 (mez ≥ 7) prošlo.

Data: `c-gate.json` (směrování, snímání, odpovědi soudce u každé věty). Listy se snímky: `D:/tmp/p83c/seal/<id>-sheet.png` (mimo repo).

## Jak se měřilo
- 10 zapečetěných vět (`c-sentences.json` → `sealed`) čtených poprvé; od T1 je nikdo neladil a po tomhle běhu už zapečetěné nejsou.
- Hra z rychlé verze bez modelu (`draftGameSpecWithMeta(text, 1)`), produkční build, `next start` na 3213, Chromium d3d11, desktop 1280 × 720.
- Start hry jedním klikem na prázdnou zem u levého okraje, snímek A po 5 s, pak tři kliky na věci (klikací simulace: na věci z `data-orrery-things`; jiné typy: střed plochy), snímek B. Oba snímky na jednom listu s neutrálními popisky.
- Soudce: `codex exec -i sheet.png` v prázdném dočasném adresáři, kontrakt v `task.md` + schéma odpovědi, po jedné, bez web searche. Otázky: ukazuje A to, co věta popisuje? Ukazuje B viditelnou odezvu na kliky? „Ano“ = obojí.

## Věty

| Věta | Typ hry | Odezva (počítadlo) | Ukazuje větu | Reaguje | Ano |
|---|---|---|---|---|---|
| 01 sluneční soustava, jména planet | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 02 atom, elektron zazáří | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 03 hodinový stroj, ozubená kola se zrychlí | sbírání (arena) | – | ne | ne | ❌ |
| 04 akvárium: klaun, želva, medúza | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 05 orchestr, nástroje se rozsvítí | rytmická hra | – | ne | ano | ❌ |
| 06 mapa města: škola, nemocnice, park, nádraží | klikací simulace | 0 → 3 | ne | ano | ❌ |
| 07 lidské srdce, čtyři komory | klikací simulace | 0 → 3 | ne | ano | ❌ |
| 08 sopečný ostrov: sopka, palmy, lávové kameny | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 09 meteostanice: slunce, mrak, kapka, vločka | klikací simulace | 0 → 3 | ano | ano | ✅ |
| 10 hrací skříňka: baletka, hvězda, měsíc dokola | klikací simulace | 0 → 3 | ano | ano | ✅ |

Klikací simulace sama: 6 z 8 her „ano“, odezvu na kliky soudce viděl u všech osmi.

## Proč čtyři „ne“ (fakta ze soudu a ze směrování)
- **03 a 05 – věta do klikací simulace nedošla.** 03 „gears that turn faster when you tap them“: klasifikátor nenašel žádnou narážku (`no cue`), hra spadla do výchozího sbírání (soudce: obecné sbírání, žádná kola). 05 „a violin, a drum… that each get brighter when clicked“: narážka „drum“ dala rytmickou hru a přebila znak `explore` (soudce: nástroje chybí).
- **06 – město nepoznal:** čtyři samostatné věci na hnědé zemi (kostka, „postel“, dvě koule), žádné ulice ani poznatelné budovy, jména až po kliknutí.
- **07 – srdce nepoznal:** čtyři barevné koule; jmenovky po kliku jsou jen „Chamber“, ne levá/pravá síň a komora.

## Inference (ne měřeno)
- Obě chyby obrazu (06, 07) mají stejnou příčinu: věc bez modelu v katalogu se kreslí jako koule a jméno se ukáže až po kliku, takže snímek před klikem celek („město“, „srdce“) neprozradí. Jmenovky viditelné od startu nebo rozlišená jména („left atrium“) by soud nejspíš otočily – ověřit to jde jen na nové zapečetěné sadě.
- Směrování: znak `explore` nepozná zájmeno jako cíl klepnutí („tap them“) a prohraje s narážkou jiného typu, když věta jmenuje věc z jeho slovníku („drum“).

## Vedlejší pozorování
- U her se 3 věcmi (04, 08, 10) skončí hra po třetím kliku obrazovkou „You did it! … 565 points … collected“ – u hry „prozkoumej“ bez prohry to zní jako sbírání.
- Bublina „Grab them!“ (sloveso `collect` v `action-cue/verb-line.ts`) u klikací simulace v prvním snímání (02, 07) – slovník sbírání.
- Věta 05 (rytmická hra) hodí chybu stránky `Cannot set properties of undefined (setting 'NaN')` po klicích do středu plochy. Větev rytmické soubory nemění; původ neověřen.
