# T13 — předání lokální varianty, 8. 9. 2026

## Cgroup runtime — 11. 9. 2026

Basic cgroup actual/replay PASS; nový opravený systemd actual a nezávislý replay také PASS (`scratch/session8-systemd-cgroup-actual-replay.json`). Čtyři pevné write-open cesty jsou v obou případech ENOENT/absent, nikoli odmítnutí oprávněním. Žádný cgroup byte read/write. Basic26/systemd30 zdrojů, úplné52294/51810 B a oddělený vlastní cleanup; systemd před START2GiB0/64 a private-peer/MainPID binding. První systemd vstupní AttributeError před WSL zůstává zachovaný FAIL, opravená kompozice má nové review a231 PASS. Summary `scratch/session8-basic-cgroup-actual-summary.json`, `scratch/session8-systemd-cgroup-actual-summary.json`. Candidate exhaustion, auth, externí TLS/upstream, inference, skutečná app-server worker invocation a release stále nejsou ověřené. Nový upstream connector se implementuje samostatně, default zůstává fail-closed. Následující starší odstavce zachycují předchozí průběh, nikoli aktuální status těchto běhů.

## Novější stock CLI ověření — 10. 9. 2026

Basic i systemd capsule skutečně zachytily stock CLI CONNECT (95 B) a lokálně odpověděly 403 (64 B) před TLS. Source archivy 26/30 a úplné raw output 26 529/26 539 B odpovídají běhům; vlastní cleanup prošel. Basic má nezávislý replay, systemd replay probíhá. Systemd readback 2 GiB / swap 0 / tasks 64 předcházel startu. Dvě sekvenční socket-holder pozorování nejsou atomická attestace autorství. Důkazy: `scratch/session8-cli-proxy-refusal-actual-summary.json`, `scratch/session8-cli-proxy-systemd-actual-summary.json`. Žádný TLS/upstream/auth/inference, candidate exhaustion ani release kredit. Produkční launcher zůstává `SUBSCRIPTION_PRODUCTION_NOT_VALIDATED`; následuje worker cgroup integration. Níže zůstává historický průběh.

## Aktuální technický stav — osmá session 10. 9. 2026

Credential-free HTTP cesta nově prošla skutečně v basic i systemd capsule, se source archivy 30/37 a nezávislým replay. Listener zůstal živý přes worker sondu; ta doložila odmítnutí vytvoření socketu, nikoli provedený connect. Následný authored HTTP přenos a oddělené cleanup domény prošly, systemd také předdispatch readback 2 GiB / swap 0 / tasks 64 a SCM/ACK binding. Předchozí dva Linux FAIL se zachovaly; širší Python regrese má 848 PASS. Tato výsledková sada nepovoluje produkční launcher a nenahrazuje stock CLI proxy handshake, auth, inference, exhaustion nebo živý před/po experiment.

Default launcher odmítá `SUBSCRIPTION_PRODUCTION_NOT_VALIDATED` před loginem/spawn. Nově ověřený post-CLI seccomp worker, UTS izolace, fixed app-server metadata se statickým katalogem a authored OS protocol fixture zlepšují implementaci, ale produkční autentizovaná hranice zůstává nevalidovaná. Skutečný CLI nedostal turn/start ani auth/account RPC. Jeho automatický startup websocket byl pozorován a odmítnut OS chybou EPERM; metadata proto nejsou důkaz síťové nečinnosti. Explicitní produkční network experiment, inference a live před/po měření zůstávají NOT_RUN.

Native browser ověřil opravu mesh worker messageerror a obnovu fronty; tento starší build má receipt `scratch/session8-product-build-receipt-v2.json`. Nový build v3 (`scratch/session8-product-build-receipt-v3.json`) ověřuje také stabilní přístupná stavová hlášení: čtyři progressive scénáře PASS, včetně klávesnice při 390×844, skutečná RTX 3090/D3D11, fixture/0 modelových volání a vlastní server cleanup (`scratch/session8-a8-progressive-validation.json`). Plné aktuální důkazy a chronologie jsou v `PROJECT-STATUS.md` a plánu 19. Historické výsledky níže se nepřeznačují za současné. Finální video, registrační údaje, nezávislí hodnotitelé/lidé a veřejný release zůstávají MISSING/NOT_RUN. Neproběhl commit, publikace ani odeslání.

