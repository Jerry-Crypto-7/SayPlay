# T6 — potvrzená změna a uživatelské porovnání větví

Datum: 8. 9. 2026.

## Implementace

Hlavní URL používá stávající druhou větu, requestChange, ChangePreview, commitChange a autoritativní snapshot relace. Preview změny chování dovoluje zvolit fork tick a společný observation tick (0–12 000). Před potvrzením se větev nevytváří.

`accepted-branch.ts` zachytí původní dokument a revizi/log controlleru před požadavkem na preview. Hodnotu zásahu získává až z přijatého dokumentu, nikoli ze shrnutí modelu. Ověřuje simHash, posun simRevision o jedna, zachovaný look a jedinou změnu skaláru startTimer.durationTicks; navrácením skaláru a porovnáním celé simulace vylučuje další skryté zásahy. Následně volá T5 branch-controller s původní base a společným horizontem.

Panel `BranchComparison` ukazuje cílené ruleId, délku před/po, fork tick, observation tick, počet společných vstupů, skutečné runtime tick/endedAtTick, stavové hodnoty a trace obou větví. Tabulka je neměnné pozorování; pod ní lze pokračovat v běhu vybrané větve. Návrat k originálu obnoví zachovaný controller a geometrii bez přetáčení jeho času. Přijatá větev zůstává na serveru; přepínač není HTTP rollback.

Pokračování změněného běhu používá controller vrácený skutečným `forkAt`, nikoli nový replay změněných pravidel od tiku 0. Unit reprodukce větví až v tiku 300 po úspěšném odemčení a dokazuje, že pozdější zásah nemůže zpětně vyvolat alarm před bodem větvení.

## Odmítnutí a meze

- Nový vstup po preview se zjistí před commitem a vyžádá nové preview bez HTTP commitu. Pokud vstup přibude až během čekání na commit, serverem přijatý svět se načte, ale UI výslovně oznámí nedostupné porovnání. Nepředstírá atomický rollback serveru.
- Odmítnutý commit, zahozené preview a zastaralá odpověď nevytvářejí porovnání. Dosavadní ochrana proti pozdnímu dějství II zůstává.
- Pilot podporuje jednu intervenci na svět. Další změna vyžaduje nový svět; řetězení intervencí s historií různých pravidel před nenulovými forky není součástí T6. Obě zachované větve lze prohlížet a dále ovládat, pevná tabulka tím nemění svůj log ani horizont.
- Obecné HTTP patchování nebylo oslabeno. Browserový museum fixture dostává shodné vložené rule.id už při vytvoření, před výpočtem hashů a revizí. Jeho přijatý dokument vytváří skutečný commitPart. Adaptér samotný navíc podporuje mapové dokumenty bez vloženého ID; dodatečné přidání nebo přejmenování ID v přijaté změně odmítá.
- Transport a odpověď modelu jsou v T6 browserových testech scriptované. Původ světa zůstává označen authored ahead of time. Nejde o měření inference ani o podporu nového zdrojového scénáře; T7/T8 zůstávají navazující práce.

## Ověření

- 11 nových unit případů adaptéru, včetně skutečného commitPart, extra editace, stale revision/hash, identity pravidla, aktivního timeru, změněných vstupů a pokračování nenulového forku. Cílená sada adaptéru, branch/runtime controllerů, runtime vstupů, klienta a museum oracle: **111/111**.
- První browserový průchod prokázal hlavní 20→10 cestu, zahození/odmítnutí a stale preview. Test vstupu během commitu měl nejednoznačný `getByRole('status')` (výstup akce i oznámení porovnání); opraven na konkrétní zprávu. Aplikace při tomto selhání zobrazovala správné odmítnutí porovnání.
- Browserové regrese T3/T4 a druhého dějství: **9/9**. Při opakování T6 poslední scénář vyčerpal celkových 30 sekund po sestavení WebGL fixture, ještě na kliknutí Apply; limit celé T6 sady sjednocen na 90 sekund jako u hlavního scénáře. Nezvyšují se limity enginu ani horizont porovnání.
- Závěrečné browserové ověření nad čerstvým produkčním buildem: **4/4**, proces skončil kódem 0 (4,2 minuty včetně buildu). Prošla potvrzená změna, stejný log/horizont, rozdíl vitríny/alarmu, návrat ke stejnému původnímu ticku, zahození, odmítnutý commit a nové vstupy před i během commitu. TypeScript prošel; git diff --check bez chyb. Snímek `scratch/reality-compiler-branch.png` byl vizuálně zkontrolován: vitrína, alarm, společný horizont i skutečné runtime tick jsou viditelné bez rolování.

Reprodukce:

```powershell
npx vitest run src/worldstream/__tests__/accepted-branch.test.ts src/worldstream/__tests__/branch-controller.test.ts src/worldstream/__tests__/runtime-controller.test.ts src/worldstream/__tests__/runtime-input.test.ts src/worldstream/__tests__/client.test.ts src/sim/__tests__/museum-oracle.test.ts
$env:E2E_PORT = '3118'
$env:CIRCLE_NODE_TOTAL = '3'
$env:WORLDSMITH_MODEL_ENDPOINT = ''
npx playwright test e2e/reality-compiler-branch.spec.ts e2e/reality-compiler-runtime.spec.ts e2e/reality-compiler-interaction.spec.ts e2e/second-act.spec.ts --project=chromium
```

Lokální testy vyžadovaly eskalaci kvůli sandboxovému spawn EPERM. Žádné nasazení ani placené měření nebylo spuštěno.
