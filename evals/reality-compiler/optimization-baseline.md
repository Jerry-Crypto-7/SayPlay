# Optimalizace: výchozí stav a hranice měření

## 11. 9. 2026: vstupní bajty kontraktu naměřené, A7 doložena jako blokovaná

**Poprvé je naměřený vstupní objem, který jde nahoru na jednu první větu.** Do dneška ho žádný běh nezapsal: jediný offline experiment (`contract-size.measure.ts`) měřil mechanické `bindingId` a sám o sobě říká, že to není porovnání celého promptu. Nový `prompt-size.measure.ts` staví prompty těmi samými funkcemi, které volá produkt, nad zmrazenou gramatikou a `EXAMPLE_PLAN`. Deterministické, **0 volání modelu**; raw `scratch/prompt-size.json`.

| Fáze | system | user | celkem |
|---|---|---|---|
| planner (`buildIntentRequest`) | 4 029 B | 525 B | **4 554 B** |
| emission (`buildEmissionRequest`) | 11 212 B | 589 B | **11 801 B** |
| compiler (`buildCompilerRequest`) | 26 708 B | 1 951 B | **28 659 B** |

**Jedna první věta = planner + compiler = 33 213 B promptu ve dvou voláních.** Emission se na téhle cestě neposílá samostatně — je vložený dovnitř compileru.

**Naměřený cíl A7:** `buildCompilerRequest` vkládá `buildEmissionRequest('', grammar).system` **doslova** mezi `WORLD CONTRACT` značky. Ten vložený blok má **11 214 B, tedy 41,99 % systémové části compileru** a 33,8 % celého promptu první věty. Je to kontrakt napsaný pro jinou cestu (stage, který může dostat větu, za níž nic nestojí), a compiler za ním musí utratit dalších sedm řádků na to, aby zavřel `NO_FIT` nabídku, kterou ten vložený text otevírá.

**Zdvojených řádků uvnitř jednoho promptu je prakticky nula: jediný, celkem 84 B.** Compiler prompt tedy není psaný neopatrně; celá váha je v té struktuře, ne v opakování. To je podstatné, protože to ruší jedinou úpravu, která by byla bezpečná naslepo.

**Důsledek pro A7 — doložený, ne odhadnutý: offline se A7 dokončit nedá.** Jediné smysluplné zkrácení je ten vložený kontrakt, a tím se mění, co se modelu říká. AC A7 přijímá pouze „naměřenou optimalizaci bez zhoršení významové správnosti"; oracle na významovou správnost je výstup modelu. Bez živého před/po by šlo o změnu promptu bez měřitelného následku — přesně to, co AC zakazuje. Komentáře u obou bloků navíc pinují naměřené incidenty (zaseknuté `NO_FIT` ze spike `d749ce7`, odsazení ukázky zaplacené vynechanými poli), takže „vypadá to nadbytečně" tady není důkaz.

**Co zůstává NOT_RUN.** Výstupní bajty, skutečná provider usage, tokeny a latence po fázích. Instrumentace je hotová (server `Server-Timing` journal, `worldstream-pipeline-v1`, subscription journal); chyběl endpoint. Tokeny se ze vstupních bajtů **neodhadují**.

**Endpoint ověřen 11. 9. 2026 — cesta existuje a je to předplatné Codexu, ne Max.** Lokální `claude-code-proxy` 0.1.22 nastartována na 127.0.0.1:18766; jedno minimální volání vrátilo **HTTP 200, `model: gpt-5.6-sol`, usage 13 vstupních / 5 výstupních tokenů**. Skutečná provider usage tedy po téhle cestě k dispozici je, což je přesně to, co A6 chce. Žádný placený klíč se nekupuje.

⛔ **Max plán touhle cestou nejde a není to otázka konfigurace.** Backendy proxy jsou `codex`, `kimi`, `grok`, `opencode`, `cursor` — **Anthropic mezi nimi není**, a Max plán není HTTP endpoint (totéž říká komentář u `EMISSION_MODEL` v `src/model/prompt.ts`). Jména `claude-*`, která proxy v seznamu `codex:` nabízí, jsou **aliasy na Codex modely**: požádáš o `claude-opus-5`, obslouží to `gpt-5.6-sol` a odpověď se vrátí označená tím aliasem — právě ta nepravda, kterou měřidlo do 6. 9. 2026 zapisovalo na disk. Do `WORLDSMITH_MODEL` proto patří pravé jméno; hlídá to test nad `prompt.ts`.

