# T11 — připojený browserový benchmark

Aktualizace 8. 9. 2026: vlastní lokální demo a živá série přes předplatné mají [samostatný návod a účetní meze](subscription-benchmark.md) a [aktuální report](subscription-report.md). Níže uvedený USD limit patří výhradně API režimu. Není podmínkou subscription dema ani tohoto subscription benchmarku.

Implementace navazuje na T10. `scripts/reality-compiler-browser.ts` otevírá skutečnou hlavní stránku, vyplňuje zdroj, poskytne uložené upřesnění až po skutečné otázce, provede prostorovou interakci a přes UI potvrdí timer experiment. Zdrojové projekty nyní zobrazují stejnou tabulku porovnání jako ostatní větve; návrat přepne na zachovaný původní runtime. Informace v sondě jsou jen čtecí kopie skutečného projektu, vstupů a runtime snapshotu.

## Co měří browserová cesta

Source request se přenese pomocí označeného Playwright bridge do stejného `src/app/api/worldstream/source/handler.ts`, který obsluhuje produkční route. Zůstává validace těla, moderace, rate/concurrency brány a source proposer. Provider v měřicím procesu volá výhradně účtovaný emitor T10: API používá stávající spend cap a kill switch, subscription cesta oficiální CLI s vlastním limitem logických volání a bez API fallbacku. Žádné pole HTTP requestu neumí vybrat fixture nebo získat účetní oprávnění. Výslovná fixture varianta je pouze závislost testovacího adaptéru.

Toto je měření browserového produktu a čerstvé inference s lokálním transportem. **Nezahrnuje síť k nasazenému hostingu, serverless cold start ani jeho provozní kapacitu.** `environment.json` ukládá tento rozsah i Chromium/SwiftShader a viewport. Přepínač live neznamená změřené produkční nasazení.

Čas startuje skutečnou událostí potvrzení formuláře v browseru; založení stránky, předvyplnění a příprava logu pro zásah jsou mimo latenci create/edit. Konec create vyžaduje vykreslené sloty, draw calls, povolené ovládání, skutečně spuštěné pravidlo po uživatelském vstupu a následující renderované framy. Je to konzervativně pozorovaný ovladatelný frame, nikoli přesný okamžik GPU present. Konec edit vyžaduje zobrazené porovnání a oba snapshoty ve stejném horizontu.

Timer experiment v source cestě je **deterministický**, bez placené edit inference. Runner tuto cestu zaznamená jako `execution: deterministic`; create bez doloženého modelového volání nesmí projít jako live. Případné vyžádané upřesnění je další create volání ve stejném páru a všechny jeho náklady zůstávají ve jmenovateli. Před pozitivním zásahem adaptér zkouší změnu běžícího timeru v dřívějším forku a porovná celou revizi a runtime před odmítnutím a po něm.

Po konci create adaptér pozastaví běh přes běžné UI před screenshotem. Příprava jej obnoví, zadá skutečný pohyb a druhou aktivaci vyvolá z vybraného UI ovládání při pozorovaném tiku přímo v browseru. Tím screenshot a pomalé transportní kroky automatizace nespotřebují předepsané časové okno. Hodiny ani stav enginu se nepřepisují. Log skutečných vstupů a očekávané časové okno znovu kontroluje oracle; pozdní vstup není úspěch. Selhání přípravy má vlastní diagnostický JSON a screenshot, je-li stránka dostupná.

Model a validace mají vlastní intervaly; validace zahrnuje sestavení source požadavku a evidence mimo čekání na model. `mesh` měří připravenost schématické geometrie/renderu. Fáze nepoužívané danou cestou mají `not-used`; nezměřené fáze zůstávají `NOT_RUN`, nikoli smyšlená nula. Source handler nemá čekací frontu ani samostatný planner/automatický repair. Browserový timeout neopustí rozpracované placené volání: před dalším párem se čeká na jeho konečné vyúčtování. Skutečné lidské čekání patří do uživatelské studie, uložené odpovědi se zde dodávají automaticky.

## Spuštění API cold série

