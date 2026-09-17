# P20 — balíček pro lidské hodnocení (připraveno, nespuštěno)

## Spustitelný offline postup

Z kořene repozitáře spusť níže uvedený opt-in Vitest runner. Vyžaduje explicitní JSON studijního manifestu a **nový, dosud neexistující výstupní adresář**; jeho nadřazená složka musí existovat. Příklad s prázdnou šablonou ověřuje pouze pracovní postup a musí vypsat **INVALID**. Nepřidávej fiktivní lidi nebo odpovědi, aby vyšel zelený gate.

```powershell
$env:P20_HUMAN_INPUT='evals/worldstream/world-quality/human-review.template.json'
$env:P20_HUMAN_OUTPUT='plans/P20/human-review-template-check-UNIQUE'
npx vitest run --config vitest.measure.mts evals/worldstream/world-quality/human-review.measure.ts
Remove-Item Env:P20_HUMAN_INPUT,Env:P20_HUMAN_OUTPUT
```

Pro skutečný sběr změň vstup na vlastní explicitní archivovaný studijní JSON a zvol nový výstup pro každou agregaci. Runner nic nevyhledává, neotevírá `source.ref`, nevolá síť/model/provider a nemění původní vstup ani staré výsledky. Limit je 2 MiB, 1000 položek jedné kolekce a 50000 celkových hodnot. Nadlimitní soubor nebo existující výstup runner odmítne; chybné JSON/schema/vazby reportuje jako INVALID.

Výstup obsahuje byte-for-byte `input.json`, `summary.json` s SHA256 původních vstupních bytů, časem agregace, nulovými model/network calls, přesnými jmenovateli a rozhodnutími, a čitelný `report.md`. Ověření obsahu odkazovaných důkazů a nezávislosti lidí zůstává operátorovi; hash vstupu není takovým ověřením.

- **INVALID:** poškozený formát nebo rozporné údaje.
- **PENDING:** chybějící nutné odpovědi či důkazy.
- **FAIL:** vyhodnocený práh nebyl splněn; jiné gates mohou dál čekat.
- **PASS:** agregované zaznamenané prahy splněny, stále podmíněno ověřením pravosti evidence.

Celkový stav má prioritu INVALID → FAIL → PENDING → PASS; jednotlivé gates se zachovají samostatně. Zelené dokončení Vitest runneru znamená vytvořený report, **nikoli PASS lidské studie**. Prázdná šablona zůstává INVALID; syntetický manifest s platnými metadaty bez hlasů je PENDING. Lokální unit testy těchto stavů nejsou účastníci ani výsledky studie.

Technické ověření 17. 9. 2026: 10/10 cílených testů runneru a agregátoru, typecheck PASS. Skutečný offline příkaz nad nezměněnou prázdnou šablonou vytvořil [INVALID report](../../../plans/P20/human-review-template-check-20260917-1910/report.md) a [strojový souhrn s hashem](../../../plans/P20/human-review-template-check-20260917-1910/summary.json). Počet získaných lidských odpovědí: **0**. Tento smoke není studie.

## Převzetí odpovědí — agregátor připraven, žádná studie neproběhla

`human-review.ts` exportuje strict `humanSubmissionSchema` a čistou funkci `aggregateHumanReview(input)`. Prázdná `human-review.template.json` má nevyplněné run/build/dataset údaje a žádné odpovědi; vrací INVALID, nikdy PASS. Vyplněný manifest bez hlasů vrací PENDING. Šest syntetických unit fixtures v `human-review.test.ts` je výhradně test kódu, nikoli lidské evidence.

Před sběrem zafixovat runId, hash buildu/datasetu, roster tří nezávislých G-V a pěti G-W/A4 účastníků, celou sadu párových porovnání a randomizované pořadí. Nepřidávat ani nevybírat úspěšné páry po zhlédnutí výsledků. G-W nemá v protocol.json počet párů; jmenovatel je pět hlasů × všechny předem určené páry, které se musí archivovat kompletně. Odpovědi vázat na participant/world či participant/pair. Každý jednotlivý záznam odpovědi má vlastní archivovaný `source.ref` a SHA256; neodkazovat všechny hlasy na jeden agregovaný soubor. Anonymní ID má být stabilní, nikoli jméno nebo e-mail.

