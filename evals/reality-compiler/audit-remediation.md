# Audit: stav oprav 9. 9. 2026

## Cgroup worker — pokračování 11. 9. 2026

Basic cgroup actual `83621db4` má nezávislý replay PASS: 26 archivovaných zdrojů, úplných 52 294 B a 11 pidfd ESRCH/prázdný namespace. Opravený systemd actual `f635f0bd` prošel s 30 zdroji a 51 810 B; před START ověřil 2 GiB / swap 0 / tasks 64, private-peer/MainPID generaci a následně vlastní capsule/unit/leaf/run cleanup. Jeho nezávislý replay je PASS (`scratch/session8-systemd-cgroup-actual-replay.json`, SHA `dfcada4da327dfb6e252a41641c814fed4c0c8d819a6861f9c4eddc805eb1aab`). V obou bězích byly všechny čtyři pevné cgroup cesty nepřítomné (ENOENT), bez vytvoření zapisovatelného deskriptoru a bez čtení/zápisu bajtů. To není permission denial, exhaustion ani obecná odolnost vůči všem aliasům. Starší resource fixture s úspěšným write-open zůstává FAIL.

První systemd entry pokus skončil AttributeError ještě před WSL, protože načetl ObservedWire z nesprávného modulu. Původní FAIL i source-review miss zůstaly zachované. Oprava má samostatné review v2 a nový společný běh 231 PASS, včetně skutečné main kompozice s mockem až na posledním dispatch kroku. Historická sada 230 tento problém nezachytila. Evidence: `scratch/session8-basic-cgroup-actual-summary.json`, `scratch/session8-cgroup-systemd-entry-failure-summary-v2.json`, `scratch/session8-systemd-cgroup-actual-summary.json`. Žádný auth/upstream/inference/live před-po kredit. Další oddělená implementace připravuje skutečný fixed subscription upstream connector; produkční default zůstává fail-closed.

## Stock CLI proxy — pokračování 10. 9. 2026

Nový stock CLI CONNECT byl skutečně zachycen a odmítnut lokálním 403 před TLS, nejprve v basic capsule (26 zdrojů, 26 529 úplných output bytes), potom v systemd capsule (30 zdrojů, 26 539 bytes). Oba běhy mají přesných 95 request bytes a 64 refusal bytes, dvě sekvenční vazby socketu na vlastní připnutý CLI proces a ověřený cleanup. Systemd navíc ověřil před START 2 GiB / swap 0 / tasks 64 a odstranění vlastní unit/leaf. Evidence: `scratch/session8-cli-proxy-refusal-actual-summary.json`, `scratch/session8-cli-proxy-systemd-actual-summary.json`. Basic má nezávislý replay, systemd replay právě probíhá. Pozorování holderu není atomický důkaz autora každého bajtu. Žádný TLS, upstream, auth ani model call; produkční default zůstává fail-closed.

Systemd nezávislý replay je také PASS: `scratch/session8-cli-proxy-systemd-actual-replay.json`, SHA `5df3a4c598947e4528e9c994518c3ebc374751968d47e51785c95ea94f492d23`. Zdrojové archivy odpovídaly aktuálním zdrojům v době replay; pozdější změny pro cgroup nedostávají tento runtime kredit.

Širší Python sada má 1000 PASS ve 20 souborech; předcházela poslední změně systemd selectoru, jejíž následná společná sada má 241 PASS ve čtyřech souborech. Překrývající se testy se nesčítají. Nová pevná cgroup write-open sonda má 26 mock PASS a source review, zatím bez runtime integrace. Pokračuje její zapojení za skutečný worker lockdown; úspěšný write-open bude FAIL i při nulovém zápisu. Historické výsledky níže se nepřeznačují.

## Aktuální doplnění osmé session — 10. 9. 2026

Novější basic HTTP capsule (`703df657`) i systemd HTTP capsule (`41476f1b`) mají skutečný PASS s nezávislým replay a archivy 30/37 zdrojů. Aktivace vlastního loopbacku probíhá jen po ověření kernel vlastníka network namespace. Worker prokazatelně dostal EPERM při vytvoření socketu, měl nulový počet connect volání a odlišný network namespace; trusted listener před/po zůstal živý a následná authored HTTP výměna dokončila EOF. Každý běh zachoval všech 53 442 output bytes. Systemd varianta ověřila před START 2 GiB / swap 0 / tasks 64 a vazbu SCM/ACK na vlastní MainPID. Obě mají oddělené capsule a broker cleanup; systemd také odstranění vlastní unit/leaf. Indexy `scratch/session8-http-capsule-stage-actual-summary.json` a `scratch/session8-http-systemd-actual-summary.json` neudělují kredit pro autentizaci, skutečný CLI-issued handshake, inference ani exhaustion.