1. Zkontrolovat `holdout-v1/manifest.json`; neměnit sadu podle výsledků. Scope je omezený na časované postupy se dvěma stanovišti.
2. Použít aktuální produkční build hlavní stránky na localhost. `RC_BASE_URL` ukazuje na tuto adresu. První ověřený build a jeho dirty/commit stav zapsat s podmínkami testování.
3. Ve spouštěcím prostředí musí už existovat platná konfigurace provideru, ověřený tarif a provozní spend cap. Runner nečte přihlašovací soubory ani nenačítá `.env`; nezvyšuje provozní rozpočet.
4. Nastavit skutečně schválený `RC_SPEND_LIMIT_USD` a `RC_LIVE_AUTHORIZED=1`, potom spustit `npm run measure:reality-compiler-cold`. Série má nejvýš 60 provider calls, 4 na fázi a jednu hodinu na zahajování práce; request má vlastní konečný timeout provideru. Chybějící podmínky vytvoří všech 30 párů s NOT_RUN a bez inference.

Neuvádíme ukázkovou částku, která by vypadala jako schválený rozpočet. Historický [API cold report](cold-report.md) obsahuje **0/30 zahájených párů**, protože pro něj provider ani částka nebyly dostupné; není to výsledek pozdějšího subscription sběru. Všechny raw pokusy, source reakce, projekty a screenshoty zůstávají v adresáři konkrétního běhu. Ztráta journalu zastaví další volání. Přerušené started volání se nepřeskočí ani automaticky neopakuje.

## Nezávislá kontrola a lidská studie

`holdout-v1/oracle.json` předepisuje 32 atomických požadavků na každý zdroj, exact spans, potřebné otázky, povolený zásah a očekávané následky. Oracle se neposílá modelu. Automatický judge porovnává skutečné snapshoty s očekáváním, identitu/source při forku a odmítnutý zásah. Význam citací, správnost otázky, precision/recall a vizuální použitelnost vyžadují přiřazené lidské review v `review.template.json`. Samotná schema validace je nenahrazuje.

Vyplnit review podle skutečného archivovaného běhu; indexy, IDs, hash sady i oraclu musejí souhlasit. Uvést reviewer a čas. `unsupportedAtomicCount` počítá nepodložená atomická tvrzení/chování na stejné úrovni jako požadavky, nikoli počet JSON rule objektů. Pak nastavit `RC_RUN_FILE` a `RC_REVIEW_FILE` na odpovídající soubory a spustit `npm run evaluate:reality-compiler`. Vznikne nový adresář v `reviews/`; původní run a report se nepřepisují. Ruční review nikdy nepřebije doložený automatický FAIL.

[Uživatelský protokol](user-study.md) a `user-study.json` obsahují pět prázdných formulářů, dvě různé úlohy, prohozené pořadí i přiřazení úloh k modalitám. Stejný vyhodnocovací příkaz vypočte `user-study-results.json`. Současný stav je **0/5 lidí, NOT_RUN**. Anonymní sloty nejsou skuteční účastníci a unit testy skórování nejsou uživatelský výzkum.

T11 jako důkaz zůstává otevřený, dokud nejsou skutečné cold výsledky, lidské sémantické review a pět pozorování. Implementační připravenost nepotvrzuje produktovou hypotézu. Skutečný negativní signál z běžící série už umožňuje konzervativní [rozhodnutí T12 o zúžení](decision.md); není vydáván za PASS T11 ani za lidský přínos.

## Ověření implementace, 8. 9. 2026

Cílené unit testy 167/167, TypeScript a produkční build prošly. Finální browserová sada `reality-compiler-benchmark.spec.ts` + `reality-compiler-evidence.spec.ts` prošla 6/6. Adaptér provedl tři úplné páry nad vývojovým muzeem: skutečné source UI a runtime, upřesnění, odmítnutí neplatného zásahu bez změny, porovnání a správný rozdíl výsledků. Čas má ve všech šesti fázích skutečný browserový začátek. Screenshot porovnání byl zkontrolován. Inference byla výslovně fixture, provider calls 0; tato kontrola nezměnila cold brány ani nepoužila holdout k ladění modelu.
