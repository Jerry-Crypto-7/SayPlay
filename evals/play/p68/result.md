# P68 – výsledek na zapečetěném holdoutu (T15, 3. 11. 2026)

**Žádná z pěti nových her cíl P68 nesplnila, a proto nesplnila ani žádná kategorie.** Hry, které jsou zapojené
(`minigolf`, `railfps`, `drawsave`), se hrají dobře: každá věta, kterou rychlá hra pošle do správné hry, je hratelná,
na telefonu běží 60 FPS a hra je hratelná dřív než na `main`. Zastavilo je až směrování: rychlá hra pošle do
správné hry jen 10, 4 a 10 z 15 vět, práh je 12. `stunt` a `buildshift` zůstaly za branou aktivace, protože ani po
dvou kolech oprav kategorie nesplnily čas do hratelnosti (R13, R14), takže je rychlá hra nenabídne vůbec.

Druhotná kvalita (G6) verdikt nemění, a sama by také neprošla: slepý soudce dává novým větám vyšší věrnost
(medián 0,20 proti 0,15 na `main`), ale „hrál bych“ nižší (0,25 proti 0,30, práh je `main` + 0,10). AI verze (G7)
proběhla jen na 2 z 14 vět vzorku, pak poskytovatel modelu odmítal volání (429).

## Jak se měřilo

- Holdout: 105 vět (15 na každou novou hru, 30 obecných přes 24 starých žánrů), otevřený jednou 3. 11. v 10:11 UTC
  (`holdout-opened.json`, otisk `f24fadb0…` sedí s `seal.ts`). Na holdoutu se nic neladilo.
- Strany: `main` = `688d989d` (stav před P68, port 3181), větev = `features/P68I-integrace-2026-10-31` po sloučení
  `origin/main` `457820eb` (port 3180). Prahy jsou z `gates.json`, zmrazené v T1.
- Surová čísla: `result.json`; přepočet a kontrola tohoto souboru: `__tests__/result.test.ts`.

## Hry

| Hra | Kategorie | Zapojená | G1 směrování (≥ 12/15) | G2 hratelnost (≥ 12/15) | G3 FPS telefon | G4 čas | G5 determinismus | G6 „hrál bych“ (druhotná) | G7 AI verze (bez prahu) | Verdikt |
|---|---|---|---|---|---|---|---|---|---|---|
| `stunt` | vozidla-sport | ne (R14) | 0/15 ✗ | 0/15 ✗ | 59,9 FPS, p95 33,4 ms ✓ | neměřeno ✗ | ✓ | 0,25 / `main` 0,25 ✗ | neměřeno (režisér ji nenabízí) | **nesplněno** |
| `minigolf` | vozidla-sport | ano (R12) | 10/15 ✗ | 10/15 ✗ | 59,9 FPS, p95 16,8 ms ✓ | ✓ | ✓ | 0,35 / `main` 0,30 ✗ | 1 ze 2: AI verze `minigolf`, 61 s; 1 neměřena (429) | **nesplněno** |
| `railfps` | prvni-osoba | ano (T10, R9) | 4/15 ✗ | 4/15 ✗ | 59,9 FPS, p95 16,8 ms ✓ | ✓ | ✓ | 0,25 / `main` 0,25 ✗ | 0 ze 2: řetěz mikroher bez AI verze, 1 neměřena (429) | **nesplněno** |
| `buildshift` | stavba | ne (R13) | 0/15 ✗ | 0/15 ✗ | 59,9 FPS, p95 33,4 ms ✓ | neměřeno ✗ | ✓ | 0,22 / `main` 0,25 ✗ | neměřeno (režisér ji nenabízí) | **nesplněno** |
| `drawsave` | stavba | ano (T12, R7) | 10/15 ✗ | 10/15 ✗ | 59,9 FPS, p95 16,7 ms ✓ | ✓ | ✓ | 0,20 / `main` 0,30 ✗ | 0 ze 2: obě neměřené (429) | **nesplněno** |

## Kategorie

