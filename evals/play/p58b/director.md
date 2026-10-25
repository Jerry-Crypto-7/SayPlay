# P58B T7 – režisér AI verze: astra přes OpenAI API

Čísla: `director.json`. Měřeno 24.–25. 10. z lokálního PC proti OpenAI API, `gpt-6-astra` s úsilím `low`, strop výstupu 8 000 tokenů, čtečka AI verze astra `low`. Předplatné režisér nepoužil; Codex přes předplatné jen soudil obrázky.

## Doporučení pro P59

- **Astra jako režisér AI verze funguje.** 12 z 12 AI verzí prošlo robotem (hra je vyhratelná). Věrnost větě 0,92 proti 0,88 u rychlé verze. Slepý soudce dal přednost AI verzi u 6 vět, rychlé u 4, 2 remízy.
- **Cena 0,62–0,67 USD za jednu AI verzi.** Strop 100 USD měsíčně tedy pokryje asi 150 AI verzí, tedy zhruba 5 denně. Veřejné demo proto musí mít tvrdý strop útraty; P59 ať ověří, jestli `WORLDSMITH_SPEND_CAP_USD` platí na den, nebo na celou dobu provozu.
- **Největší páka na cenu je schéma odpovědi režiséra.** Samo má ~32 000 vstupních tokenů a první volání každé AI verze stojí ~0,39 USD, z toho ~0,32 USD jen za schéma. Čtečka už žánr zná, takže stačí poslat jen jeho část. *Odhad, neměřeno:* cena za hru by klesla na zlomek a do 100 USD by se vešlo několikrát víc her.
- **Hráč čeká na AI verzi p50 57 s, p95 93 s** (od odeslání věty po první hratelný snímek v prohlížeči). Rychlou verzi mezitím hraje: ta je hratelná p50 za 1,4 s.
- **Úsilí nechat `low`** (výchozí v produkci). Na `medium` se ve zkušebním běhu jedna ze dvou vět usekla na 8 000 výstupních tokenech a věta stála ~0,74 USD.

## Výsledek

| | AI verze (astra) | rychlá verze |
|---|---|---|
| prošlo robotem | 12/12 | – |
| věrnost: položky ve specu (inSpec) | 0,972 | 0,924 |
| věrnost: přečteno (read) | 0,924 | 0,875 |
| věrnost: vykresleno (drawn) | 0,924 | 0,875 |
| věrnost: role | 0,896 | 0,847 |
| slepý soud „která víc odpovídá větě“ | 6 výher | 4 výhry (2 remízy, podíl AI 0,58) |
| první hratelný snímek p50 / p95 | 57 s / 93 s | 1,4 s / 7,9 s |
| cena za hru | 0,62 USD (čistá dávka 2), 0,665 USD průměr všech 15 pokusů | 0 |

- **Slepý soud:** `pairwise --question match`, soudce vidí dva klipy průběhu vedle sebe v prázdném adresáři, strany losuje `pure-rand` (semínko 45045). AI verze vyhrála u s037, s008, s021, s058, s088, s095; rychlá u s035, s039, s069, s111; remíza s050, s003.
- **Kde AI verze vyhrála:** sedí prostředí věty – láva u „obby with lava“ (rychlá verze má písek a vodu), ruiny u „temple run“, krabice a kočičí prak u „Angry Birds“.
- **Kde prohrála:** rychlá verze měla zřetelnější hlavní akci – blížící se zombie u s039, rostoucí vír u s111, trubky jako ve Flappy Bird u s035.

## Sada

Prvních 30 vět dev (originály `corpus.json`):

- **10 je řetěz mikroher** (s002, s006, s022, s056, h01, h03, h06, h07, h08, h10). AI verzi z podstaty nemají: POST odpoví bez `upgrade`, režisér se nevolá. Ověřeno na serveru bez modelu, nic se neplatilo.
- **12 změřeno:** s039, s037, s035, s050 (dávka 1) a s003, s008, s021, s088, s069, s058, s111, s095 (dávka 2).
- **8 nezměřeno kvůli rozpočtu** (s188, s144, s155, s099, h02, h04, h05, h09). Strop T7 je 15 USD a dávka 1 ztratila tři zaplacené věty kvůli chybě měřidla (níže). Další dvě nebo tři věty by se vešly jen těsně a cenu ani doporučení by nezměnily.

## Průběh a nálezy

- **Chyba produktu, opravená (`9fe4a172`):** astra jako režisér přes OpenAI API dosud nikdy neprošla. Každé volání vrátilo 400, protože schéma odpovědi mělo ~2 200 povolených hodnot a striktní režim OpenAI jich přijme nejvýš 1 000. Placená záloha režiséra tak v produkci neběžela. Sdílené definice snížily počet na 200.
- **Chyba měřidla, opravená (`1d6f0c9f`):** dávka 1 (10 vět, 5,00 USD) započítala tři řetězy mikroher jako selhání modelu a tři zaplacené věty ztratila na „fetch failed“ uprostřed čekání na AI verzi. Měřidlo teď dotaz GET po síťové chybě zopakuje (POST nikdy, aby nerozběhl další placený pokus) a řetězy počítá zvlášť. V dávce 2 prošly všechny tři ztracené věty.
- **Sloučení dávek:** dávky běžely na dvou buildech, které se liší jen měřidlem (`scripts/`), kód serveru je stejný. Z dávky 1 vstupují jen 4 publikované věty, výpočet je přes `compareSummary` a `specFidelity` z měřidla.
- **Pozorováno, nezkoumáno:** v dávce 1 se stránka řetězu mikroher s022 nenačetla do 30 s a s006 se načítala 10,7 s, zatímco server dokončoval AI verzi jiné věty. P59 ať změří, jestli dokončování AI verze nezdržuje ostatní hráče na téže instanci.

## Útrata T7

| | USD |
|---|---|
| zkušební běhy (`medium`, předchozí sezení, horní mez) | 1,90 |
| dávka 1 (10 vět, strop 6,05) | 5,00 |
| dávka 2 (8 vět, strop 7) | 4,97 |
| čtečka (15 čtení × 0,027, odhad z T3) | 0,41 |
| **celkem** | **12,29** |

Ceny jsou horní mez: slevu OpenAI za cache měřidlo nevidí.

## Výhrady (odvozeno)

- 12 vět je málo. Poměr 6 : 4 ve slepém soudu je náznak, ne důkaz, že AI verze odpovídá větě líp.
- Věrnost se počítá ze specu hry, ne z obrazu; obraz hodnotí jen slepý soudce.
- Časy platí z lokálního PC. Ze serveru na Vercelu je změří P59.
