# T10 — benchmark a účtování

Stav: runner a offline ověření dokončeny 8. 9. 2026. Skutečný cold a uživatelský důkaz nejsou provedeny. [Report](report.md) uvádí všechny cold brány jako NOT_RUN.

## Opakování offline kontroly

```sh
npm run measure:reality-compiler
```

Příkaz nečte konfiguraci modelu a nevolá provider. Nad skutečným loweringem a interpretem přehraje osm případů muzejního oraclu a změněný výsledek s limitem 10 sekund, třikrát. Jde o development fixture a Node replay, ne nový holdout, browserový frame nebo modelovou kvalitu. Úspěšné replaye jsou 3/3; cold completion z toho není PASS.

Každý běh založí vlastní `runs/<runId>/journal.jsonl` a `run.json`; poslední přehled je `report.md`. Opakovaný běh nikdy nepřepíše předchozí journal. `*.measure.ts` se nespouští při běžném `npm test`.

## Kontrakt runneru

`scripts/measure-reality-compiler.ts` exportuje `runBenchmark`, `configuredTransport`, `fileJournal`, `buildReport` a `renderReport`. `protocol.json` převádí prahy protokolu 08 do dat; hash protokolu je v každém běhu. Konfigurace nese runId, commit, příznak dirty, model a jeho konfiguraci, původ, hash sady a konečné limity.

Nezávislá source sada má 10 jedinečných podkladů: 5 úplných, 3 neúplné a 2 konfliktní, s předem zapsaným zásahem, odpovědí na upřesnění a hashem samostatného oraclu. Runner ověří hash a rozložení před první sítí. Muzeum má výslovně status development. Prompt-only sada musí mít samostatných 10 položek typu prompt. Obě sady běží 3×; výstupy se nesměšují. Hash je kontrola driftu, ne veřejně neměnná kotva ani důkaz, že sada nebyla použita při vývoji.

Produktový adaptér `execute(input, phase, previous, context)` provede skutečné create/edit kroky a vrátí artefakt. Každý planner, compiler i repair volá výhradně `context.emit(request, stage, retry)`; pořadové číslo volání není samo o sobě retry. `context.stage` ukládá všechny intervaly fronty, validace, meshe, interakce, porovnání a lidského čekání. Pro živý úspěch je povinný zaznamenaný endpoint `firstInteraction`, respektive `comparison`. Adaptér jej musí uzavřít až po pozorování ověřené interakce/obou větví na stejném tiku, nikoli po modelové odpovědi nebo vykreslení proxy. Přesný význam měření je odpovědností tohoto důvěryhodného testovacího adaptéru, ne tvrzení modelu.

Adaptér nejprve nabídne původní podklad a až po skutečné žádosti o upřesnění poskytne uloženou odpověď. Lidské čekání měří samostatně bez překrývání intervalů. `evaluate` porovná skutečné artefakty se samostatným, předem napsaným oraclem; jeho obsah není argumentem emitoru. Kritickou sémantickou podporu a vizuální použitelnost nesmí adaptér nahradit kontrolou JSON schématu. Chybějící hodnocení vrací null. Negativní commit testy mají vlastní pole `rejectedUnchanged`; nezměření není úspěch.

T10 dodává offline runtime adaptér. Navazující [browserový benchmark T11](browser-benchmark.md) připojuje skutečnou source/create/edit cestu, uzamčený desetipoložkový holdout, oddělený oracle a formuláře ručního hodnocení. Samotný výše uvedený offline příkaz neměří cold produkt. Skutečná inference a lidská hodnocení zůstávají NOT_RUN; nový cold příkaz jejich absenci nezaměňuje za úspěch.

## Živý transport a účetnictví

`configuredTransport(config)` pouze při `origin: live`, `authorized: true` a kladném explicitním `spendLimitUsd` sestaví již existující upstream větev. Ověří shodu modelu, effort, maxOutputTokens, timeoutMs a obou cen z konfigurace běhu s existujícím prostředím. Nic nenastavuje a žádné přihlašovací soubory nečte. Tarify musí operátor ověřit před měřením; report cenu označuje jako výpočet z usage a nakonfigurovaného tarifu, nikoli skutečnou fakturu. `modelConfig` používá pořadí polí effort, maxOutputTokens, timeoutMs, usdPerMTokIn, usdPerMTokOut.

Rezervace používají sdílený `processSpendCap()` a jeho existující provozní limit; runner nevytváří nový rozpočet. Před každou rezervací kontroluje kill switch. Vedle capu platí limit celé série v USD, maxCalls a maxWallMs a nejvýše čtyři volání na fázi. Wall limit zastaví zahajování další práce; probíhající request má konečný timeout stávajícího upstreamu. Produktový adaptér musí mít konečné timeouty i pro vlastní browserové čekání. Vyčerpaný limit či neznámé usage zastaví další placené volání, i když adaptér chybu zachytí.

Journal se synchronně zapisuje a fsyncuje před sítí i po vyúčtování. Pád po `call-start` bez `call-end` zanechá neuzavřený pokus s UNKNOWN; nelze jej vynechat při obnově ani automaticky opakovat. Runner automatické obnovení neimplementuje. Selhání zápisu zastaví běh, selhání settlementu zastaví další útratu. Každý pokus nese vstup, redigovaný výstup, usage, retry, fázi, latenci, chybu, rezervaci, vypočtenou cenu a skutečně vyrovnanou částku capu. Součet fakturovatelného odhadu se neořezává rezervací. Chybějící usage zůstává null/UNKNOWN a cap dostane `unknown`, nikdy nulu. Transport rediguje nakonfigurovaný klíč a endpoint; výjimky nearchivuje v surovém tvaru.

Report zahrnuje všechny plánované páry, i přeskočené edity po selhání create. Ukazuje dokončení, neúspěchy, timeouty, NOT_RUN, podmíněné percentily úspěchů, precision/recall, celkovou známou i úplnou cenu, průměr a maximum na pár, cenu dokončené úlohy a průměr na provider call. P95 používá nearest-rank (u 30 pozorování 29. hodnotu). Jediná doložená korupce označí odpovídající cold bránu FAIL i při neúplné sérii. Offline/cache/prepared nikdy nezezelenají cold brány. Uživatelské brány zůstávají NOT_RUN pro T11.

## Ověření

- 31 testů runneru: oprávnění, limity, neznámé usage, neúspěšné placené pokusy, retry, konfigurace a redakce, ztráta journalu, settlement, jmenovatele, timeouty, endpointy, záměna prepared za live, podhodnocená rezervace, neměnnost archivu a hash sady.
- Cílená regrese se source návrhy, spend capem a muzejním oraclem: 162/162.
- TypeScript a spuštění offline měřicího příkazu.

Žádná placená inference, deploy ani uživatelská studie během T10 neproběhly. Syntetické testy, které zkoušejí výpočet PASS, nejsou měřením modelu.