| Kategorie | Hry | Verdikt | Důvod |
|---|---|---|---|
| `vozidla-sport` | `stunt`, `minigolf` | **nesplněno** | `stunt` nezapojený (čas do hratelnosti: desktop +528 ms, telefon +2 940 ms proti `main`, mez +200 ms); `minigolf` jen 10 z 15 vět ve své hře |
| `prvni-osoba` | `railfps` | **nesplněno** | rychlá hra dá `railfps` jen 4 z 15 vět – věty o jízdě (gondola, vlak, vozík) bere `voyage` |
| `stavba` | `buildshift`, `drawsave` | **nesplněno** | `buildshift` nezapojený (telefon +505 ms proti `main`); `drawsave` jen 10 z 15 vět ve své hře |

## G6 kvalita (druhotná, verdikt nemění)

Slepý soudce `claude -p` na listech z telefonu (obě strany na jednom listu, pořadí ze semínka 68016), 105 ze 105 listů
s platnou odpovědí. Mediány hry, kterou hráč dostane:

| Sada | „Hrál bych“ větev / `main` | Práh | Věrnost větev / `main` | Práh | Výsledek |
|---|---|---|---|---|---|
| nové věty (75) | 0,25 / 0,30 | ≥ `main` + 0,10 | 0,20 / 0,15 | ≥ `main` − 0,02 | ✗ („hrál bych“) |
| obecné věty (30) | 0,30 / 0,30 | ≥ `main` − 0,02 | 0,30 / 0,30 | ≥ `main` − 0,02 | ✓ |
| všech 105 | 0,28 / 0,30 | – | 0,25 / 0,18 | ≥ `main` − 0,02 | věrnost ✓ |

Po hrách (15 vět, věrnost větev / `main`): `stunt` 0,20 / 0,20, `minigolf` 0,30 / 0,15, `railfps` 0,25 / 0,15,
`buildshift` 0,15 / 0,15, `drawsave` 0,25 / 0,10. Nové hry tedy víc odpovídají větě, ale soudce by je nehrál raději
než staré žánry; u `drawsave` „hrál bych“ klesl o 0,10. Surové odpovědi: `judge-holdout.json`.

## G7 AI verze (zapsaná, bez prahu)

Vzorek 14 vět (2 na hru + 4 obecné), astra jako čtečka i režisér přes měřicí knihu (strop 7 USD). Změřené 2 věty:

- `p68-016` (minigolf): AI verze vznikla a zůstala `minigolf`, hotová za 61 s.
- `p68-031` (railfps): rychlá hra poslala větu do `platformer`, ten jde do řetězu mikroher a AI verze se nestaví.
- Od `p68-061` odpovídal poskytovatel modelu na každé volání režiséra 429 („rate limited or out of credit“); 12 vět
  vzorku je neměřených, `stunt` a `buildshift` režisér nenabízí vůbec.
- Útrata 0,72 USD, kniha celkem 5,27 ze 7 USD.

## Hybrid

Z `hybrid/decision.json` (T14, 2. 11.): **`off`**. Skript úrovně (QuickJS) v době tvorby se nezapíná: slepý soudce
se skriptem neběžel, prodloužení AI verze a útrata nejsou naměřené.

## Celkově

Zelené. E2E zapojených her (`play-minigolf`, `play-railfps`, `play-drawsave` na desktopu i obou telefonech),
`play-share`, `interface-language` a VR (`vr-enter`, `vr-diorama`, `vr-native`, `vr-hud`) proti sestavě větve:
první běh 91 ✓ / 4 ✗ při souběžném focení, ty 4 (3× `interface-language`, FPS `play-drawsave` na desktopu)
v klidu 10/10 ✓, takže regrese není. Uložené hry drží G5 (`p66-hash`, `hash-v6` na uložených hrách `genre.v6`)
a `play-share`. `stunt` a `buildshift` nemají e2e, protože nejsou zapojené.

## Co z toho plyne

- Hry samotné fungují; chybí jim cesta od věty. Další krok je směrování rychlé hry na nové hry (u `railfps` věty
  o jízdě, které bere `voyage`), ne další práce na hrách.
- `stunt` a `buildshift` potřebují zrychlit tvorbu na telefonu (+2 940 ms a +505 ms proti `main`), jinak zůstanou
  za branou.
- Čas: slib „2 s“ data dokládají jen na desktopu u zapojených her (medián 1,76–1,96 s). Emulovaný telefon
  (`pixel7-cpu4`, procesor zpomalený 4×) má 5,1–5,8 s, o 1,0–3,7 s méně než `main`.