## Šestá session 10. 9.: ověřené měřicí hranice, bez nové živé latence

Source/prepared browser smoke ověřil i poslední deadline/cancel opravy: dvě oddělené sady **2/2 PASS**, druhá se 3 source a 5 prepared scénáři. Report `scratch/session6-browser-validation.json`. Nový ordinary provider-only recorder ukládá frozen input/config, skutečný provider-start, response/usage a chyby s odděleným late journal; neobsahuje produktovou session/frame/interakci ani nezávislé posouzení promptu. Společná runner/readiness regrese **202 PASS / 0 FAIL / 1 SKIP**, TypeScript PASS.

Živý experiment před/po **NOT_RUN**: konkrétní linuxový CLI runtime prošel help/version **4/4** a po zachovaných UID-map/setup selháních také fixed synthetic sandbox kontrolami; produkční auth/network/cleanup profil tím není validovaný. [Důkazy a limity](../../scripts/subscription-runtime-probe.md). Žádná nová modelová latence, tokenová úspora či zrychlení se z těchto kontrol neodvozuje; A7 zůstává u historické offline úspory objemu. Předchozí měření níže se nemění.

## Čtvrtá session: cache miss, warm cache a frame intervaly

Produkční browser **2/2 PASS** (`scratch/session4-cold-warm-browser2.json`), raw údaje `scratch/session4-cold-warm-resources.json`. RTX3090 / ANGLE D3D11, Chromium151, Windows, 16 logických CPU, viewport1280×720, DPR1, reduced motion. Stejný již postavený produkční artefakt jako aktuální motion GPU sada, žádný dev server ani nová inference.

| Úsek | Pozorování |
|---|---|
| První meshing varianty A při vytvoření | 658,50 ms; obsahuje start workeru a celou klientskou mesh/proxy cestu. Jeden skutečný worker job. |
| Nová varianta B při první editaci, cache miss | 67,20 ms; jeden vzorek, již zahřátý worker. Není to druhý cold-process start. |
| Následujících 24 editací, warm cache | Medián0,75 ms, min0,50 / max1,40 ms; **žádný další worker job**. Celkový počet skutečných jobů1→2. |
| Klidové browser rAF intervaly, paused runtime | 120 vzorků, medián16,70 ms / p95 16,70 ms. Jsou to intervaly browserového plánování, nikoli GPU execution, scanout nebo render workload pod zátěží. |
| GPU prostředky po25 editacích | Všech25 vzorků7 geometrií /4 textury /6 programů; změněné meshe4860/6348 trojúhelníků, wrappery/sockety, tick, vstup i kamera zachovány. |

Toto je malý označený lokální profil dvou střídajících se tvarů. Neměří JS heap/VRAM bytes, cold-unique sérii, server shape gate ani modelovou latenci; z jediného cache miss se neodvozuje p95. Mesh fáze je ukončená, celkový edit run může při paused runtime dál čekat na člověka. První měřicí test nesprávně čekal na celý run a selhal; `scratch/session4-cold-warm-browser.json` zůstává zachovaný. Následný test měří správnou dokončenou fázi a přímo porovnává její provenance se skutečným počtem postMessage worker jobů.

Aktualizace serverové instrumentace 9. 9. 2026: source, otevření prompt session, preview a commit obyčejné editace vracejí aditivní `Server-Timing` a `X-Worldstream-Request-Id`; request-local journal `worldstream-server-v1` má nejvýše 128 fází a loguje strukturované události `worldstream.server-timing` bez promptů, odpovědí a credentials. HTTP 202 uzavírá jen handler, nikoli generaci: její samostatný závěrečný snapshot vzniká až po background práci. Pending časy zůstávají null. Fáze rozlišují čtení/parsování vstupu, validaci source/intent/blueprint/edit, source runtime lowering, commit validaci a sestavení následujícího blueprintu. `provider-transport-and-response` je včetně transportu a parse; vnořené `provider-http-request` končí HTTP headers, `provider-response-json` zahrnuje čekání na tělo a parse obálky a `provider-output-json-parse` měří parse JSON textu. Inclusive úseky se nesčítají jako nezávislé části. `completed` znamená návrat operace, nikoli sémantické přijetí výsledku; odmítnutí zůstává v HTTP/aplikačním výsledku. Čistá serverová model latency ani čas před vstupem do handleru se z těchto hodnot neodvozují. Serverová sada 8 souborů / **313 testů PASS**, TypeScript a diff-check PASS (`scratch/server-metrics-tests.log`); jde o offline instrumentaci a kontraktní regresi, ne nové živé měření. Model, effort, limity i subscription transport beze změny. Následný nález: veřejný renderer nepoužívá `world.look`; preview i commit proto nově odmítají appearance/palette/light/material zásahy (včetně starších uložených a smíšených), místo aby přijatou revizí slibovaly neexistující vizuální změnu. Shape a behavior editace i obecný `/api/edit` kontrakt zůstávají podporované; RED reprodukce původního chování je `scratch/appearance-red.log`. Finalni offline regrese capability guardu: **162/162 PASS** v 6 souborech vcetne obecneho `/api/edit` (`scratch/appearance-green.log`).