### Dopln?n? ?est? session: private-path profil v2

Skute?n? CLI na?etl nov? vytvo?en? syntetick? private profil; jeho p??kaz nemohl p?e??st sentinel ani symlink (EACCES), ve?ejn? kontroln? soubor p?e?etl. P??m? kontroly p?ed/po i b??n? read-only baseline sentinel p?e?etly. **V?echny pevn? kontroly PASS**, Python **8/8 PASS**. Raw `scratch/session6-runtime-private-v2.json`, hashe a rozsah `scratch/session6-runtime-private-summary.json`. ??dn? skute?n? auth/session soubory nebyly p?ipojeny ani ?teny. D??v?j?? reporty z?st?vaj? historick?.

Dal?? krok je implementace a odborn? kontrola pevn?ho produk?n?ho dispatcheru se skute?n?mi limity a odd?lenou ??dic?/auth hranic?, pot? produk?n? network/cleanup validace. Synthetic probe ani trusted-caller readiness kontrakt nejsou produk?n? transport. Auth/network/production cleanup st?le NOT_RUN; legacy bridge nep?epojen, live ordinary browser a p?ed/po experiment neprovedeny. A6?A12 z?st?vaj? otev?en?.


## Aktualizace šesté auditní session 10. 9. 2026

Lokální produkční CLI profil není připraven k novému benchmarku: [izolovaný skutečný runtime probe](../../scripts/subscription-runtime-probe.md) má help/version **4/4 PASS** a po zachovaných selháních také fixed synthetic CLI sandbox PASS. Auth/network/production cleanup zůstávají NOT_RUN. Source a ordinary provider-only seams tuto neúplnou readiness odmítají; legacy produkční bridge nebyl přepojen. Max/model/low a limity beze změny, žádný API fallback.

Nový `scripts/reality-compiler-worktree-manifest.ts` zachycuje všechny HEAD/index tracked a nonignored untracked soubory, nikoli jen předchozí výběr zdrojů. Evidence **11/11 unit PASS**; finální počty a odkaz jsou v `scratch/session6-final-validation.json`. Manifest je aktuální lokální snapshot; není historický build ani test-run hash, nezahrnuje ignorované interní dokumenty/scratch a nevytváří veřejné zmrazení. Po další změně souborů je třeba vytvořit nový UUID artefakt.

Offline checker před opravou zaznamenal video/category/legacy-description FAIL, disclosure/blind PASS a síťové SKIP (`scratch/session6-submission-check-retry.log`). Legacy description gate byla opravena bez návratu nepravdivého příslibu: **95/95 unit PASS**, aktuální popis/reporty v samostatné check4 PASS. Není to nový plný submission PASS; finální video a registrační údaj zůstávají chybějící.

Browser source/prepared timeout/cancel ověření prošlo a vlastní server byl ukončen. Disclosure **565 zdrojů / 0 nálezů**. Finální live video, nezávislý oracle/review, pět lidí, veřejné URL a oprávnění zůstávají MISSING/NOT_RUN. Žádný commit, staging, publikace nebo odeslání neproběhly.

**Předávaný rozsah: vlastní lokální Reality Compiler demo explicitně úplných krátkých procedur přes předplatné Codexu. Soutěžní přihláška ani veřejný release nejsou dokončené.** Rozhodnutí T12 je [ZÚŽIT](decision.md), lidský signál zůstává INCONCLUSIVE; chybějící evidence není převedena na PASS.

## Kontrola všech položek plánu předání

Aktualizace třetí auditní session 9. 9.: doplňkové [připravené video](prepared-video.md) má 45,32 s, bez střihu, trvalé označení fixture/scripted/virtual clock/0 model calls a manifest s SHA-256. Není to `video/final.mp4`, živá generace ani lidská studie. [Návrh jednoho serverového procesu](../../ops/worldstream-single-process.md) je konkrétní provozní návrh ve stavu NOT_DEPLOYED. README a popis nyní uvádějí skutečné source limity, review, persistence a historickou end-to-end latenci.