Dva předchozí Linux HTTP FAIL zůstávají zachované: neúspěšné připojení vlastního klienta a nedostatečně specifický worker report. Staré raw neobsahují nové fáze a nepřeznačují se. Po opravách prošlo 848 společných Python testů v 15 souborech; podsady se nepřičítají. Další konkrétní krok je lokálně odmítnutý stock CLI CONNECT před TLS, nikoli automatické otevření produkčního egressu. Níže je starší průběh této session.

Produkční launcher stále odmítá spuštění před autentizací. Skutečné credential-free basic a systemd průchody nově ověřily předání jediného AF_UNIX FD198, vazbu receiveru na MainPID/generaci, oddělený broker a úklid vlastních procesů, deskriptorů a systemd jednotky. Index `scratch/session8-validation-checkpoint-6.json` uchovává archivované zdroje a nezávislé replay. Tyto průchody nejsou autentizovaný transport ani skutečné app-server volání vybraného workeru.

Následný missing-ACK fault skutečně odeslal jeden deskriptor zastavenému vlastnímu receiveru, neobdržel ACK, po původních pěti sekundách odmítl pokračování a uklidil vlastní jednotku. Původní experiment zůstává FAIL kvůli nesprávnému očekávanému názvu timeoutu; opravený classifier má samostatnou offline revalidaci stejných nezměněných raw dat. Instalace FD receiverem zůstává neznámá. Nejde o nový úspěšný handoff ani důkaz namespace cleanup, protože capsule nezačala.

A8: asynchronní stavové zprávy nyní používají stabilní `role=status` s `aria-atomic=true`, porucha samostatný alert. Nový produkční build v3 a čtyři skutečné browser scénáře PASS, včetně Tab/Enter zrušení a následného vytvoření při 390×844. RTX 3090/D3D11, fixture, 0 modelových volání; vlastní server uklizen a 658 zdrojových/build souborů beze změny. Evidence `scratch/session8-a8-progressive-validation.json`. První pomocný browser pokus selhal před testy a zůstává zachován. Automatizované ověření nenahrazuje lidské použití screenreaderu, sémantické review ani vizuální quality celé sady.

Jednorázový trusted HTTP-CONNECT adaptér měl již před capsule integrací šest skutečných lokálních scénářů PASS a nezávislý replay (`scratch/session8-http-ingress-actual-replay.json`). Pevná normalizace zdrojově doloženého WSS-shaped requestu 97→67 bajtů, skutečně zaplněná 64KiB fronta, cancellation a dvousekundový deadline jsou měřeny odděleně od capsule. První WSL admission FAIL je zachován. Následná integrace je popsána výše. Externí connector, skutečné HTTP/WSS klientské routování a auth provisioning zůstávají otevřené. Živé A6/A7 před/po, úplná A8–A12 AC, nezávislý oracle, lidé a vydání nejsou těmito technickými výsledky splněny.

### Dopln?n? ?est? session: private-path profil v2

Skute?n? CLI na?etl nov? vytvo?en? syntetick? private profil; jeho p??kaz nemohl p?e??st sentinel ani symlink (EACCES), ve?ejn? kontroln? soubor p?e?etl. P??m? kontroly p?ed/po i b??n? read-only baseline sentinel p?e?etly. **V?echny pevn? kontroly PASS**, Python **8/8 PASS**. Raw `scratch/session6-runtime-private-v2.json`, hashe a rozsah `scratch/session6-runtime-private-summary.json`. ??dn? skute?n? auth/session soubory nebyly p?ipojeny ani ?teny. D??v?j?? reporty z?st?vaj? historick?.

Dal?? krok je implementace a odborn? kontrola pevn?ho produk?n?ho dispatcheru se skute?n?mi limity a odd?lenou ??dic?/auth hranic?, pot? produk?n? network/cleanup validace. Synthetic probe ani trusted-caller readiness kontrakt nejsou produk?n? transport. Auth/network/production cleanup st?le NOT_RUN; legacy bridge nep?epojen, live ordinary browser a p?ed/po experiment neprovedeny. A6?A12 z?st?vaj? otev?en?.


## Šestá session 10. 9.: skutečný runtime a oddělené produkční brány

Pevný bezcredential [CLI runtime probe](../../scripts/subscription-runtime-probe.md) poprvé znovu ověřuje konkrétní linuxovou binárku 0.145.0 v oddělené capsule: **4/4 help/version PASS** a finální direct i skutečný CLI syntetický sandbox PASS. Historické setup/missing-bwrap/chroot/UID-map/device/descriptor pokusy zůstávají zachované; aktuální přehled `scratch/session6-runtime-summary-v2.json`. Připnuté hash identity se kontrolují před spuštěním. Nejde o auth/network ani produkční cleanup validaci či obecnou hostile-descendant záruku. Max/model/low/produkční limity zachovány, žádná inference.

