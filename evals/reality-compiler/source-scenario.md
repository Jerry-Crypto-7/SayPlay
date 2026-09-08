# T7 — návrh scénáře z krátkého podkladu

Ověřeno 8. 9. 2026. Implementace je v pracovním stromu; bez placeného nebo cold běhu.

`runSourceProposal(source, worldRevision)` používá stejný provider a procesový spend cap jako původní generace. Provider byl beze změny rezervace/vyúčtování přesunut do `src/server/worldstream-emitter.ts`; původní route jej dál exportuje. Neplatný zdroj/revize nevyvolá provider. Jeden návrh znamená nejvýš jedno volání, bez automatických retry. Chyba provideru ani odmítnutí rozpočtu nevrací interní detail.

Zdroj je omezený kontraktem T2 a dostane hash přes přesné UTF-8 bytes. Model jej dostává jako JSON data v user zprávě, odděleně od systémových instrukcí. Rozhraní nemá nástroje ani pole pro změnu oprávnění, endpointu nebo rozpočtu. Model smí vrátit jen návrh sim, claims, bindings a seznamy chybějících kritických podmínek, konfliktů a nepodporovaných mechanismů.

Neprázdný seznam blokuje vykonatelný návrh. Pravidla musí mít explicitní event, condition a actions. Sim prochází existujícím `buildRuntimeWorld`; evidence kontroluje všechny bindingy, UTF-8 spans, claim DAG a aplikací dodanou revizi. Review musí být unchecked a interventionId null. Přímý i odvozený předpoklad navázaný na pravidlo vyžaduje doplnění. Předpoklady mohou popisovat nekritické rozmístění entit.

Nová hranice odmítá necelé, nekladné nebo více než 3 600 tiků dlouhé durationTicks. Test odhalil, že původní lowering u necelé hodnoty akce použije deklarovanou délku timeru; adaptér tento tichý fallback nepustí. Engine zůstává beze změny. Podporované časování je 20 Hz, timeout před aktivací ve stejném tiku, výsledek vstupu N ve snapshotu N+1.

## Ověření

- 32 nových testů T7: nezávislé muzejní runtime výsledky nad vráceným sim, blokované návrhy, neplatné vstupy před providerem, oddělení zdrojových instrukcí, chyby evidence, falešné review, nepodporovaná akce, necelý timer, kritické předpoklady i přes derivaci, chybějící guard, default provider a failure paths.
- Cílená sada včetně všech Worldstream API testů, sessions, evidence a spend cap/store: **398/398**, 9 souborů.
- Produkční build včetně TypeScriptu prošel; `git diff --check` bez chyb. Původní změny T1–T6 a model-demo zůstaly zachovány; měřicí artefakty se nepřepsaly.

## Hranice důkazu

Toto je offline důkaz kontraktu, nikoli kvality extrakce živým modelem. Model může opomenout konflikt nebo připojit přesnou citaci, která význam pravidla nepodporuje. Validátor neprokazuje úplnost ani sémantickou shodu a návrh se sám nepotvrzuje. Testová krátká citace pro celý muzejní sim záměrně ověřuje strukturální vazby, ne významovou podporu každého pravidla.

Výsledek `proposed` obsahuje sim použitelný jako část WorldDoc a validovanou evidence revizi návrhu. Není to přijatá project revision, win certifikace ani uložený snapshot. T7 nemění přijatý svět, nepublikuje a nepřipojuje nové HTTP/UI dveře. Atomický commit patří T8, vstup podkladu a review UI T9; živé měření navazujícím úkolům.
