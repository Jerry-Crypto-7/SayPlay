# P68R – výsledek na zapečetěné sadě (T6, 3. 11. 2026)

**Cíl P68 teď splnila jedna hra, `minigolf`: 13 z 15 nových vět dojde do své hry a všechny se dají dohrát.** Ostatní
tři zapojené hry se zlepšily proti T15, ale pod práh 12 z 15 nedošly: `drawsave` 11, `buildshift` 10, `railfps` 8.
`stunt` zůstal za branou času (T4), takže ho rychlá hra nenabízí (0 z 15). Žádná kategorie proto splněná není –
každá má aspoň jednu nesplněnou hru.

Jakmile věta dojde do správné hry, hra funguje: všech 42 takových vět je hratelných, na emulovaném telefonu běží
59,9 FPS a `buildshift`, zapojený v T5, je hratelný dřív než na `main` (desktop i telefon). Chybí zase jen cesta od
věty ke hře.

## Jak se měřilo

- Sada: 105 vět P68R (15 na každou novou hru, 30 obecných přes 22 starých žánrů), zapečetěná v T1 před první
  změnou směrování, otevřená jednou 3. 11. ve 20:05 UTC (`holdout-opened.json`, otisky sady i štítků sedí
  s `seal.ts`). Na sadě se nic neladilo.
- Strany: `main` = `188d44e9` (před P68R, port 3181), větev = `origin/main` `dded82df` po T5 (port 3180). Prahy
  z `p68/gates.json` beze změny. Postup a příkazy: `README.md`, oddíl T6.
- Surová čísla: `result.json`; přepočet a kontrola tohoto souboru: `__tests__/result.test.ts`.

## Hry

| Hra | Kategorie | Zapojená | G1 směrování (≥ 12/15) | T15 (sada P68) | `main` (sada P68R) | G2 hratelnost (≥ 12/15) | G3 FPS telefon | G4 čas | G5 determinismus | Verdikt |
|---|---|---|---|---|---|---|---|---|---|---|
| `stunt` | vozidla-sport | ne (T4) | 0/15 ✗ | 0/15 | 0/15 | 0/15 ✗ | 59,9 FPS, p95 33,2 ms ✓ | neměřeno ✗ | ✓ | **nesplněno** |
| `minigolf` | vozidla-sport | ano | 13/15 ✓ | 10/15 | 9/15 | 13/15 ✓ | 59,9 FPS, p95 16,8 ms ✓ | ✓ (z T15) | ✓ | **splněno** |
| `railfps` | prvni-osoba | ano | 8/15 ✗ | 4/15 | 7/15 | 8/15 ✗ | 59,9 FPS, p95 16,8 ms ✓ | ✓ (z T15) | ✓ | **nesplněno** |
| `buildshift` | stavba | ano (T5) | 10/15 ✗ | 0/15 | 0/15 | 10/15 ✗ | 59,9 FPS, p95 33,3 ms ✓ | ✓ (změřeno v T6) | ✓ | **nesplněno** |
| `drawsave` | stavba | ano | 11/15 ✗ | 10/15 | 8/15 | 11/15 ✗ | 59,9 FPS, p95 16,8 ms ✓ | ✓ (z T15) | ✓ | **nesplněno** |

- **G1** = hra, kterou dá skladatel rychlé hry (`draftGameSpecWithMeta`), tedy hra, kterou hráč dostane. Sloupec T15
  je tentýž ukazatel na zapečetěné sadě P68 (jiné věty), sloupec `main` je stav před P68R na sadě P68R.
- **Obecné věty beze zhoršení:** 30 obecných vět sady chybně 6 = `main` 6; sada 200 chybně 64 ze 175 = `main`
  (0,366); 0 přesunů mezi starými žánry na sadě i na štítcích T2. Jedna obecná věta (`p68r-088`) přešla v klasifikátoru
  z `quest` do `buildshift`, počet chybných se tím nezměnil.
- **G2:** 42 ze 42 vět, které rychlá hra pošle do správné hry, robot vyhraje, nečinný i slabý hráč prohraje a všechny
  požadované akce proběhnou. Věta poslaná jinam se počítá jako selhání, proto G2 = G1.
