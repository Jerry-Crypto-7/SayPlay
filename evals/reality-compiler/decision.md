# T12 — rozhodnutí podle evidence, 8. 9. 2026

**Verdikt: ZÚŽIT pilot na explicitně úplné krátké prostorové procedury a vlastní lokální demo přes předplatné Codexu. Přínos 3D pro člověka je INCONCLUSIVE. Rozšiřování na další typy zdrojů se neotevírá.**

Tento verdikt není PASS T11. Úspěšný runtime a několik generací nedokazují správnost všech kritických pravidel ani přínos 3D pro člověka. Chybějící lidská pozorování zůstávají NOT_RUN. Nejde o souhlas s veřejným nasazením prostřednictvím osobního účtu.

## Konečné měření

Konečná série 0143dcc9-ea30-4519-ada3-b47ff02bdf5b dokončila 30/30 párů, 36/36 CLI volání, bez timeoutu a bez stop reason. Invarianty, očekávané rozdíly větví a zachování stavu při odmítnutí prošly ve všech 30 párech. H06–H08 ve všech třech opakováních nevyžádaly upřesnění: 9 doložených selhání z 15 problematických párů, brána FAIL. Zbývajících šest vyžádalo upřesnění, správnost jeho obsahu čeká na lidské review. Vytvoření: medián 126,22 s / p95 180,43 s (FAIL proti 30/60 s); změna: medián 2,42 s / p95 3,73 s (PASS proti p95 8 s).

## Doložené skutečnosti a jejich meze

- T1–T10 mají implementaci a cílené regresní ověření. Dva čerstvé vývojové source průchody vytvořily svět a skutečný rozdíl větví; modelové časy 85,5 a 93,6 s jsou jednotlivá pozorování, nikoli p95.
- Skutečný holdout je měřen samostatně přes oficiální CLI. Aktuální autoritativní výsledky včetně všech jmenovatelů a stop reason jsou v [subscription-report.md](subscription-report.md); neuplatňuje se výběr pouze úspěšných případů. Archivy neúplných předchozích sérií da0ea707 a f768e40f zůstávají zachovány. Ve druhé sérii H01–H03 prošly vytvořením, shodou invariantů a očekávaným párovým výsledkem; další generování zastavila kontrola přihlášení před inferencí H04.
- První tři modelové časy druhé série byly 131,1 / 134,8 / 124,9 s. To jsou konkrétní protipříklady slibu rychlé generace; samotný neúplný vzorek nezavírá formální p95 bránu. Pravidlo protokolu 30 s medián / 60 s p95 se nemění.
- Evidence zůstává sémanticky unchecked, dokud skutečný hodnotitel nepřezkoumá atomické požadavky a citace. Automatická kontrola hashů, bajtových rozsahů a několika stavových důsledků ji nenahrazuje.
- Konkrétní důvod zúžení: v aktuální sérii `0143dcc9-ea30-4519-ada3-b47ff02bdf5b` H06, H07 a H08 v prvním opakování vrátily rovnou `proposed`, bez upřesnění vyžadovaného předem uzamčeným protokolem. `problematicBlocked` je u nich false, tedy brána FAIL; konečná série potvrdila stejný výsledek ve všech třech opakováních. Zdroje uvádějí kapacitu timeru, ale vynechávají samostatnou délku jeho spuštění; zda konkrétní kapacitní věta poskytuje dostatečnou sémantickou oporu, musí rozsoudit přiznané lidské review. Správný výsledek předpokládaného časování nezachraňuje selhání požadovaného zastavení. H09 naopak v prvním opakování skutečně zastavil kvůli konfliktu a pokračoval až po upřesnění; správnost formulace konfliktu stále podléhá review.
- Pět účastníků nebylo doloženo. Není prokázáno, zda prostor pomáhá oproti textu/tabulce, ani zda účastníci rozlišují zdroj, intervenci a simulovaný výsledek.
- Předplatné má zaznamenanou usage a limit volání. Jednotková cena v USD není doložena, cenová brána je NOT_RUN. Historický API tarif se na tyto tokeny nepoužívá.

## Rozhodnutí proti tabulce bran

Zachovat jediný runtime, evidence sidecar, kontrolu atomického přijetí a compare. Nepřidávat URL/PDF ingest, NPC, hlas, fyziku ani další infrastrukturu. Pro vlastní demo používat konkrétní úplné krátké podklady a transparentně připustit čekání, upřesnění i odmítnutí. Před rozšířením doplnit explicitní potvrzení kritických parametrů nebo formulář, který je vyžaduje; současné UI tuto novou podmínku ještě nevynucuje. Tento dokument rozhoduje o dalším kroku, neprohlašuje jej za implementovaný. Staré marketingové skóre ani prahy se nezvyšují.

Pokud aktuální měření zachytí porušení kritického invariantu, příslušný případ blokuje rozšíření a veřejný release a musí se reprodukovat a opravit. Slabá latence nebo extrakce vyžaduje samostatně verzovaný další experiment; tento holdout se nesmí upravit a pak znovu vydávat za nepoužitý.

## Další falsifikovatelný krok

Dokončit chybějící sběr proti uzamčenému protokolu, získat přiřazené sémantické review a skutečných pět pozorování s prohozeným pořadím 3D a textu. Hodnotit ≥27/30 dokončených párů, pravidlovou precision/recall ≥0,95, všechny kritické invarianty, ≥4 samostatná správná dokončení a ≥3 konkrétní ověřené prostorové přínosy. Uvést i případ, kdy text vyjde lépe. Další model/prompt nebo kompaktnější pipeline vyžaduje novou označenou sérii a zachování všech neúspěchů.

T12 je uzavřeno rozhodnutím ZÚŽIT s nevyřešeným lidským signálem; samotný lidský důkaz T11 zůstává otevřený. Předání zvolené varianty je v [submission-readiness.md](submission-readiness.md).