Plná unit regrese **4768 PASS / 0 FAIL / 1 skipped**, TypeScript PASS. License gate **7/7 PASS** v rozsahu 783 indexovaných cest. Samostatná inventura aktuálních 542 zdrojových souborů včetně nových neindexovaných souborů nemá po doplnění pěti testových cest žádný disclosure nález (`scratch/session3-disclosure-scan.json`). Poslední celý offline submission checker před těmito opravami měl 4 neúspěšné brány: finální video, historickou doslovnou garanci, registrační focus a dva tehdy chybějící disclosure zápisy. Disclosure bylo cíleně opraveno a znovu prověřeno; celý checker se poté neopakoval. Ostatní tři mezery a přeskočené síťové kontroly zůstávají otevřené. Žádná publikace ani inference.

| Položka | Stav a konkrétní evidence |
|---|---|
| Veřejná URL v čistém browseru | MISSING. Lokální localhost a řízené Chromium nejsou veřejná URL. Síťové kontroly nebyly provedeny. |
| Aktuální submission manifest | Aktualizován `docs/submission/submission.json`: lokální launcher, aktuální evaly; chybějící veřejné URL a video mají `TODO: MISSING`, které stávající gate odmítá. Uvedená repository URL nebyla nezávisle ověřena. |
| README s rozsahem a spuštěním | Aktuální `README.md`: předpoklady, příkazy, port 3116, pouze řízené okno, 4 000 Unicode znaků na originál i doplnění / 16 000 UTF-8 bytes dohromady, 12 volání, časový limit a přiznaná latence. Source Save/Restore je explicitní lokální uložení; ordinary session zaniká restartem serveru. |
| Krátké video aktuálního buildu | MISSING: `video/final.mp4`. Konkrétní průchod a scénář jsou v `docs/submission/demo-walkthrough.md`; scénář a screenshot nejsou video. |
| Disclosure a práva k podkladu | Manifest aktualizován podle skutečného použití oficiálního CLI; vlastní fiktivní zdroje a 25 dalších souborů implementačních testů registrovány. Právní ověření podmínek pro veřejné nasazení pomocí osobního předplatného zůstává MISSING. |
| Eval s identitou kódu a neúspěchy | `subscription-report.md` odkazuje na konkrétní archiv s HEAD, dirty stavem, uzamčenou sadou, modelovými requesty, všemi pokusy, usage a stop reason. Semantické a lidské review je samostatné. Změny nejsou commitnuté; HEAD sám neidentifikuje pracovní diff. |
| Provozní evidence | Lokální timeout a call limit mají cílené testy; samostatné spuštění launcheru ověřuje start vlastního serveru. Veřejná dostupnost, monitoring, alerty, restart hostingu a období soutěžního provozu: MISSING / NOT_RUN. |
| Registrace, způsobilost, výjimky | MISSING: potvrzení autora. Offline submission gate našla nevyplněnou registrační kategorii a identitu v historii commitů. Historie se nepřepisuje a nic se neodesílá. |

## Reprodukovatelné předání

### Pátá session — neblokující vstup a skutečný prepared prompt recorder

WSL supervisor má neblokující child stdin a skutečně ověřený cancel/EOF/lease/deadline při plné pipe, pre-start cancel a partial-setup cleanup. Matice **14/14 PASS** a následný nový setup fault **1/1 PASS** jsou oddělené běhy; standalone TS adaptér **3/3 skutečné WSL PASS**. Přesné reporty a produkční limity jsou v [protokolu supervisoru](../../scripts/subscription-wsl-supervisor-protocol.md). Produkční subscription CLI není přepojené ani tímto dummy testem ověřené.

Source smoke s novou bounded filesystem čtečkou **1/1 PASS**, prepared ordinary prompt smoke **1/1 PASS** se čtyřmi scénáři včetně skutečného input/rule trace. [Protokol a evidence](holdout-v2/protocol.md) rozlišuje poslední unit-only cancellation/deadline opravy od předcházejícího browser běhu. Nejde o živou inferenci, lidské review ani nezávislý holdout. Společná cílená regrese **158 PASS / 0 FAIL / 1 SKIP** (`scratch/session5-final-unit.json`); skip pouze file symlink, jehož vytvoření Windows nepovolil, skutečné junction testy PASS. Starší full unit výsledek níže zůstává historický.