Source a nový ordinary provider-only seam mají striktní produkční readiness gate; provider-only výsledek nemá browser či lidský kredit. Společná cílená regrese **202 PASS / 0 FAIL / 1 symlink SKIP**, TypeScript PASS. Následné skutečné browser cancellation smoke **2/2 PASS**, source 3 a prepared 5 scénářů; server i kontexty uklizené. [Přesný protokol a omezení](holdout-v2/protocol.md).

A12 přidal úplný manifest HEAD/index/nonignored untracked souborů včetně missing/deleted/link stavů, dvou kontrol bytes a stability Git enumerace. **11/11 unit PASS**; mezilehlý snapshot **856/856 files** obsahoval i vlastní vygenerovaný Python bytecode, který byl následně odstraněn a test už jej nevytváří. Finální manifest je uveden v `scratch/session6-final-validation.json`. Snapshot není historický build/run hash a nezahrnuje ignorované plány, scratch ani credential stores. Disclosure aktuálních **565 zdrojů / 0 nálezů**. A6–A12 zůstávají otevřené podle úplných AC; živé před/po, nezávislé review/pět lidí a release nejsou nahrazeny technickými testy.

Offline submission checker nejprve selhal na finálním videu, registraci a zastaralém požadavku na doslovnou legacy garanci. Poslední technická vada opravena současným lexikálním source disclosure kontraktem; důkaz čísel vůči deklarovaným reportům zachován. Úplná cílená regrese **95/95 PASS**, skutečný aktuální check4 PASS. Full offline checker nebyl po této opravě opakován; ostatní brány nejsou tímto dílčím PASS uzavřené.

Výchozí revize `4f48963`. Mapování osmi nálezů tabulky 4 auditu ze 7. 9.; historické řádky ani výsledky neměníme. Čtení kódu není ruční UX review a scriptovaný browserový transport není živá AI.

## Pátá session: neblokující vstup a integrita podkladů

A11 fixed-DUMMY supervisor nyní předává vstup neblokujícím selector loopem, po nejvýše 4 KiB. Plná pipe nezastaví cancel, EOF, lease ani absolutní deadline. Terminal eviduje celkové, předané a zbývající bajty; TS adaptér odmítá nesouhlasící součty a neuzavřený vstup. Bez spuštěného dítěte je vstup uzavřený. Skutečná WSL matice **14/14 PASS** (`scratch/subscription-wsl-supervisor/7fc11fc3-bbdb-4733-afce-e6d7d71cafa5/report.json`) a následný nový fault ihned po Popen **1/1 PASS** (`e0d73a2c-5651-464d-8211-eec23add0bc9/report.json`); jde o dva oddělené běhy. Fault skončil `supervisor_error`, exit 1, sledované PID ESRCH a input 69/0/69 bajtů, closed=true. Žádný externí harness cleanup.

Samostatný TS adaptér prošel **3/3 skutečnými WSL testy** (`scratch/session5-typed-wsl.json`): normal, cancel detached procesu a cancel při plném stdin. Poslední případ měl 24 KiB vstupu, 4 KiB předané a 20 KiB pending; výsledek `cancelled/verified`, local close 0. Produkční CLI, jeho auth/network/filesystem profil a produkční timeouty zůstávají nedotčené a neověřené tímto dummy experimentem. Review nezjistilo další materiální vadu; požadovaná mezera partial-setup cleanup má výše uvedený skutečný fault důkaz.

A6/A9 mají konkrétní omezenou filesystem čtečku experimentálních podkladů, zapojenou do source smoke. Odmítá traversal, Windows device/ADS aliasy, symlinky/junctions i neobyčejné soubory; kontroluje velikost a identitu a kopíruje bajty. Cílené reader/protocol/runner testy **81 PASS / 1 SKIP**; OS nepovolil vytvoření file symlinku, skutečné junction testy proběhly. Není to atomický OS sandbox: chráněný kořen a strom zůstávají předpokladem, hardlinky a nepřátelský souběžný swap-and-restore nejsou touto kontrolou vyloučené.

A6 ordinary prompt má nyní samostatný recorder skutečného prepared POST/GET/SSE a UI, s blokací live dějství a samostatným fixture formátem. Browser **1/1 PASS** se čtyřmi scénáři, včetně skutečného input/rule trace; source smoke s novým readerem také **1/1 PASS**. Přesné reporty, zařízení, raw/nezachycené fáze a pořadí posledních unit-only deadline/cancellation oprav uvádí [protokol](holdout-v2/protocol.md). Společná finální cílená regrese **158 PASS / 0 FAIL / 1 SKIP**, TypeScript PASS, disclosure inventura **559 zdrojů / 0 nálezů**. Žádná inference, lidské pozorování, publikace ani změna produkčního transportu.

## Čtvrtá session: pravdivý scope legacy motion