## Doplnění třetí session: obyčejné editace a paměť

Ordinary edit má vlastní `prompt-edit` run: `change-request`, lidské `change-review`, `commit-request`, jednotlivé `snapshot-request`, schema validation, mesh, compare, lowering a frame. Request zahrnuje transport i dekódování klientské odpovědi, nikoli jen model. Po neúspěšném fetch zůstává failed úsek vedle následného úspěšného fetch; commit není opakován. Ruční mesh retry vytváří samostatný `prompt-detail-retry` run bez inference, včetně failed pokusů. Cache provenance je použita pouze při všech požadovaných meshech z cache. Při zobrazeném originálu se frame obnoveného detailu nedokončí dříve než uživatel zobrazí změněnou větev.

Produkční sada **13/13 PASS**, RTX 3090 / ANGLE D3D11, 156,58 s včetně buildu (`scratch/audit-session3-memory-browser.json`). Obsahuje 25 ordinary shape editací se skutečným mesherem/cache/rendererem, scriptovaným preview/commitem/snapshotem. Dvě různé varianty mají 4860/6348 trojúhelníků; všech 25 vzorků má **7 geometrií, 4 textury a 6 programů**, bez růstu. Objektové wrappery/sockety, runtime, vstup a ruční kamera zůstaly zachované. Artifact `scratch/session3-ordinary-edit-resource-trend.json`. Dvě varianty po úvodním výpočtu používají warm mesh cache; nejde o 25 modelových volání, cold-unique profil, server shape commit gate, JS heap ani VRAM bytes.

Verzovaný development před/po kontrakt je v `holdout-v2/protocol.md`, offline validátor `scripts/reality-compiler-review-protocol.ts` má **18/18 PASS**. Ověřuje vazby artefaktů a konfigurace, lidský záznam potvrzení a úplnost pokusů; neověřuje lidskou identitu ani sémantiku a nespouští inference. Nová živá latence stále **NOT_RUN**.

## Klientské úseky přidané ve druhé session 9. 9. (historický popis)

`window.__worldstreamMetrics.snapshot()` vrací lokální `worldstream-pipeline-v1`: nejvýše 16 běhů × 128 úseků, monotónní browserové časy, explicitní provenance a completed/failed/cancelled. Nedokončené časy jsou null. Neobsahuje texty podkladů, prompty ani credentials a nevstupuje do WorldDoc, hashů nebo replay logu. Nový běh zruší předchozí; přijetí druhé session nesmí dokončit první měření. Historické archivy se nedoplňují zpětně.

- Source request končí přijetím HTTP headers; následuje samostatný parse, kontrola návrhu/hash, lidské review a atomické přijetí. Request zahrnuje server/provider/transport, není to čistý čas modelu. Acceptance zahrnuje lokální kontrolu a sestavení runtime; jeho vnitřní části dosud nemají samostatné lokální úseky. Serverová validace a lowering source návrhu také ještě nejsou rozdělené.
- Prompt odděluje otevření session, čekání na blueprint, lokální validaci, coarse build, lowering a stavbu detailu. `mesh` měří celou lokální detailovou cestu, nikoli jen kernel workeru. Odmítnutí meshe je zaznamenané i při úspěšném coarse fallbacku; cache je označena jen pokud všechny požadované meshe přišly z cache. Nedoložený původ zůstává unknown.
- `first-frame` končí po skutečném `gl.render()` zkontrolovaném v R3F after-effectu pro konkrétní world identity. Jde o dokončené odeslání renderovacího průchodu, nikoli měření GPU scanoutu nebo fyzického displeje.
- `first-interaction` měří čekání na přijatý vstup návštěvníka v kroku, ve kterém bylo spuštěno pravidlo. Samotná metrika nedokazuje příčinnost: ve stejném kroku může působit timeout. Správnost výsledku musí potvrdit runtime oracle/browser test. Čekání na člověka se nesmí přičítat modelové latenci.
- Compare má vlastní lokální běh; restore je cache s validací a replayem. Smoke studie používá virtuální hodiny, takže její metriky nejsou wall-clock benchmark. Druhé modelové dějství a běžný session commit ještě nemají úplnou samostatnou stage instrumentaci.