### Čtvrtá session — ověřený offline supervisor a review bridge

Nový [fixed-DUMMY supervisor](../../scripts/subscription-wsl-supervisor-protocol.md) běží jako PID1 ve validovaném isolated WSL namespace/chrootu. Finální skutečná matice **9/9 PASS**: normal, cancel, ignorovaný TERM, setsid, zombie, EOF, lease, wrapper disconnect a stdout backpressure. Report `scratch/subscription-wsl-supervisor/a7ab603b-ca1f-46b0-a20a-0dd49f21f61c/report.json` obsahuje otisky zdrojů, skutečné `/proc` stavy a ESRCH po vlastním kill/reap, `externalHarnessCleanup:false`. Pokus dítěte o podvrh audit FD byl odmítnut; jeho stdout zůstává zabalenými daty. Review nález blokujícího stdout je opraven ohraničeným neblokujícím výstupem; auditní ACK vzniká i bez čtení live pipe.

Samostatný `subscription-supervised-command.ts` má **16/16 subprocess testů PASS** a skutečný WSL normal průchod **1/1 PASS**, report `scratch/subscription-wsl-supervisor/e19d7271-4107-4be1-ae91-f9af98960e6c/typed-adapter/report.json`. Přesně zachován dělený UTF-8 vstup/výstup, neprůhledný forged child text, jediný platný terminal a lokální close0. **Produkční `codex-subscription.ts` tuto cestu nepoužívá.** Dummy úspěch neověřuje skutečný CLI/auth/network/filesystem profil a není inferencí. Původní wrapper failure níže zůstává platnou evidencí původní cesty.

Následný skutečný TS adapter cancel **1/1 PASS**, report `scratch/subscription-wsl-supervisor/29c48ce0-4205-41e4-a5e9-79ef1923ab2e/typed-adapter-cancel/report.json`: abort až po auditním job_ready, setsid potomci ignorující TERM, následný SIGKILL a oba PID ESRCH, namespace prázdný, `cancelled/verified/localClose0`. Žádný externí úklid ani nový modelový call. Historický normal test se při tomto cíleném ověření neopakoval.

Nový [source-only review runner](holdout-v2/protocol.md) obsluhuje existující UI přes injectovaný validovaný transport, archivuje všechny pokusy a odděluje model/klienta/lidské události. Sedm native změn a confirm jsou vázané na proposal hash; `isTrusted` není důkaz identity člověka. Fixture export má nulové human/model counts a `protocolAttempt:null`. **47/47 unit PASS**, připravený browser smoke **1/1 PASS** (dva scénáře: bez potvrzení → interrupted, scripted compare → fixture completed). Poslední oprava browser-clock intervalu má unit/tsc, neopakovaný browser ji samostatně nedokazuje. **LIVE NOT_RUN**, bez zapojení subscription launcheru, bez nového nezávislého holdoutu či lidské studie.

Společná závěrečná regrese runneru, nového transportu, starého subscription lifecycle a motion capability: **121/121 PASS**, TypeScript PASS (`scratch/session4-final-scoped-unit.json`). Cold/warm browser profil se skutečným mesherem a 25 editacemi **2/2 PASS**, detaily a rozsah v `optimization-baseline.md`. Veřejné URL, oprávnění a finální release tím nejsou hotové.

### A11 — offline fault kontrola transportu, 9. 9. 2026

`npx vitest run scripts/__tests__/codex-subscription.test.ts scripts/__tests__/subscription-lifetime.test.ts`: **37/37 PASS**, finální běh 4,04 s. Finální `npx tsc --noEmit` a cílený `git diff --check`: PASS. Test používá skutečné lokální podprocesy Node se simulovaným JSONL výstupem a skutečné headless Chromium; nespouští Codex, WSL, přihlášení, inference ani přístup ke credential stores. První spuštění zastavil sandbox při startu Vite (`spawn EPERM`); opakování s povolenými testovacími podprocesy prošlo. Samostatná WSL simulace je popsána níže.