Public preview již neslibuje neimplementované `entity.motion`. Je-li vedle něho platný tvar, nabízí explicitně **Only the shape … Behavior stays unchanged**, ukládá nulový behavior scope a commit vrací tentýž schválený popis. Motion-only a dříve uložený mixed motion commit jsou 422 `MOTION_UNSUPPORTED`, bez změny blueprintu, revize či spotřebování preview. Historické assets ani generický `/api/edit` se nemění. Prompt také zakazuje tento neimplementovaný field; skutečnou ochranu tvoří capability guard.

RED3/3 (`scratch/session4-motion-red.log`) → relevantní HTTP/model/generic edit **270/270 PASS** (`session4-capability-regression2.json`), doplňkové guard/route **21/21 PASS** (`session4-motion-final2.json`). Nezávislé review nalezlo copy/move ze staged hodnoty a copy z pole; oba helper bypassy reprodukovány RED (`session4-motion-bypass-red.json`) a opraveny sekvenčním cloned draftem se stávající pointer validací. Zůstává původní finální patch gate. První green pokus zachytil neplatný typ `from`, první doplňkový route pokus nesprávně adresoval semantic ID místo sim entity; oba neúspěchy zachovány a opraveny.

Produkční GPU **9/9 PASS** (`scratch/session4-motion-browser.json`), RTX3090/D3D11, TypeScript PASS. Reálný c03 preview výslovně ukazuje shape-only omezení a commit následně mění skutečný mesh bez fallback/recovery. Dřívější otevřený legacy nález níže je touto opravou překonán; houpání samotné se neimplementovalo ani necertifikuje.

## Třetí implementační session: obnova detailu a ordinary editace

Nová produkční série `scratch/audit-session3-memory-browser.json`: **13/13 PASS**, 156,58 s včetně buildu, skutečná RTX 3090 / ANGLE D3D11. Předchozí dílčí sady 10/10 a 12/12 také PASS. Nové důkazy:

- Ruční retry detailu již přijaté revize opakuje jen lokální meshing. Opakovaný worker transport fault zachová funkční hrubý svět a porovnání; po úspěchu se změní podoba při zachování wrapper UUID, ticku a výsledků obou větví. V celé posloupnosti zůstává jediný commit a jediný GET snapshotu.
- Retry během zobrazeného originálu nemění zvolenou větev. Nový detail čeká v changedWorld a jeho frame metrika skončí až po skutečném zobrazení změněné větve. Pozdní detail nemůže přepsat novou generation.
- Ordinary edit má vlastní request, human review, commit, jednotlivé snapshot pokusy, validation, mesh, compare, lowering a frame. Failed fetch je zachovaný vedle následného úspěšného fetch. Každý detail retry je samostatný run bez inference; zaznamenají se i neúspěšné pokusy. Cache se uvádí jen při všech mesh požadavcích obsloužených z cache.
- 25 skutečných změn tvaru na hlavní page: rozdílné podoby mají 4860/6348 trojúhelníků, wrappery/sockety, nenulový paused runtime, zaznamenaný vstup a ruční kamera zachovány. Všech 25 vzorků má 7 geometrií, 4 textury a 6 programů. `scratch/session3-ordinary-edit-resource-trend.json`. Jde o scripted preview/commit/snapshot a skutečný browser mesher/reconcile; dvě varianty používají warm cache. Není to měření VRAM bytes, server shape commit gate ani modelových editací.

Nový nalezený problém: public Worldstream přijímal look-only operace, ale ProxyWorld nepřenáší look do rendereru a Stage používá výchozí harbor. Opraveno výslovným 422 `APPEARANCE_UNSUPPORTED` na preview i commitu, včetně archived/stored/mixed operací a chybně zařazeného `/look` pod behavior. Reprodukce **RED 3/3 → 162/162 PASS**, obecný `/api/edit` zachován. Samotné zachování identity není důkaz vykreslené změny vzhledu; podporovaný Worldstream rozsah jsou shapes a validované behavior změny.

Otevřený legacy nález při závěrečné kontrole fixture: authored c03/r15 popisem slibuje houpání a přidává `entity.motion.kind:sway`, ale runtime lowering toto pole nečte. Platný shape commit proto nedokazuje houpání. Archiv se nepřepisuje; navazující práce musí tento nepodporovaný behavior slib výslovně odmítnout nebo omezit public preview/commit summary. Browser regrese c03 kontroluje pouze skutečnou změnu tvaru. Jeho disabled Pause znamená již ukončený runtime (`endedAtTick`), nikoli důkaz chybějící či nevalidní simulace.

