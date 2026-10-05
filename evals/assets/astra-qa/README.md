# Kontrola knihovny modelů astrou (P30D)

Jednorázový vizuální verdikt ke každému modelu z `src/assets/catalog.json`: co na něm hráč pozná, jestli sedí jméno, štítky a měřítko, a jestli je model tak slabý, že patří k výměně. Kontrola není součást produktu a její výstupy **nikdy** nejdou do trénovacích dat (podmínky OpenAI; `scripts/assets/qa-astra.mjs` zápis pod `evals/play/train/` odmítne).

## Jak vzniká

1. `node scripts/assets/qa-sheets.mjs` vyrenderuje pro každý model list 1024×1024 do `D:/caches/p30d/sheets/` (mimo repo): zepředu, z boku, shora a ¾ pohled s kostkou 1 m, rozměry v metrech v rohu. Naměřeno 29. 9. 2026: 783/783 listů, 0 selhání.
2. `node scripts/assets/qa-astra.mjs --limit 20 --cap-usd 3` (pilot), pak `--cap-usd 80` (celá knihovna). Pošle list a záznam katalogu a zapíše sem `<assetId>.json` s verdiktem, tokeny a cenou volání. Klíč, adresa a ceny jdou z `.env.local` (`WORLDSMITH_FALLBACK_*`), nikdy do repa ani do logu.

## Strop útraty

`spend.json` drží součet útraty napříč běhy. Běh skončí **před** voláním, které by mohlo strop přelézt: počítá s nejhorším případem volání (strop vstupních tokenů × cena vstupu + strop výstupu × cena výstupu), a když skutečné volání stojí víc, odhad se zvedne. Odpověď, která neodpovídá schématu, se zapíše jako `invalid` a útrata se započítá.

## Verdikt

| pole | význam |
|---|---|
| `recognizedAs` | co na listu pozná hráč |
| `matchesName` | sedí jméno v katalogu |
| `suggestedName`, `suggestedTags` | návrh oprav |
| `scaleOk` | je velikost v metrech věrohodná pro to, co model zobrazuje |
| `replace` | model je tak slabý, že patří k výměně (nemaže se, dostane štítek `qa:replace`) |

Pozor u `scaleOk`: arkáda model vepisuje do kvádru těla, (`FittedModel` v `src/components/play/arcade/ArcadeStage.tsx`), takže absolutní velikost v katalogu hru ovlivní jen tam, kde se model takhle neškáluje. Před opravou měřítka v T4 ověř, kde se katalogová velikost opravdu používá. Souhrn po celém běhu (P30D T3) se dopíše sem.
