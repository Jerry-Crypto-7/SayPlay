# P83E T5 – brána obchodu se součtem (zapečetěná sada, otevřená poprvé 10. 11. 2026)

**Výsledek: brána NEPROŠLA – neslučovat.** Směrování a robot splněné, počet věcí a slepý soud ne.

| Měřítko | Mez | Naměřeno | |
|---|---|---|---|
| Směrování do `shop` (rychlá verze, bez modelu) | ≥ 7/10 | **7/10** | ✅ |
| Robot vyhraje směrované hry (`verifyArcade`, semínko 1) | všechny | **7/7** (v prohlížeči taky 7/7, 0 chyb stránky) | ✅ |
| Počet věcí ve hře = počet z věty | všechny, kde ho věta říká | **0/1** (věta 1: „four items“ → 3 věci) | ❌ |
| Slepý soud: dělá, co věta popisuje, A ukazuje správný součet | ≥ 7/10 | **3/10** (součet správně 7/7, věta 3/7; nesměrované 3 = ne) | ❌ |

## Věta po větě (fakta)

| # | Věta (zkráceně) | Typ | Hra | Robot | Soud věta / součet |
|---|---|---|---|---|---|
| 1 | corner shop, cat picks up **four** items, till adds up the total | shop | 3 medvídci, $, prostředí „total“ | výhra | ne / ano – „věta chce čtyři věci, hra skončí po třech“ |
| 2 | kitchen, ingredients into the bowl, total of 12 spoons | shop | 6 věcí, číslo, cíl 12 | výhra | ne / ano – „sbírá očíslované věci, ne přísady do mísy“ |
| 3 | weights on the scale until exactly 25 kilos | shop | 6 závaží, kg, cíl 25 | výhra | **ano / ano** |
| 4 | library, books on the shelf by colour, count pages | sort | – | – | ne (nesměrováno) |
| 5 | post office, parcels on the scale, total weight | shop | 3 balíky, kg | výhra | **ano / ano** |
| 6 | pharmacy, **three** bottles on the counter, see the price | arena.collect | – | – | ne (nesměrováno) |
| 7 | toy store checkout, toys to the register, total | shop | 3 hračky, $ | výhra | **ano / ano** |
| 8 | vegetable market, vegetables in the basket, add up the cost | arena.collect | – | – | ne (nesměrováno) |
| 9 | dragon brings gems to the treasure scale, total **value** | shop | 3 drahokamy, **kg** | výhra | ne / ano – „počítá váhu v kg, ne hodnotu“ |
| 10 | school canteen, **food** on a tray, total cost | shop | 3 **medvídci**, $, prostředí „tray“ | výhra | ne / ano – „medvídci na pultu, ne jídlo na tácu“ |

## Proč (odvozeno z kódu, neověřeno opravou)

1. **Počet obecného podstatného jména se zahodí.** `countsOf` (`src/play/draft/draft.ts:1474`) páruje počet z věty se jménem věci. „items“ je obecné slovo, `shopItemOf` vrátí nic a věc dostane výchozí jméno „teddy bear“ – „four items“ se s „bear“ nespáruje a zůstane výchozí 3. Vývojová věta „three items“ prošla jen proto, že výchozí počet je taky 3.
2. **Jednotka: „scale“ přebije „value“** (věta 9) – `readShop` dá váhu, i když věta říká hodnotu.
3. **Nepočitatelná věc** („food“, věta 10) není množné číslo, `shopItemOf` ji nebere → medvídek.
4. **Prostředí bere místo položení nebo slovo součtu** („total“ u věty 1, „tray“, „scale“) místo obchodu z věty.
5. **Místo položení se nekreslí podle věty** – vždy pult (mísa, tác, košík ne); soud to u věty 2 a 10 vytkl.
6. **Směrování:** „see the price“ (6) a „add up how much they cost“ s košíkem (8) znak `tally` nezachytí; věta 4 (počítání stránek) skončí v `sort`.

## Jak měřeno

- Klasifikátor `classifyGenre` → `draftGameSpecWithMeta(věta, 1)` → `arcadeWorldOf` → `verifyArcade`; počet ve hře = `count` pravidla `shop_total`.
- Snímky: produkční build (`next build --webpack`, `next start` port 3215), spec z draftu publikovaný přes `/api/play/games`, desktop Chromium; robot ťuká myší přes `botWants` po ručních ticích. Tři snímky: start, po první věci, konec s kartou výsledku.
- Slepý soud: `codex exec` (effort high, bez webu), každá hra v prázdném dočasném adresáři jen jako `a.png`, `b.png`, `c.png` + zadání s větou; dvě otázky ano/ne (dělá hra, co věta popisuje; je ukázaný součet správný). 15–25 s na hru.