Serverové timing hranice source/prompt/preview/commit: **313/313 PASS**. Následná skutečná route reprodukce unexpected background rejection opravena **RED → 73/73 PASS**, se zachovaným error identity a vrácením slotů. Finální plná unit regrese **4768 PASS / 0 FAIL / 1 skipped** (`scratch/audit-session3-final-unit.json`); první run zachoval RED reprodukci 4767 PASS / 1 FAIL / 1 skipped. Historické generované eval soubory obnoveny byte-for-byte.

A11 Node/Chromium procesní sada **37/37 PASS**; izolovaný WSL GNU timeout PASS. První přímý wrapper experiment **FAIL / REMOTE UNKNOWN** před markerem, druhý **FAIL_DESCENDANTS_SURVIVED_WRAPPER_ABORT**: po lokálním abortu obě linuxová PID existovala i po 2 s, až harness cleanup prokázal ESRCH. PID probe nerozlišuje běžící proces a zombie; skutečné CLI nebylo spuštěno. Report `scratch/subscription-wsl-fault/f3b62974-ec62-4551-a8aa-6630feabd0f7/report.json`, návrh opravy v `submission-readiness.md`. Výsledky cleanupu se nepřipisují wrapper abortu.

Závěrečné browserové důkazy třetí session: `scratch/session3-browser-summary.json` eviduje **50 různých prošlých scénářů** v navazujících bězích. Poslední `scratch/audit-session3-final-browser-shape-proof.json` je **9/9 PASS**, 152,33 s včetně produkčního buildu na RTX 3090 / D3D11. Shape commit i held race kontrolují odpověď COMMITTED, skutečně změněnou representationId, nenulový mesh a absenci fallback/recovery. Stop detailu má zvlášť c03 static shape edit a c01 paused runtime/vstup/UUID. Předchozí 30 PASS / 1 FAIL a 20 PASS / 1 FAIL se nemažou: opravena chybná domněnka aktivního runtime v c03, staré palette-only očekávání a názvy akce/výstupu v testu. Celé širší regrese nebyly po každé čistě testové opravě zbytečně opakovány. TypeScript a diff-check PASS. Manifest 496 současných zdrojů a vybraných build configů je `scratch/session3-worktree-manifest.json`, ne zpětný hash historických běhů.

## Stav po druhé implementační session (historický checkpoint)

| Nález | Aktuální stav a důkaz |
|---|---|
| Chybějící simulace | Opraveno pro pilot: aktuální runtime/source browserové průchody a širší regrese 1399/1399. |
| Chybějící vstup a čas | Opraveno pro pilot: skutečné vstupy, pause, fork a společný log; ruční kamera zachována. |
| Editace přestaví celý svět | Opraveno: reconcile registry a reálné UUID; editace a detail zachovávají runtime i kameru. |
| Materializace čeká na kompletní meshing | Opraveno: validovaný coarse běží před zadrženým workerem; renderer callback dokládá skutečný render pass. |
| Nejbližší uložený svět bez prahu relevance | Neověřená relevance zůstává otevřená; approximate/nearest je přiznané, není vydáváno za splnění nového zadání. |
| Skrytý původ přesné ukázky | Opraveno a browserově ověřeno na ordinary/source/second-act cestách. |
| Session Map není persistence | Source Save/Restore ověřeno včetně v1/v2 a obou větví; ordinary session zůstává procesová. Skutečný produkční restart PASS: stará session 404 UNKNOWN_SESSION, nová má jiné ID a validní runtime. UI vysvětluje restart/expiraci. |
| Úspěšný commit + selhání zobrazení | Opraveno pro fetch a revizi: retry bez druhého commitu, 404/wrong revision/new generation v aktuální browserové sadě. Nová browserová fault reprodukce po přijatém commitu PASS: skutečná worker transport chyba při cache miss zachová přijatou větev, runtime a wrapper UUID; přiznaný semantic-clay fallback, pouze jeden commit a snapshot. Fallback není resync ani důkaz skutečného selhání GPU výpočtu. |

Nová funkčnost: samostatné user supplements, komponentová evidence-v2 s kontrolou selectorů a otisků, zachovaná historická v1 obnova. Podpora skutečné timer akce se při intervenci mění odděleně od podmínek. Nový browserový test ověřil celý tok supplement → review → Why → intervention → save/reload. Citace zůstávají unchecked; scriptované fixture nejsou sémantická evidence.

Aktuální produkční regrese **35/35 PASS na RTX 3090**, 2,9 min včetně buildu, ověřila i oddělení review/request/frame/input metrik, úzké okno, nové resync fault větve a správné ukončení metrik předchozí session při second-act adopci. Předchozí běh **32 PASS / 1 FAIL** narazil na chybný testový předpoklad: textarea normalizuje CRLF před odesláním. Test nyní porovnává skutečně odeslané bytes; přímá HTTP a storage cesta CRLF zachovává. Oba výsledky zůstávají zaznamenané.

