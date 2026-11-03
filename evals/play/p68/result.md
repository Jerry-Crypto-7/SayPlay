# P68 – výsledek na zapečetěném holdoutu (T15, 3. 11. 2026)

**Žádná z pěti nových her cíl P68 nesplnila, a proto nesplnila ani žádná kategorie.** Hry, které jsou zapojené
(`minigolf`, `railfps`, `drawsave`), se hrají dobře: každá věta, kterou rychlá hra pošle do správné hry, je hratelná,
na telefonu běží 60 FPS a hra je hratelná dřív než na `main`. Zastavilo je až směrování: rychlá hra pošle do
správné hry jen 10, 4 a 10 z 15 vět, práh je 12. `stunt` a `buildshift` zůstaly za branou aktivace, protože ani po
dvou kolech oprav kategorie nesplnily čas do hratelnosti (R13, R14), takže je rychlá hra nenabídne vůbec.

## Jak se měřilo

- Holdout: 105 vět (15 na každou novou hru, 30 obecných přes 24 starých žánrů), otevřený jednou 3. 11. v 10:11 UTC
  (`holdout-opened.json`, otisk `f24fadb0…` sedí s `seal.ts`). Na holdoutu se nic neladilo.
- Strany: `main` = `688d989d` (stav před P68, port 3181), větev = `features/P68I-integrace-2026-10-31` po sloučení
  `origin/main` `457820eb` (port 3180). Prahy jsou z `gates.json`, zmrazené v T1.
- Surová čísla: `result.json`; přepočet a kontrola tohoto souboru: `__tests__/result.test.ts`.

## Hry

| Hra | Kategorie | Zapojená | G1 směrování (≥ 12/15) | G2 hratelnost (≥ 12/15) | G3 FPS telefon | G4 čas | G5 determinismus | Verdikt |
|---|---|---|---|---|---|---|---|---|
| `stunt` | vozidla-sport | ne (R14) | 0/15 ✗ | 0/15 ✗ | 59,9 FPS, p95 33,4 ms ✓ | neměřeno ✗ | ✓ | **nesplněno** |
| `minigolf` | vozidla-sport | ano (R12) | 10/15 ✗ | 10/15 ✗ | 59,9 FPS, p95 16,8 ms ✓ | ✓ | ✓ | **nesplněno** |
| `railfps` | prvni-osoba | ano (T10, R9) | 4/15 ✗ | 4/15 ✗ | 59,9 FPS, p95 16,8 ms ✓ | ✓ | ✓ | **nesplněno** |
| `buildshift` | stavba | ne (R13) | 0/15 ✗ | 0/15 ✗ | 59,9 FPS, p95 33,4 ms ✓ | neměřeno ✗ | ✓ | **nesplněno** |
| `drawsave` | stavba | ano (T12, R7) | 10/15 ✗ | 10/15 ✗ | 59,9 FPS, p95 16,7 ms ✓ | ✓ | ✓ | **nesplněno** |

## Kategorie

| Kategorie | Hry | Verdikt | Důvod |
|---|---|---|---|
| `vozidla-sport` | `stunt`, `minigolf` | **nesplněno** | `stunt` nezapojený (čas do hratelnosti: desktop +528 ms, telefon +2 940 ms proti `main`, mez +200 ms); `minigolf` jen 10 z 15 vět ve své hře |
| `prvni-osoba` | `railfps` | **nesplněno** | rychlá hra dá `railfps` jen 4 z 15 vět – věty o jízdě (gondola, vlak, vozík) bere `voyage` |
| `stavba` | `buildshift`, `drawsave` | **nesplněno** | `buildshift` nezapojený (telefon +505 ms proti `main`); `drawsave` jen 10 z 15 vět ve své hře |