G-V se mapuje na zamknuté IDs development/holdout a přesný seznam požadavků z původního korpusu. Tři kompletní lidské hlasy: většina pro místo i každý požadavek. Rejected generace je FAIL ve jmenovateli 10+20; missing obraz/hlas nebo unknown úsudek je PENDING. Thresholdy z protocol.json zůstávají 8/10 + 16/20. Chybějící nebo nadpočetné požadavky, neznámé ID, duplikované hlasy, účastníci a opakované zdroje jsou INVALID.

G-W vyžaduje pět overall ratingů, alespoň čtyři ≥4/5 a alespoň 80 % nových podob ze všech předem určených párových voleb; tie zůstává ve jmenovateli. Pár musí mít stejné blueprint/camera hashes a viewport, oba zdroje a 20s průlet plus zdroj randomizace. A4 vyžaduje pět záznamů s vlastním promptem, zvlášť generationMs, chronologické milestone časy od připraveného světa, pomoc, dokončení a posouzení porozumění doložené doslovnou odpovědí. Nejméně tři bez pomoci dokončí a pochopí rozdíl do 180 s včetně. Missing údaje nelze doplnit odhadem.

Agregátor kontroluje strukturu a vazby, nikoli pravost lidské identity nebo obsah souboru za SHA256. Oprávněný operátor musí před přejímkou ověřit skutečný archiv, shodu hashů, nezávislost lidí, slepý first pass a randomizaci; samotné vložení textu „human“ tuto evidenci nevytváří. Žádný modelový soud nenahrazuje hodnotitele. Tento soubor nikoho nekontaktuje ani neodesílá data.

Autorita: `protocol.json` a zamknuté development/holdout/a4-cases. Prahy ani jmenovatele se nemění. Žádný údaj níže není vyplněná odpověď účastníka.

## Karta G-V (tři nezávislí hodnotitelé)

- Anonymní ID hodnotitele, verze/build/hash datasetu, anonymní ID scény, pořadí prezentace.
- Bez názvu a promptu: „Jaké místo vidíte? Vypište objekty a jejich počet.“ Odpověď doslova.
- Po odhalení promptu: pro každý původní požadavek přítomnost, počet, materiál, vztah, funkce: ano/ne/nelze určit. Nepřebírat seznam požadavků výhradně z modelového plánu.
- Uložit komentář i nesouhlas. Rozpoznání místa a všech hlavních požadavků vyhodnotí většina ze tří. Chybějící snímek a odmítnutá generace zůstává ve jmenovateli 10+20.

## Karta G-W (pět hodnotitelů)

Stejný blueprint, rozlišení, kamera a dvacetisekundový průlet, anonymně randomizované A/B pořadí. Zapsat preference A/B/stejné, kvalitu 1–5 podle protocol.json, čitelnost, proporce, ukotvení a důvod. Modelový reviewer nenahrazuje člověka.

## Karta A4 (pět cizích lidí)

1. Účastník zadá vlastní místo. Zapsat čas od promptu do připraveného světa zvlášť.
2. Bez vysvětlování ovládání: „Vyzkoušejte svět. Změňte, co se stane po jedné z vašich akcí, a porovnejte výsledky.“
3. Od připraveného světa měřit první akci, nalezení času, návrat, návrh změny, náhled, potvrzení, rozpoznání rozdílu. Limit 180 s; zaznamenat veškerou pomoc.
4. Zeptat se: „Co bylo stejné a co jiné? Vytvořil systém dvě nové scény, nebo přehrál vaše akce?“ Odpověď doslova, bez opravy.
5. Zapsat úspěch bez pomoci, chyby, vzdání, zařízení a browser. Cíl 3/5 nenahrazovat testovacím skriptem.

## Chybějící vstupy

Tři nezávislí vizuální hodnotitelé, pět cizích testerů, konečná verze 30 nových generací a 10 živých změn, cílový notebook. Materiály T04 jsou kalibrace; A4 browser fixture je technický důkaz. Ani jedno se nevydává za hotovou studii.