Inspekce desktopového a mobilního snímku potvrdila snížení překryvu přesunem runtime do vlastního sloupce. První diagramové rámování ještě na mobilu část scény překrývalo; bezpečný horní prostor byl zpřesněn. Následná produkční sada **32/32 PASS na RTX 3090**, 3 min včetně buildu: source/evidence, runtime, progressive, hot-swap a quality. Ověřeny skutečné snímky 1280×720 a 390×844; všechny projektované středy objektů na mobilu nad ovládáním. Jde o technickou vizuální kontrolu, nikoli test užitečnosti s člověkem.

Aktuální připravené studijní karty **A i B PASS (1/1 každá)** s evidence-v2 a scriptovaným potvrzením parametrů, `humanObservation:false`. Produkční restart **1/1 PASS**, report `scratch/session-restart/65f903aa-b01d-4b70-b197-687435bb979f/report.json`; test zastavil pouze vlastní proces a ověřil jeho exit před novým startem. Žádný z těchto běhů nevolal model.

Lokální měření kontraktu s jedinou změnou (model negeneruje binding IDs): v označeném muzeálním vzorku **23 bindingů, 2659 → 2094 UTF-8 bytes**, schema bindingu **665 → 581 bytes**. `contract-size.measure.ts` je offline experiment, 0 model calls; neprokazuje zrychlení modelu ani celého promptu vůči historické v1. Wrapper navíc počítá referenceSpans každého supplementu odděleně; no-supplement prompt zůstává byte-identický. Poslední cílené sady 71/71 a 21/21 PASS.

Závěrečná produkční source/branch/renderer sada **24/24 PASS**, 3 min včetně buildu. Dodatečné review našlo dva HTTP → React problémy: malformed evidence bindings v návrhu a objekt místo textové otázky v clarification. Oba formáty se validují před publikací React stavu; skutečný browser ověřil žádnou pageerror, zachovaný přijatý projekt a nadále funkční vstup/Why. Commit dál nezávisle ověřuje hash a oporu. Nový worker fault po přijetí prošel se skutečným cache miss, jednou chybou `postMessage`, správným porovnáním alarmu a zachovaným UUID; bez druhého commitu.

Kontrola AC uzavřela **A1–A3 a A5**. A4 má doslovně ještě požadavek ručního retry detailu po mesh chybě: dnešní validní, přiznaný clay fallback svět zachová, ale samostatné retry detailu nenabízí. Fetch recovery a skutečný restart jsou doložené. A5 poslední regrese přijala dva různé source projekty po sobě: jiný source/evidence hash a revize, nový runtime bez původního timeru a vstupů, žádný cizí Why trace, nové rámování po ručně změněné kameře.

Závěrečná cílená GPU sada **3/3 PASS**, 1,5 min včetně buildu, strojový report `scratch/audit-remediation-final-browser.json`: renderer RTX 3090/D3D11, dva zdroje, 25 výměn detailu. Resource trend: všech 25 vzorků stejných **7 geometrií / 4 textury / 6 programů**, baseline = konec; `scratch/dev-stage-resource-trend.json`. Jde o skutečnou výměnu detailu ve společném Stage na `/dev/worldstream`, počty renderer resources, nikoli VRAM bytes nebo 25 ordinary modelových editací. První samostatný běh stejné resource regrese také PASS (2/2 s rendererem), ale list reporter neuchoval body attachment; další běh proto ukládá JSON report.

## Výchozí stav před opravami (historie)

| Nález | Stav před opravami | Cesta a důkaz | Navazuje |
|---|---|---|---|
| Chybějící simulace | Opraveno v kódu, browserová regrese probíhá | `page.tsx` drží RuntimeController; Canvas → RuntimeStage → Stage promítá skutečné entity. | A1 |
| Chybějící vstup a čas | Částečně opraveno | RuntimeInteraction a BranchComparison jsou na `/`. FrameCamera stále přepisuje kameru při každém runtime snapshotu; ruční kamera chybí. | A5 |
| Editace přestaví celý svět | Reprodukováno čtením referenčního toku | `apply` volá buildProxyWorldFrom, setWorld; Stage useMemo(buildStage, [world,palette]) vytvoří celý registry. Sim stav při vzhledové editaci je již zachováván samostatně. | A5 |
| Materializace čeká na kompletní meshing | Reprodukováno čtením async toku | `buildProxyWorldFrom` awaituje meshDownTheLadder; Canvas nepředává upgrade. Source pilot používá okamžitou schematickou geometrii. | A8 |
| Nejbližší uložený svět bez prahu relevance | Dosud neověřeno browserem | Oddělit přesnou připravenou ukázku od nearest a živé generace; samotný hotový obraz neprokazuje splnění zadání. | A8 |
| Skrytý původ přesné ukázky | Nutná aktuální browserová regrese | Ověřit stálý popisek prepared/exact/nearest/live při výměně světů i dalších editacích. | A8 |
| Session Map není persistence | Potvrzeno, sdílený veřejný provoz mimo lokální rozsah | `sessions.ts` module Map; restart ztrácí session. Lokální source projekt zatím zaniká reloadem. | A4, A11 |
| Úspěšný commit + selhání fetch/meshing | Reprodukováno čtením chybové větve | `page.tsx apply`: po commitChange následuje readBlueprint/build; jejich chyba nastaví `refused`, bez evidence již přijaté revize a resync. | A4 |