| Porucha / vlastnost | Evidence a hranice |
|---|---|
| Quota na stderr i ve strukturovaném stdout | Simulovaný CLI exit 1 správně vrací `SUBSCRIPTION_LIMIT`; raw diagnostika nevstupuje do chyby. JSONL quota s úspěšným procesovým exitem je odmítnuta parserem, včetně chyby následující po `turn.completed`. |
| Timeout | Simulovaný exit 124 i skutečný časový limit lokálního Node podprocesu vrací `CODEX_TIMEOUT`. PID zapsaný simulátorem již po dokončení příkazu neexistuje (`process.kill(pid, 0)` vrátí `ESRCH`). To dokládá ukončení přímého simulovaného dítěte, nikoli linuxového CLI za `wsl.exe`. |
| Překročení výstupního bufferu | Vrací samostatné `CODEX_OUTPUT_LIMIT`; nezaměňuje se za timeout jen kvůli `killed=true`. Produkční limit zůstává 8 MiB. |
| Vynucené ukončení exit 137 | Vrací `CODEX_PROCESS_KILLED`. GNU kill-after tuto hodnotu v izolovaném Linux testu skutečně vrátil; sama hodnota ale nerozlišuje timeout, OOM nebo jiné vnější SIGKILL, a journal si příčinu nevymýšlí. |
| Selhání spuštění / brzké zavření stdin | Chybějící executable, exit 2 a zavřené stdin při velkém vstupu bezpečně odmítnuty jako `CODEX_COMMAND_FAILED`. |
| Stop po chybě, souběh a účetní evidence | Po každé z transportních chyb žádné opakování ani API fallback; journal má jeden failed konec s kódem, `usage:null`, `usd:null`. Souběžné volání nedostane další inferenci. Model, effort, call limit i produkční timeouty beze změny. |
| Zrušení / zavření browseru | **LOCAL PASS / WSL DUMMY DESCENDANT CLEANUP FAIL.** `Command` a emitter přijímají volitelný AbortSignal. Již zrušený běh nespustí přihlášení ani inferenci; pozdní úspěšný výsledek se nepřijme. Abort ukončí přímý Node simulátor a teprve po close vrátí `CODEX_CANCELLED`; PID probe vrací `ESRCH`. Skutečné zavření Chromium page, context i browseru přeruší simulovaný příkaz a uvolní čekání launcheru. Přímý WSL dummy experiment ale prokázal přežití linuxových potomků po ukončení wrapperu (viz níže). Skutečný Codex CLI nebyl spuštěn. |
| Restart a potomci ve WSL | Offline restart aplikační session je doložen níže. GNU timeout process-family simulace v izolovaném WSL2 sandboxu prošla. Po samostatném abortu `wsl.exe` nadále existovala PID dummy potomků; odstranil je až explicitní úklid harnessu. Ukončení skutečného CLI a potomků po restartu launcheru či zavření browseru je stále **NOT_RUN**. |

Veřejná varianta nad současnými Map sessions musí zatím počítat s jedním dlouho běžícím serverovým procesem a ztrátou ordinary session při restartu. Konkrétní hosting, readiness/monitoring na něm, inferenční oprávnění a veřejný lifecycle test zůstávají nevybrané/neověřené. Tato offline evidence neuzavírá A11 ani veřejný release.

`Stop waiting for source` nadále znamená přerušení lokálního fetch a odmítnutí pozdního výsledku; propagace tohoto fetch abortu přes Playwright route do CLI není ověřená. Nové napojení řeší zavření řízeného okna a ukončení launcheru, ne tuto odlišnou cestu.

### Izolovaná WSL simulace GNU timeout

