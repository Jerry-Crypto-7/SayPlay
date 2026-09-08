# T8 — atomický commit světa a evidence

Datum: 8. 9. 2026. Implementace: `src/worldstream/evidence-commit.ts`; integrační adaptéry v `src/worldstream/sessions.ts`.

## Přijatý kontrakt

- Jeden neměnný `ProjectRevision` obsahuje WorldDoc, evidence, přesné zdrojové snapshoty, rodiče a případné porovnání větví. Publikuje se jedinou výměnou reference až po všech kontrolách. `getSessionProject` vrací vždy celý pár.
- Původní T7 evidence se nejprve ověří včetně hashe a citací; aplikace ji potom zapečetí k revizi odvozené z celého přijatého WorldDoc. Význam `simHash` zůstává stejný. Hash projektu zahrnuje i zdrojová metadata, rodiče a porovnání.
- WorldDoc prochází existující migrací/validací, kontrolou hashe, vzhledu a loweringem `buildRuntimeWorld`. Chybějící, nadbytečné, duplicitní či změněné zdroje se odmítají. Importovaný review status se nemůže sám autorizovat.
- Zásah používá soukromý branch-controller nad rodičovským světem a skutečným logem. Přijímá pouze podporovanou změnu budoucího timeru před aktivací. Hodnoty before/after a ruleId pocházejí z ověřeného výsledku; volající je nemůže podvrhnout.
- Změněné pravidlo odkazuje na nové `assumed + changed + unchecked` tvrzení s důvodem zásahu. Původní tvrzení zůstávají zachovaná, ale binding změněného pravidla už nepřebírá jejich citaci. Zdrojové bytes, SHA-256 i původní rodičovská revize zůstávají stejné.
- Po asynchronním hashování se znovu kontroluje aktuální rodič i vstupní log. Dva souběžné commity mají nejvýš jednoho vítěze. Chyba ani stale base nepublikují samotnou větev, svět či evidence; živý runtime zůstává nedotčený.

## Integrace a meze

Úložiště projektu patří konkrétní relaci přes WeakMap. `commitSessionProject`, `commitSessionIntervention` a `getSessionProject` jsou interní aplikační adaptéry pro T9. Nemění legacy blueprint, pending changes, sdílený svět ani události relace. Nevznikají nové HTTP dveře nebo UI.

Regresní kontrola `changes.test.ts` dříve zakazovala jakoukoli importní cestu serveru k rebranch. T8 tuto hranici cíleně mění: soukromý replay je přípustný pouze přes `evidence-commit.ts`. Kontrola úplného importního grafu nadále hlídá všechny zapisovatele blueprintu; samostatná pojistka zakazuje project transakci přístup k mutable legacy relaci a snapshot registru. Integrační test kontroluje neměnnost legacy stavu při přijetí projektu i zásahu.

Pilot podporuje jednu intervenci a uchovává rodiče. Jde o atomickou operaci uvnitř jednoho procesu, nikoli databázovou persistenci mezi instancemi. Přijetí není win certifikace, semantické potvrzení zdroje ani automatické schválení předpokladu. Review UI/autorizace lidské akce, HTTP a zobrazení patří T9. Žádná placená inference ani nasazení.

## Ověření

27 nových testů pokrývá kompletní přijetí, nezávislý museum oracle 400→200, zdrojové bytes s BOM/CRLF, binding změněného pravidla, vadné zdroje/hash/span/review/svět, stale base, aktivní timer, souběh, změnu vstupů během await, selhání hashování, neměnnost snapshotů a izolaci relací.

- `npx vitest run src/worldstream/__tests__/evidence-commit.test.ts`: 27/27.
- Širší regrese `src/ir src/sim src/worldstream src/model src/app/api/worldstream src/server`: 1941/1942 v 70 souborech. Jediná chyba byla výše popsaná importní pojistka; ostatní testy prošly.
- Po zpřesnění pojistky a doplnění kontroly legacy stavu: `npx vitest run src/worldstream/__tests__/evidence-commit.test.ts src/app/api/worldstream/__tests__/changes.test.ts`: 98/98.
- `npm run build` a závěrečný `npm run typecheck`: prošly. `git diff --check`: bez chyb whitespace. Browserová cesta se v T8 nemění; nové browserové scénáře patří T9.