## Nová oprava pilotu

SourcePanel před změnou přijímá `kind: proposed` bez lidské kontroly parametrů. `commitInitial` kontroluje svět a citace, ale ne potvrzení parametrů. Není to detektor správného významu: stejný existující browserový fixture váže všechny muzejní akce pouze na větu o délce timeru. Nové potvrzení nesmí takovému fixture vyrábět semantické PASS.

## Ověření

- Výchozí produkční browserová sada: **22/22 PASS**, 8,2 min; reality-compiler runtime, interaction, evidence, branch, second-act a worldstream-main-path. První sandboxový pokus skončil `spawn EPERM`, opakování použilo povolené lokální spuštění.
- První změna A2: **72/72 cílených unit/HTTP testů PASS**, TypeScript PASS. Potvrzení sedmi oblastí je povinné v atomickém commitu, SHA-256 váže přesné source snapshoty, sim a evidence. Model nemůže potvrzení dodat přes source HTTP tělo. Chybějící explicitní action duration se nezamění za kapacitu timeru.
- Historický živý runner nyní končí s `PARAMETER_REVIEW_REQUIRED` již při vytváření adaptéru před inferencí; nesmí automaticky vyplnit lidské potvrzení ani vydávat starý protokol za nový benchmark. Offline fixture může kontrolu scriptovat, což není sémantický důkaz. Guided subscription demo čeká na skutečné potvrzení v prohlížeči.
- Živá inference ani historické měřicí sady nebyly spuštěny.

## Další implementace a ověření

- Session resync: reprodukce na předchozím buildu RED (chybělo `change-recovery`); aktuální build GREEN, 1/1 browserový test. Přijatá revize se zachová, retry pouze načítá a staví zobrazení, počet commitů zůstává 1. Doplňkové selhání testu bylo očekávání ticků v UI, které správně ukazuje `20s → 10s`.
- Source potvrzení: browserová kontrola missing/conflict byla blokovaná správně; test původně našel i Next route announcer přes neomezené `getByRole('alert')`. Locator je nyní omezený na review panel. Zůstává k opakovanému ověření s aktuálními změnami.
- Source persistence: lokální verzovaný JSON má strop 2 MB, dvě větve a ohraničený log. Restore nezávisle znovu přijme svět/evidence, zrekonstruuje intervenci a porovná revizi i stav s replayem. Před publikací obnovy nic nemění na aktivním projektu. 38/38 storage + commit testů a TypeScript PASS.
- Render: Stage má jeden registry po dobu světa; reconcile vymění pouze rozdílné podoby, obaly a existující sockety zachová. Nové diagnostické UUID měří skutečné objekty. 62/62 reconcile/representation/dispose/storage testů PASS. Browserová sada s kamerou, reloadem, hot-swapem a quality aktuálně probíhá.
- Kamera: ruční orbit/zoom/pan přes již instalované Three controls, explicitní Frame scene. Runtime snapshot již sám nepřepočítává bounds ani nevrací kameru zpět. Nový zdroj/session se stále rámuje.

Tyto výsledky jsou technické regrese. Nepředstavují nové živé modelové měření, potvrzení významu zdroje ani test pěti lidí.

## Integrační kontrola po doplnění cache a progresivní cesty

- Cílená sada cache / journal / source / commit / storage: **122/122 PASS**. Následující TypeScript zachytil přetížení `Worker.postMessage` v novém browserovém testu; opraveno pro obě podporované signatury, následný TypeScript PASS.
- Produkční browserová sada s jedním workerem: **14 PASS / 2 FAIL**, 10,9 min. Prošly: resync s jediným commitem, odmítnutí a stale input, review missing/conflict, reload obou větví, corrupt/quota storage, pozdní source odpověď, kamera a skutečné UUID, runtime pohyb a progresivní detail se zadrženým workerem.
- Jeden FAIL byl poslední chybný pevný tick v testu návratu ke změněné větvi: zadaný horizont 342, test očekával 329. Očekávání sjednoceno se skutečně zadaným horizontem; produktová sémantika se nemění. Druhý FAIL nastal při screenshotu po úspěšných kontrolách source/Why; celkový test má nově 90 s kvůli přidanému review průchodu. Výkonnostní prahy produktu se nezvyšují. Oba případy se samostatně opakují.
- Předchozí grafická sada měla navíc timeout hot-swapu a překročení mesh budgetu při souběžném SwiftShader zatížení; bez nového sériového ověření je nelze označit za vyřešené.
- Ruční pohled na aktuální `scratch/reality-compiler-runtime.png`: ovládání a původ jsou čitelné, ale panel překrývá velkou část scény. A8 vizuální zjednodušení a malé okno zůstávají otevřené; screenshot není lidská studie.
- Doplněna ochrana fronty i pro synchronní chybu konstruktoru/postMessage a test, že pozdní výsledek po dispose neoživí cache. Širší jednotková regrese aktuálně probíhá.