- **G3:** `pixel7-touch` (CPU ×4) hradí; kontrolní `p66-arrows` 59,9 FPS, p95 33,4 ms. `iphone-touch` jen zapisuje
  (WebKit hostitele, kontrola 20,8 FPS).
- **G4:** `buildshift` změřený v T6 (3 věty sady × 3 běhy, A = `main` před P68R, kde tytéž věty hrají jiné hry):
  desktop medián 2 095 ms (mez 3 000), párově −406 ms, `pixel7-cpu4` párově −392 ms (mez +200), 0 z 36 běhů
  selhalo. `minigolf`, `railfps` a `drawsave` se od T15 nezměnily, jejich běhy jsou z T15 (párově desktop −979 / −738
  / −1 827 ms, telefon −3 707 / −1 510 / −1 035 ms, 0 selhání). `stunt` nezapojený, neměřený (T4: telefon +1 925 ms).
- **G5:** `p66-hash` 48, `p66-hooks-existing` 47, `p68-hash` 50, `p68-roundtrip` 9 – vše zelené, nic přeskočené.

## Kategorie

| Kategorie | Hry | Verdikt | Důvod |
|---|---|---|---|
| `vozidla-sport` | `stunt`, `minigolf` | **nesplněno** | `minigolf` splněno; `stunt` za branou času (telefon +1 925 ms proti `main`, mez +200 ms) |
| `prvni-osoba` | `railfps` | **nesplněno** | jen 8 z 15 vět do `railfps` – střelba z jedoucího vozidla mimo koleje jde do `voyage`, `platformer`, `shooter`, `throw` |
| `stavba` | `buildshift`, `drawsave` | **nesplněno** | `buildshift` 10 a `drawsave` 11 z 15 vět ve své hře |

## Co se neměřilo a proč

- **G6 kvalita** (druhotná): hru, která neprojde G1–G5, nezachrání a verdikt by nezměnila; plán P68R měří jen
  G1–G5. Slepý soud 105 listů z telefonu potřebuje focení obou stran a 105 volání soudce (Codex má sdílený limit
  50 denně).
- **G7 AI verze** (bez prahu): stála by peníze a plán P68R je bez útraty; v T15 poskytovatel režiséra od třetí věty
  vzorku vracel 429.

## Co z toho plyne

**Fakta:**

- Rozdíl mezi ladicí a zapečetěnou sadou je velký: na otevřeném holdoutu P68, kde T2 ladil, měl `railfps` 15/15,
  na nové sadě 8/15. `buildshift` 15/15 proti 10/15, `drawsave` 15/15 proti 11/15, `minigolf` 15/15 proti 13/15.
- Minuté věty `railfps` (7): střelba nebo házení z jeepu, z vznášecího vlaku, z obléhací věže, z balónu,
  z traktoru, ze skútru, ze školního autobusu – žádná nemá koleje ani vozík.
- Minuté věty `buildshift` (5): obchod nebo podnik, ve čtyřech z pěti bez slov „serve“ a „customers“ – benzínka pro
  mimozemšťany, cukrárna, „burger joint tycoon“, stánek s džusy, zmrzlinové stroje na promenádě.
- Minuté věty `drawsave` (4): „my lines block / stop“, „draw something to stop“ a ochrana před padajícím bez slovesa
  kreslení.

**Inference:**

- Znaky her z T2 a T5 sedí na slova otevřeného holdoutu P68 víc než na to, jak hráči hry popisují obecně. Další
  kolo směrování by mělo ladit na všech otevřených sadách naráz (dev P68, holdout P68 i tato sada) a verdikt dát
  zase nová zapečetěná sada – tahle je od T6 otevřená.

**Doporučení:**

1. `railfps`: znak „střílím, zatímco jedu“ pro jakékoli jedoucí vozidlo (jeep, vlak, věž, balón), ne jen koleje
   a vozík; `voyage` si nechá jízdu bez střelby. Největší díra (8/15).
2. `buildshift`: znak „stavím nebo kupuji vybavení a přicházejí zákazníci“ včetně „tycoon“, „shop“ se zbožím
   a návštěvníků, kteří něco chtějí.
3. `drawsave`: „lines“ jako nástroj hráče a „draw something“; ochrana před padajícím i bez slovesa.
4. `stunt`: zbytek je fyzika a tvorba na serveru (T4); bez nového přístupu k času na telefonu zůstane za branou.
