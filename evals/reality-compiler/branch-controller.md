# T5 — bezpečné větvení časového pravidla

Datum: 7. 9. 2026.

## Rozsah a rozhraní

`createBranchController(document, sourceController)` zakládá lokální transakci nad jednou ověřenou simulací. Ověří simHash i shodu IR/prostoru s předaným runtime. `getBase()` vydá simRevision, simHash, revision porovnání a počet zaznamenaných vstupů. `compare()` přijímá tuto base, ruleId, durationTicks, forkTick a observationTick. Nepřijímá uživatelské JSON pointers ani náhradní svět.

Podporovaný zásah změní jediný existující číselný údaj `durationTicks` v jediném `startTimer` cílového pravidla. Kapacita a počáteční stav timeru se nemění. Nový dokument prochází existujícím loweringem; runtime vzniká pomocí `rebranchAt` nad soukromou kopií. Původní živý controller se neposouvá ani při úspěchu. `RuntimeController.forkAt()` navíc vždy dosadí původní vstupní log místo svědka dodaného s novým dokumentem.

Každé přijaté porovnání je alternativou ke stejnému originálu, nikoli kumulativní editací předchozí varianty. Má vlastní rostoucí revision porovnání; changedDocument má simRevision originálu + 1, nový simHash a původní lookRevision. Výsledné dokumenty, vstupy a snapshoty jsou neměnné.

## Invarianty a odmítnutí

- Obě větve dostávají jeden zachycený log, včetně neúspěšných aktivací; log se neodvozuje z certifikačního svědka.
- V místě větvení jsou všechny stavové sloty a entity shodné. Prostor, deklarace, identita, ostatní pravidla, vzhled a kapacita timeru se zachovávají; mění se pouze určený skalár a revizní metadata.
- Živý originál, jeho pauza, aktuální snapshot a listener zůstávají při porovnání nedotčené.
- Zastaralá simRevision/simHash/revision porovnání, nové vstupy po preview, nejednoznačný tvar pravidla, nepovolená hodnota a aktivní timer jsou odmítnuté bez změny posledního přijatého porovnání a jeho revision.
- Ukončená větev uvádí skutečný runtime tick a endedAtTick; obě pozorování přesto mají společný observationTick. Testy pokrývají ukončení původní i změněné větve.
- Pilot omezuje horizont na 12 000 tiků (10 minut při 20 Hz) a log na 12 000 vstupů. Zásah do aktivního timeru a větvení za koncem běhu nejsou podporované.

## Důkaz

38 testů nové transakce zahrnuje nezávislý museum oracle, změnu 400→200 tiků, skutečné dispatch vstupy, nenulový fork před aktivací, replay za kruhovým bufferem, atomická odmítnutí po předchozím úspěchu a neměnnost exportů. Širší sada `src/ir src/sim src/worldstream` prošla **965/965 v 38 souborech**. TypeScript i produkční build prošly. Browserové regrese `reality-compiler-interaction.spec.ts` a `reality-compiler-runtime.spec.ts` nad čerstvým produkčním buildem prošly **4/4 za 2 minuty**. Git diff --check bez chyb. Lokální server po ověření ukončen; žádná placená inference ani nasazení.

Reprodukce:

```powershell
node node_modules/vitest/vitest.mjs run src/ir src/sim src/worldstream
$env:CIRCLE_NODE_TOTAL = '3'
$env:WORLDSMITH_MODEL_ENDPOINT = ''
node node_modules/next/dist/bin/next build --webpack
```

## Zjištěný rozdíl formátů a návaznost

První implementace narazila na existující obecnou patchovací kontrolu: `commitPart` vyžaduje v upravovaném pravidle vnořené `rule.id`, zatímco museum fixture i lowering používají stabilní klíč mapy. Validní zásah 400→200 proto neprošel. Lokální doménový adaptér nyní mění pouze nalezený skalár na oddělené kopii, zachovává identitu klíče a používá existující simHash a runtime validaci. Neoslabuje obecné HTTP patchování; vložené ID v rozporu s klíčem odmítá. T6 musí propojit přijatý change flow s touto doménovou operací a zohlednit tento rozdíl formátů.

T5 nepřipojuje nové compare UI ani přirozený jazyk — to je T6. Neprovádí HTTP commit, nepřijímá source/evidence a neprohlašuje atomickou project revision; zdrojová transakce je T8. Původní zdrojové soubory a evidence zůstávají nedotčené. Výsledky jsou development důkaz enginu, nikoli měření modelu.