## Starší checkpoint a tehdy otevřené položky

### Závěrečné technické ověření a změna rendereru

Širší jednotková regrese: **1339/1339 PASS** (`scratch/audit-remediation-unit.json`), worker filtr **31 PASS / 25 mimo filtr**, TypeScript PASS. Historické eval reporty nebyly přepsány.

Na výslovný požadavek uživatele přepnuto lokální Windows vykreslování na hardware. Přímá sonda i browserový test ověřily `ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 (0x00002204) Direct3D11 vs_5_0 ps_5_0, D3D11)`, 24 GiB VRAM. Společné `scripts/browser-renderer.ts` používá D3D11 v lokálním Windows Playwrightu, subscription demu a studijním launcheru; CI a explicitní `E2E_RENDERER=software` zachovávají softwarovou variantu. Build, TypeScript a CPU mesher se na GPU nepřepisovaly.

Finální produkční GPU sada: **7/7 PASS**, 1,8 min včetně buildu. Ověřena identita rendereru, opravený návrat obou větví, celý source/Why včetně screenshotu, kamera/runtime identity, jemnější detail stejného objektu, progresivní interakce před detailem a plně funkční safe quality. Dříve selhané grafické scénáře nyní procházejí na cílovém GPU bez zvýšení mesh budgetů.

Poslední software běh byl na požadavek uživatele ukončen a nahrazen GPU během. Před ukončením prošly opravené branch/source/runtime a progressive testy, hot-swap selhal; celek proto není PASS. GPU úspěch nemaže tento neúspěch a není důkazem dosažení stejných časů na SwiftShaderu. Přímý důkaz GPU je v Playwright attachmentu `renderer.json`; screenshoty jsou lokální technické artefakty, nikoli lidská studie.

1. A2/A3: samostatně evidované uživatelské doplnění a dohledatelná opora jednotlivých podmínek/akcí. Současné potvrzení je konzervativní lidská kontrola skupin, nikoli detektor významu.
2. A4/A5: doplnit browserové fault pokrytí selhání meshingu po commitu, nové generation během obnovy a restartu session serveru; obecné Map sessions nejsou persistence.
3. A6/A7: stage telemetry až k první interakci a nový řízený experiment kritické generovací cesty. Žádné doložené nové modelové zrychlení.
4. A8: méně překryvného UI, malé okno a paměťový/frame-time trend na zapsaném zařízení. Uživatelské zastavení lokálního čekání je doplněno a ověřeno níže; ukončení vzdáleného modelového procesu tím není garantované.
5. A9/A10: nový verzovaný interaktivní měřicí protokol, nezávislý autor holdoutu/oraclu, skutečný hodnotitel a pět lidí. Materiál v `holdout-v2/README.md` je příprava, nikoli zmražená nezávislá sada.
6. A11/A12: ops fault/restart kontroly, veřejná varianta, video a chybějící registrační údaje. Nic publikováno ani odesláno.

## Navazující dokončení zrušení čekání

Po GPU přepnutí implementováno `Stop waiting` pro první svět/detail i druhou modelovou verzi a `Stop waiting for source`. Odpojí lokální fetch a mesh úlohy, zneplatní pozdní odpovědi a zachová zobrazenou scénu/přijatý source projekt. Další editace zachovaného coarse světa dostává nový AbortSignal; nesmí zůstat trvale zrušená. Nelze tím rušit právě probíhající commit. UI pravdivě uvádí, že vzdálený modelový request může ještě doběhnout.

Poslední produkční sada na ověřené RTX 3090: **17/17 PASS**, 3,8 min včetně buildu. Zahrnuje celý source/evidence/reload tok, výměny druhého světa, progressive detail a oba nové cancellation testy. Source test ověřuje skutečný `requestfailed` po abortu a zachovanou projectRevision; mesh test provede reálnou následnou vzhledovou editaci při zachovaném ticku. Společné nastavení rendereru navíc **3/3 unit PASS**, TypeScript prošel samostatně i následným produkčním buildem. Ručně prohlédnutý aktuální source screenshot potvrzuje čitelné oddělení support/intervention/review, ale také velký překryv scény panelem, který zůstává k úpravě.