Lokální optimalizace: source acceptance předává již lowered dokument do schematického rendereru; otisky komponent evidence se nepočítají znovu při každém runtime ticku; deklarace sedmi skupin se počítají jednou na návrh. Změny odstraňují doloženou duplicitní práci. Před/po modelová latence, cold/warm profil a nový nezávislý benchmark jsou stále **NOT_RUN**. Podrobnější evidence-v2 mění výstupní formát; nejde o stejný experiment jako historické evidence-v1.

## Historická výchozí měření

Aktuální doplňkové lokální měření 9. 9.: RTX 3090 / ANGLE D3D11, produkční build, společný Stage na `/dev/worldstream`, reduced motion. Po úvodním warmup detailu všech 25 vzorků při 25 skutečných výměnách obsahovalo 7 geometrií, 4 textury a 6 programů. Baseline = konec, bez růstu těchto počtů. `scratch/dev-stage-resource-trend.json` a celý `scratch/audit-remediation-final-browser.json` (3/3 PASS včetně rendereru a izolace dvou source projektů). Nejde o VRAM bytes, JS heap ani sérii 25 ordinary/modelových editací. Bez inference.

9. 9. 2026, navazuje na historickou sérii `0143dcc9-ea30-4519-ada3-b47ff02bdf5b`. Ta zůstává beze změny: vytvoření medián 126,22 s / p95 180,43 s; editace p95 3,73 s. Nová živá latence dosud **NOT_RUN**.

Nový subscription journal zaznamenává bajty skutečného stdin envelope (včetně mechanických referenceSpans), původního system/user, parsované odpovědi i CLI JSONL transportu. Časy oddělují login preflight, příkaz CLI a parsování; wall time používá monotónní hodiny. `commandMs` zahrnuje i start CLI a jeho transport, není vydáván za čistý čas modelového serveru. Tokeny zůstávají pouze skutečnou provider usage, ne odhadem z bajtů. USD cena předplatného zůstává null.

Nové potvrzení parametrů mění source interakci. Historický automatický live runner proto končí `PARAMETER_REVIEW_REQUIRED` již při vytváření adaptéru, před modelovým voláním, a nevyrábí lidské potvrzení. Offline fixture může potvrzení scriptovat a zůstává pouze integračním důkazem. Před novou živou sérií je nutný verzovaný protokol s odděleným lidským čekáním; stará měření se nepřepisují.

Implementovaná mesh cache je lokální pro jeden klient a rozlišuje celý program, seed, rozlišení a bounds. Má limit 16 MiB / 16 položek, vrací vlastní kopie bufferů a nezapisuje chyby. `cacheHit` označuje opakované použití; `elapsedMs` nadále popisuje původní výpočet, nikoli latenci zásahu do cache. Jednotkový důkaz opakovaného použití není cold/warm měření na cílovém zařízení.

Progresivní cesta staví hrubé sloty až z validovaného kompletního blueprintu a následně doplní worker detail. Zkracuje čekání na meshing před interakcí; neodstraňuje čekání na modelový výstup. Limity kvality a předplatné, model i effort zůstávají zachované.

Dosavadní technická měření nerozdělovala lowering od další validace a neprokazovala GPU present. Tato pole nelze zpětně dopočítat z celkové latence. Samostatný běh pro běžné prompty, profil zařízení a cold/warm mesh zůstávají otevřené. Změna instrumentace sama není tvrzení o zrychlení.

Na žádost uživatele 9. 9. používají lokální Windows grafické testy a launchery RTX 3090 přes ANGLE/D3D11, ověřeno skutečným WebGL rendererem. Finální produkční sada 7/7 PASS. Starší běhy výše používaly SwiftShader na CPU; jejich latence se neslučují s GPU výsledky ani nevydávají za srovnatelný experiment modelové optimalizace. Meshing ve workeru je nadále CPU výpočet.
