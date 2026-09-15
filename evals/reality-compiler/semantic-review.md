# T11 — předání skutečnému hodnotiteli

Nové návrhy z druhé implementační session používají **evidence-v2**: vlastní odkazy pro trigger, každý uzel podmínky (včetně allOf/anyOf/not) a každou akci. Otisk kontroluje vazbu na skutečnou deklaraci. Why i návrh před potvrzením ukazují tyto skupiny; nezávislý hodnotitel musí posoudit význam každé, nikoli jen shodu úryvku s byte spanem. Podpora timer intervence se mění jen u skutečné startTimer akce. Historické v1 archivy a jejich pravidlové review se nepřepisují a UI přiznává jejich menší podrobnost.

`user-supplement` je samostatné uživatelské doplnění s vlastními citacemi a nezměněným původním zdrojem. Sourced zde znamená citaci konkrétního dokumentu, nikoli nezávislou pravdu; doplnění se nesmí započítat jako tvrzení původního zdroje. Potvrzení parametrů nemění unchecked. HTML textarea normalizuje vložené CRLF na LF ještě před odesláním; aplikace zachovává skutečně přijaté source bytes, HTTP/úložná cesta podporuje i CRLF a BOM bez normalizace.

Aktualizace 9. 9.: nové potvrzení sedmi parametrů v aplikaci je pouze acknowledgement uživatele. Nemění `review.status`, nevyplňuje tento formulář a nepřepisuje historické FAIL. Lokální obnova znovu validuje a přehraje deklarovaný program; ani ona nepotvrzuje věrnost modelu zdroji. Při review rozlišit původní pravidlo a jeho podmínky/akce, tvrzené citace a explicitní změnu timeru. U kapacity timeru zvlášť ověřit, zda zdroj skutečně určuje i dobu jeho spuštění. Nová nezávislá série a její protokol jsou otevřené v `holdout-v2/README.md`.

Stav: **NOT_RUN**. Tento návod ani prázdný formulář nejsou lidské hodnocení. Hodnotitel má být nezávislý na implementaci a má posuzovat skutečné výstupy všech 30 párů, včetně neúspěchů.

## Podklady a pracovní kopie

Použij dokončený archiv `runs/0143dcc9-ea30-4519-ada3-b47ff02bdf5b/`: `run.json`, `journal.jsonl`, modelový journal `subscription.jsonl` a obrázky `pair-<index>-create.png` / `pair-<index>-edit.png`. Požadavky a citované úseky jsou v `holdout-v1/oracle.json`; původní zdroje a předepsaná upřesnění v `holdout-v1/suite.json`. Opakování posuzuj samostatně.

V kořeni projektu vytvoř pracovní kopii formuláře. Příkaz odmítne přepsat existující práci:

```powershell
$reviewArchive = 'evals/reality-compiler/runs/0143dcc9-ea30-4519-ada3-b47ff02bdf5b'
$reviewWorking = 'evals/reality-compiler/semantic-review.working.json'
if (Test-Path -LiteralPath $reviewWorking) { throw 'Pracovní review už existuje.' }
Copy-Item -LiteralPath "$reviewArchive/review.template.json" -Destination $reviewWorking
```

Archivovaná šablona předchází doplnění pole `otherCitations`. Do každého hodnoceného řádku doplň `"otherCitations": null` a po kontrole jej nahraď skutečnými počty. Původní archiv neupravuj. Nově vytvářené šablony už pole obsahují.

## Co vyplnit u každého páru

- `reviewer` a `reviewedAt`: skutečný hodnotitel a čas v ISO UTC. Prázdné nebo pouze mezerové jméno nepřidělí hodnocení.
- `criticalSupported`: zda mají všechna kritická tvrzení a chování oporu ve zdroji. Správný výsledek jedné simulace tuto kontrolu nenahrazuje.
- `criticalCitations`: zda kritické citace skutečně podporují přiřazená tvrzení, nejen zda odpovídají bajtové rozsahy.
- `otherCitations`: objekt s počty `passed` a `total` všech kontrolovaných nekritických citací. Vyhodnoť celý soubor těchto citací, ne výběr příznivých. Platí celá nezáporná čísla a `passed <= total`. Neprovedená kontrola je `null`; pokud žádné takové citace nejsou, zapiš oba počty 0 a důvod do poznámky.
- `clarificationCorrect`: u neúplného či konfliktního podkladu správnost skutečně položené otázky. U úplného podkladu ponech `null`. Zaznamenaných devět přijetí bez požadovaného upřesnění zůstává FAIL i po review.
- `atoms[].met`: samostatně splnění každého pojmenovaného požadavku oraclu; `unsupportedAtomicCount`: počet dalších nepodložených atomických tvrzení nebo chování, nikoli počet JSON pravidel.
- `visualUsable`: skutečné vizuální posouzení archivovaných snímků; chybějící nebo nedostatečný podklad znamená `null`.
- `notes`: odůvodnění chyb a nejistot s konkrétními ID tvrzení/pravidel nebo citacemi. Nejistota zůstává `null`, není automaticky úspěchem.

Identitu běhu, hashe, indexy a ID neměň. Již zaznamenané počty citací se dalším aplikováním review nepřepisují; případnou opravu vyhodnoť jako novou doloženou revizi proti původnímu `run.json` a předchozí review zachovej.

## Vyhodnocení po skutečné kontrole

```powershell
$env:RC_RUN_FILE = 'evals/reality-compiler/runs/0143dcc9-ea30-4519-ada3-b47ff02bdf5b/run.json'
$env:RC_REVIEW_FILE = 'evals/reality-compiler/semantic-review.working.json'
npm run evaluate:reality-compiler
Remove-Item Env:RC_RUN_FILE, Env:RC_REVIEW_FILE
```

Příkaz nevolá model. Uloží novou revizi pod `evals/reality-compiler/reviews/`; původní běh a benchmarkový report zachová. Současně vyhodnotí aktuální `user-study.json`. Bez pěti skutečných pozorování zůstanou lidské brány NOT_RUN. Negativní technické výsledky se review nemažou a T12 zůstává rozhodnutím ZÚŽIT.
