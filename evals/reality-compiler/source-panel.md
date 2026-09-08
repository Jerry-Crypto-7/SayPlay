# T9 — vlastní podklad a vysvětlení z runtime

Datum: 8. 9. 2026. Dokončeno a ověřeno.

## Hlavní cesta

Na `/` přibyl rozbalovací vstup **Build from a source**. Přijímá vlastní text, titul, původ a rights status; počítá Unicode code points a UTF-8 bytes podle T2. Klávesnicí lze otevřít editor, odeslat text, vybrat akci i pravidlo ve vysvětlení.

`POST /api/worldstream/source` vrací výsledek T7. Používá existující sessions kill switch, frekvenční limit, omezené čtení těla, moderaci, sdílený souběhový slot `world` a spend-controlled provider. Nepřijímá nástrojová oprávnění, review ani navýšení rozpočtu. Zdroj se po moderaci nenormalizuje. Odpověď má `Cache-Control: no-store`; interní výjimky se neposílají do UI.

Chybějící podmínky, konflikty a nepodporované mechanismy se vypíší jako upřesnění a ponechají dosavadní svět. Přijatý návrh prochází znovu T8 v prohlížeči: ověření přesného vstupního zdroje, hashe, citací a atomické svázání s WorldDoc. Vadná evidence nebo odpověď k jinému podkladu nepřepíše současný projekt. Pozdní odpověď po nové běžné větě se zahodí; čekající druhé modelové dějství nemůže automaticky přepsat probíhající source workflow.

Projekt běží v jediném existujícím runtime controlleru hlavní scény. `source-view.ts` dodává schematické kvádry na skutečných simulačních souřadnicích entit, ne modelovou uměleckou geometrii. UI to uvádí. Žádný witness se za návštěvníka nepřehrává.

## Why a původ

**Why?** nabízí pouze ruleId přítomná v aktuálním runtime trace. Vybírá bindingy z evidence zobrazeného projektu; při přepnutí revize ruší starý výběr. U tvrzení odděleně ukazuje support (`sourced/derived/assumed`), intervention (`original/changed`) a review. Citace obsahují přesný excerpt, zdroj a byte span; odvození vypisuje premisy a předpoklad svůj důvod.

Podrobnosti pravidla oddělují zaznamenané firing od deklarované podmínky a účinků. UI netvrdí, že měří jednotlivé účinky nebo že citace potvrzuje realitu. Review zůstává `unchecked`; potvrzení experimentu není vydáváno za sémantickou kontrolu zdroje. Autoritativní workflow pro lidské potvrzení review tento krok nezavádí.

Volitelný formulář budoucího timeru volá skutečnou transakci T8. Hodnoty před/po nepocházejí z textu formuláře; zdroj zůstává původní a změněné pravidlo vysvětluje experimentální předpoklad. Lze se vrátit k rodičovské větvi s její původní citací. Legacy přirozenojazyčný preview/commit z T6 zůstává zachován pro původní blueprintovou cestu.

Běžný prompt bez podkladu nemá source evidence a Inspect to výslovně říká. Offline browserová fixture nese vlastní popisek a není označená jako živá generace.

## Meze

Přijatý source projekt a jeho jedna intervence žijí v paměti této záložky. UI to uvádí; refresh je neobnoví. HTTP endpoint slouží k návrhu, nikoli k uložení project snapshotu do serverové relace. T8 session adaptéry zůstávají dostupné pro následné persistence/reconnect řešení. Nejde o druhý simulační engine ani změnu legacy blueprintů.

Testy neprokazují semantickou kvalitu živé extrakce, uživatelský přínos 3D ani cold latenci. Žádná placená inference nebo nasazení.

## Ověření

- 9 nových HTTP testů; cílená sada serverových Worldstream dveří, T7 a T8 prošla **223/223**.
- První browserový běh: **4/5**. Jediná chyba byla pokus testovací fixture přepsat zmrazený evidenceHash; opraveno přes `structuredClone`.
- Snímek prvního běhu odhalil nízký kontrast nativních vstupů. Doplněny lokální barvy/focus styly a sbalení source editoru po úspěšném přijetí.
- Závěrečný běh `E2E_PORT=3119 npx playwright test e2e/reality-compiler-evidence.spec.ts e2e/reality-compiler-branch.spec.ts e2e/reality-compiler-runtime.spec.ts --project=chromium`: **11/11**, včetně čerstvého produkčního buildu s TypeScriptem. Source scénáře **5/5**, T6 regrese **4/4**, runtime **2/2**.
- `npx vitest run src/app/__tests__/theme.test.ts`: **23/23**. `git diff --check`: bez chyb whitespace.
- Závěrečný `npm run typecheck` po browserovém běhu: prošel.
- Vizuálně zkontrolován `scratch/reality-compiler-evidence.png`: čitelný skutečný trace, tři samostatné osy, zdrojový excerpt a schematická scéna. Připojený Browser nebyl dostupný; kontrola proběhla přes projektový Playwright a uložený snímek.