Read-only discovery potvrdilo běžící `Ubuntu-24.04`, WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`. První `wsl --status` v omezeném sandboxu skončil `E_ACCESSDENIED`; následný povolený read-only probe prošel. Namespace probe `/usr/bin/unshare --user --map-root-user --mount --net --pid --fork /bin/true` prošel. Host `/usr` bind mount neprošel, takže se neobcházela jeho ochrana: finální harness kopíruje explicitní systémový Python, stdlib, timeout a jejich ldd knihovny do nového tmpfs.

`scripts/subscription-wsl-fault.sh` spouští `scripts/subscription-wsl-fault.py` až v chrootu s ověřeným read-only `/usr` (zápis vrátí `EROFS`), samostatnými user/mount/net/pid namespaces, pouze rozhraním `lo`, bez `/home`, host `/mnt` a bez jediného zapisovatelného host mountu. Prostředí je prázdné kromě explicitního PATH; Python běží `-I -S`. Report vypisuje stdout a Windows jej ukládá do `scratch/subscription-wsl-fault/2026-09-09-a11/report.json`.

| Simulace | Výsledek |
|---|---|
| GNU `timeout --signal=TERM --kill-after=0.2s 0.5s` | Exit 124, 527 ms; namespace PID 373 a 374 po ukončení oba `ESRCH`. |
| Stejný timeout, parent i child ignorují TERM | Exit 137 po kill-after, 710 ms; namespace PID 376 a 377 po ukončení oba `ESRCH`. |

Harness adoptuje a reapuje své potomky; to **není** důkaz, že produkční WSL dispatcher implementuje subreaper nebo že Windows kill wrapperu zastaví linuxový strom. Neběžel Codex, přihlášení ani inference a nebyly čteny credential stores. Skript má záměrně konkrétní allowlist cest tohoto stroje a není univerzálním instalačním postupem.

První přímý wrapper experiment `evals/reality-compiler/subscription-wsl-wrapper.measure.ts` skončil **FAIL / REMOTE UNKNOWN**: před markerem simulátoru vypršel 20s lokální timeout (`CODEX_TIMEOUT`, očekáváno `CODEX_CANCELLED`), report FD zůstal prázdný. Pokus je zachován v `scratch/subscription-wsl-fault/d0c63ce3-36b0-4ac4-bb32-597cf213241e/report.json`; sám neprokazuje abort propagation ani remote cleanup.

Následný jediný běh oddělil **90s deadline přípravy dummy sandboxu** od okamžiku start markeru; produkční 200s/180s CLI limity se neměnily. Výsledek je **FAIL_DESCENDANTS_SURVIVED_WRAPPER_ABORT** v `scratch/subscription-wsl-fault/f3b62974-ec62-4551-a8aa-6630feabd0f7/report.json`: příprava do markeru 10 182,34 ms, lokální `CODEX_CANCELLED` za dalších 5,02 ms, ale oba linuxové namespace PID 372 a 373 po 2 s nadále existovaly (`kill(pid, 0)` bez `ESRCH`). Tato sonda nerozlišuje běžící proces od zombie; nedokládá pokračující inferenci. Vlastní harness následně provedl kill/reap a oba PID již vracely `ESRCH`, samostatný `harnessCleanup:PASS`. Měřicí test správně selhává na abort-cleanup bráně a nepřipisuje vlastní úklid harnessu wrapper abortu. Celý experiment trval 12,93 s včetně runneru.

Harness zachoval ověřené namespaces/chroot a používá pouze předem otevřený FD do explicitního scratch souboru, žádný host PID scan ani obecný kill dispatcher. Neběžel Codex ani inference. Jde o přímý důkaz, že samotné ukončení `wsl.exe` není v tomto dummy uspořádání zárukou úplného úklidu linuxových potomků; přesný lifecycle skutečného CLI zůstává neověřený. Samostatná dřívější GNU timeout evidence tím není změněna.

**Otevřený implementační follow-up — explicitní dispatcher pro jeden běh (pouze návrh, neimplementováno).** Nejmenší oprava dobrovolného cancelu je ponechat `wsl.exe` běžet, doručit cancel jeho vlastnímu linuxovému supervisoru a čekat na potvrzení úklidu. Dnešní `child.stdin.end(prompt)` řídicí kanál uzavře a `child.kill()` zasáhne jen wrapper; další samostatné `wsl ... kill <pid>` tuto vazbu bezpečně nenahradí.

Dispatcher má spustit jeden pevně sestavený argv příkaz s dnešním GNU `timeout --signal=TERM --kill-after=5s 180s` v samostatné, jím vytvořené process group. Dostane prompt jako jediný datový start frame a ponechá vlastní stdin otevřené pro přesně vymezený cancel frame; prompt předá dítěti odděleným stdin a to uzavře. Cancel/EOF může poslat TERM, po omezené grace KILL, **výhradně do process group vytvořené tímto stále živým supervisorem**, a následně wait/reap. Nesmí přijímat uživatelem dodané PID, PGID, executable nebo shell příkazy, prohledávat host procesy, používat `pkill` podle jména ani přebírat PID ze starých souborů. GNU timeout zůstane nezávislou horní mezí; samotné EOF po pádu Windows wrapperu není bez testu garantovaným řídicím signálem.

Potvrzení musí vzniknout až po ověřeném linuxovém úklidu a být odlišeno od JSONL textu dítěte: například supervisor všechny child eventy zabalí jako data do vlastní transportní obálky a samostatně vydá terminal acknowledgement. Modelový stdout nesmí umět toto potvrzení podvrhnout. Journal oddělí lokální cancel request, remote acknowledgement a chybějící/neúspěšný remote cleanup; ztráta kanálu zůstane UNKNOWN. Nastavení Max/model/effort, zákaz API fallbacku, 12-call limit a dnešní produkční 200s/180s limity se nemění.

Process group sama nepokrývá potomka, který se z ní odpojí (`setsid`/nová group). Pro úplnou A11 záruku je potřeba nejprve dummy fault matrix v již ověřeném filesystem/PID sandboxu: TERM, ignorovaný TERM, cancel během startu, pozdní výstup, zavření řídicího kanálu, pád supervisora a odpojený potomek; zvlášť zaznamenat stav procesu/zombie, ESRCH a vlastníka reapu. Pokud group nepokrývá skutečný strom, navázat dispatcher na vlastní PID namespace s ověřeným úklidem celé namespace; nepřidávat obecný host kill mechanismus. Současný kopírovaný dummy chroot nemá síť ani přihlašovací prostředí skutečného CLI, takže jeho PASS není validací produkčního auth/runtime sandboxu. Offline implementace proti simulátoru může navázat; produkční přepojení zůstává otevřené do těchto důkazů a samostatného ověření skutečného runtime. Tento follow-up neautorizuje čtení credential stores ani živou inferenci.

### Konkrétní návrh dohledu pro jeden server (nenasazeno)

Použít jeden dlouho běžící proces; při restartu otevřeně obnovit ordinary session jako novou. Existující `/api/health` ověřuje zápis/readback/úklid v tmpdir, má 2s interní cache a slučuje souběžné sondy; při nakonfigurovaném HTTP modelu zahrnuje kontrolu ledger konfigurace. Neověřuje živé přihlášení Codexu ani sémantickou kvalitu modelu. Navržený externí dohled může kontrolovat HTTP 200 + `ready:true` po 10 s a upozornit operátora po třech selháních; ověřit jej až na konkrétním hostingu. Health probe nesmí automaticky spouštět placenou/subscription inferenci.

Pro inferenční provoz sledovat existující `call-start`/`call-end` a jejich párování, timeout, quota, cancel, output limit a wall time. Chybějící konec po havárii evidovat jako nedokončený pokus s neznámou usage, ne jako úspěch. Quota/timeout nevedou k automatickému retry ani API fallbacku. Restart není důkaz záchrany původní Map session a automatické přidání další instance by tento kontrakt změnilo. Konkrétní alert příjemce, retention a hosting zůstávají nevybrané.

Aktualizace 9. 9.: offline produkční restart prošel (`session-restart.measure.ts`): připravený validní svět → ukončení vlastního procesu → stará session 404 UNKNOWN_SESSION → nový validní svět s odlišným ID. Report je v `scratch/session-restart/65f903aa-b01d-4b70-b197-687435bb979f/report.json`. Neověřuje veřejný hosting ani ukončení vzdáleného CLI. Připravené studijní karty A/B na aktuálním buildu prošly, obě výslovně `humanObservation:false`; lidská studie zůstává 0/5.

1. Z aktuálního pracovního stromu provést instalaci a build podle README; neopisovat credential soubory. WSL2 runtime a sandbox se na jiném stroji ověřují znovu, cesta ke CLI je nyní specifická pro tento počítač.
2. `npm run demo:subscription` nyní odmítá před loginem/spawn (`SUBSCRIPTION_PRODUCTION_NOT_VALIDATED`). Historický [průvodce](../../docs/submission/demo-walkthrough.md) určuje vstup a intervenci; další čerstvý průchod vyžaduje skutečně validovaný pevný dispatcher.
3. Historický `npm run measure:reality-compiler-subscription` po změně z 9. 9. končí před inferencí s `PARAMETER_REVIEW_REQUIRED`. Automatický protokol neumí skutečné lidské potvrzení sedmi oblastí. Před dalším živým měřením je nutný nový verzovaný protokol; původní archivy, limity a neúspěchy zůstávají zachované.
4. `npm run study:reality-compiler` připraví kartu A/B podle protokolu. Jsou to připravené stavy, nikoli generace. Skutečný pozorovatel zaznamenává odpovědi; launcher je nevymýšlí.
5. Před veřejným vydáním doplnit chybějící artefakty a ověření a znovu spustit plnou submission kontrolu proti skutečné veřejné variantě. Lokální předplatné se samo nezmění na sdílený veřejný backend.

## Kontroly a dohledatelnost

Počáteční offline kontrola `scratch/t13-submission-check.log` skončila nenulově: video, registrace, 26 disclosure nálezů a identita v historii. Síťové kontroly SKIP. Ověřené položky disclosure byly doplněny; následný výstup je `scratch/t13-submission-check-final.log`. Výsledky kontrol a finální naměřené počty jsou shrnuty v aktuálním stavu projektu a subscription reportu. Offline kontrola nikdy nepotvrzuje veřejné odevzdání.

Následný skener potvrdil disclosure PASS ve svém rozsahu. Běžel během úprav dokumentů a u popisu zachytil i tehdy chybějící soubor a starší formát kategorie; tyto soubory byly následně doplněny. Trvalý rozpor zůstává: stará brána vyžaduje doslovnou garanci z historického DESIGN-BOOK.md §6. Aktuální pilot ji nepřebírá jako neověřený slib. Před skutečným soutěžním release je potřeba sladit tento historický kontrakt s vybraným produktem; samotný starý checker není potvrzením aktuální pilotní hypotézy.

T13 připravuje konkrétní handoff a výslovný seznam mezer. Neautorizuje publikování, odeslání přihlášky, změnu účtu ani přepis historie.

## Konečné ověření lokálního předání

Konečná série 0143dcc9-ea30-4519-ada3-b47ff02bdf5b dokončila 30/30 párů, 36/36 CLI volání, bez timeoutu a bez stop reason. Invarianty, očekávané rozdíly větví a zachování stavu při odmítnutí prošly ve všech 30 párech. H06–H08 ve všech třech opakováních nevyžádaly upřesnění: 9 doložených selhání z 15 problematických párů, brána FAIL. Zbývajících šest vyžádalo upřesnění, správnost jeho obsahu čeká na lidské review. Vytvoření: medián 126,22 s / p95 180,43 s (FAIL proti 30/60 s); změna: medián 2,42 s / p95 3,73 s (PASS proti p95 8 s).

Prošlo 63 cílených unit testů, TypeScript, dvě připravené browserové studie A/B a dokončení živého benchmarku. Dokončení měřicího testu není PASS všech kvalitativních bran. License gate v scratch/t13-license-final.log: všech 7 kontrol PASS v rozsahu 609 indexovaných cest. Cílená kontrola aktuálních dokumentů je v handoff-document-check.json. Screenshoty přípravy nejsou doloženy; vizuální review ani pět skutečných lidí tím nejsou nahrazeni. Veřejný submission gate zůstává neuzavřený z důvodů výše.
