# Návrh provozu Reality Compileru na jednom procesu

## Ordinary sessions — lokální durable implementace 17. 9. 2026

Graceful restart nyní při SIGTERM/SIGINT nejprve synchronně uzavře registrované session SSE (heartbeat, subscriber a slot), nové proudy odmítne 503 SERVER_DRAINING. Nemění accepted session stav ani předčasně neuvolňuje diskový lock; proces ukončuje Next. Produkční lokální `session-restart-20260917/run-4` s otevřenou UI kartou: 6067 ms do čistého exit143, automatický lock release, tři shodné accepted snapshoty a browser SSE reconnect PASS. Explicitní fixture host obchází pouze automatické načítání .env, nikoli identitu/store validaci. Není to Linux power-loss ani reálný proxy důkaz.

Tento oddíl nahrazuje níže uvedený historický limit ztráty ordinary sessions pouze při explicitním `WORLDSMITH_SESSION_STORE_FILE=/var/lib/worldsmith/ordinary-sessions.json`. Bez proměnné zůstává původní paměťový režim. Durable režim vyžaduje trusted-proxy identitu, odmítá Vercel a potřebuje soukromý service-owned trvalý adresář. Žádná skutečná host konfigurace nebyla provedena.

Checkpoint obsahuje nejvýše 64 sessions, 32 MiB a posledních 512 eventů/session: hashed ownera, přijatý blueprint a revize, representation metadata, comparison origin a event log. Zápis je synchronní před SSE i úspěšným HTTP commitem, s CAS, fsync, atomic rename a single-writer lockem. Plný durable registr odmítne novou session 503. IO/schema/lock chyba poisonuje adapter; všechny session routes pak vracejí 503 bez volatile success. Klient při 409 EVENT_HISTORY_TRUNCATED načte autoritativní snapshot a pokračuje od jeho sekvence.

Cold start obnoví přijaté ordinary blueprinty, simHash/revize a comparison origin. Rozpracovaná generace dostane explicitní session.failed bez opakování modelového POST. Preview změny se invalidují. Promise, emitter, worker ani Source WeakMap se nepersistují: source relace bez ordinary blueprintu je interrupted a recovery metadata výslovně hlásí sourceProjects:not-restored.

Graceful exit zavře lock. Po hard crash musí operátor doložit konec původního procesu a teprve potom odstranit přesný `.lock`; žádná automatická krádež podle PID/stáří. Před provozem zbývá Linux filesystem durability, oprávnění, stop/start, stale lock a tři skuteční návštěvníci. Windows fixture restart není power-loss ani veřejný provozní důkaz. Více replik není podporováno.

Důkaz: session-persistence.test.ts 6 PASS přes skutečný filesystem a HTTP routes: tři ownery, přesný blueprint/hash/revize, comparison restore, ordinary rule commit, odmítnutý commit při ztrátě locku bez SSE/HTTP success, restart in-flight a 512 event backlog. Client reconnect 409 a související events/session/client/sessions/changes regrese 217 PASS. Bez modelových volání či skutečných credentials.

Stav 9. 9. 2026: konkrétní návrh k předání, **NOT_DEPLOYED**. Hosting, veřejná URL a oprávnění veřejné inference nejsou vybrané. Lokální development dál používá vlastní předplatné; tento návrh neinstaluje službu ani nezveřejňuje lokální bridge.

## Topologie a zachování stavu

Jeden dlouho běžící produkční proces `next start`, jedna verze buildu a jeden původ pro HTTP i SSE. Bez cluster režimu, paralelních instancí a serverless škálování: `src/worldstream/sessions.ts` drží ordinary sessions v paměti procesu. Ani sticky routing nezajistí jejich přežití při restartu. Při aktualizaci nejprve uzavřít nové operace, oznámit ztrátu ordinary sessions a restartovat až po doběhnutí či doloženém ukončení vlastních pending operací. Staré session potom vracejí 404; klient vytvoří nový svět.

Source Save/Restore je lokální úložiště konkrétního browseru s validovaným replayem. Není to serverová záloha ani synchronizace mezi zařízeními. Uživatel musí uložit projekt před zavřením browseru. Kopírování credential souborů není součást provozního předání.

Produkční artefakt vzniká `npm ci` a `npm run build`; před spuštěním zapsat commit, případný dirty patch a identitu buildu z `/api/build-id`. Běžný proces se spouští `npm run start -- --hostname 127.0.0.1 --port 3116`. Zpřístupnění portu, TLS, domény a služba operačního systému se nastaví teprve pro vybraný autorizovaný hosting. Lokální subscription demo má vlastní launcher a řízený browser; samotný tento příkaz jeho bridge nevytvoří.

## Připravená varianta a inference

Připravené světy musí stále ukazovat svůj původ. Pro variantu bez veřejné inference musí být upstream vypnutý stávajícím kill control a prostředí nesmí obsahovat nepřiznaný provider fallback. Připravená varianta nepodporuje libovolný nový source prompt a nesmí být představena jako čerstvá generace. Výběr této varianty versus veřejné inference je samostatné produktové a provozní rozhodnutí před nasazením.

Pokud bude zvolena veřejná inference, před startem doložit její oprávnění, účinné limity, souběh, timeout, ukončení provider práce a chování při nejistém výsledku. Stávající spend-store adaptér není důkaz odolnosti session Map ani naměřeného chování konkrétní veřejné služby. Max předplatné developmentu se tím automaticky nemění.

## Readiness a monitoring

| Kontrola | Co skutečně dokládá | Reakce |
|---|---|---|
| PID a procesový exit | Životnost konkrétního serverového procesu | Zapsat restart; neprezentovat staré sessions jako obnovené. |
| `GET /api/health` | Zápis, readback a cleanup v dočasném adresáři, 200/503; krátká interní cache sondy | Při 503 stáhnout provoz a prověřit třídu chyby. Není to ověření přihlášení, kvóty ani provider latence. |
| `GET /api/build-id` | Identita obsluhujícího buildu | Po aktualizaci porovnat se zaznamenaným artefaktem. |
| `ops/watchdog/worldstream.mjs` bez `--allow-generation` | Health a případně stažení explicitního existujícího shared snapshotu | Uchovat JSONL i neúspěšné sondy; není to GPU render test. |
| Produkční browserové smoke testy | Skutečný canvas, runtime vstup, porovnání a odmítnutí | Spustit nad přesným cílem po autorizovaném nasazení; scripted provider nesmí být vydáván za live. |

Příklad read-only lokální sondy: `node ops/watchdog/worldstream.mjs --target http://127.0.0.1:3116 --log scratch/worldstream-watchdog.jsonl`. Pro ověření sdíleného snapshotu přidat `--shared` s existujícím ověřeným hashem. Výchozí sonda negeneruje žádný nový svět. Veřejný interval a archivaci logů je nutné přizpůsobit zvolenému hostingu; jejich běh zatím není doložen.

Serverové logy `worldstream.server-timing` oddělují requesty pomocí request ID a jednotlivé fáze. Vnořené a inkluzivní úseky se nesčítají do modelové latence. HTTP 202 neznamená dokončenou generaci. Lokální browserový journal zachovává samostatně lidské čekání, frame a interakci; ukončení `gl.render` není GPU scanout.

## Podmínky konkrétního nasazení

- MISSING: zvolený hosting, adresa a provozovatel, TLS, způsob startu a rotace logů.
- MISSING: rozhodnutí o připravené versus inferenční veřejné variantě a příslušná oprávnění.
- NOT_RUN: fault testy na konkrétním hostingu, restart pod zatížením, reálný veřejný SSE průchod, monitoring a veřejný browser smoke.
- NOT_RUN: nové živé před/po měření s lidským potvrzením a nezávislé sémantické review.

Aktuální lokální důkazy a hranice ukončení procesů jsou v [submission-readiness](../evals/reality-compiler/submission-readiness.md). Návrh nemění žádnou externí konfiguraci a nenahrazuje chybějící výsledky.

## P20 T17 — připravený Linux host (17. 9. 2026)

Aktualizace 18:55: konkrétní návrh poskytovatele a ověřený cenový výpočet jsou v [host/cost-estimate.md](host/cost-estimate.md). Kandidát CPX42/EU, bez objednávky. Aktuální ordinary session persistence je popsána na začátku dokumentu; níže zachovaný původní restartový kontrakt bez store platí pouze v paměťovém režimu.

Implementační cílová topologie je nyní **jedna dlouho běžící Linux VM, jeden Next produkční proces a jeho omezené CLI subprocessy**, nikoli Vercel funkce. Konkrétní poskytovatel, účet a zveřejnění nebyly vybrány ani objednány. Artefakty v `ops/host/` jsou připravené pro operátora; nic z nich nebylo instalováno jako služba.

- `worldstream.service`: Node 22 podle package.json, hotový build v `/srv/worldstream/current`, port 3116 pouze loopback, pracovní service user, restart limit, ukončení celé vlastní control group, 310 s stop budget. 8 GB memory limit je výchozí strop návrhu, nikoli měření kapacity.
- `preflight.mjs`: spustitelná kontrola jmen konfigurace bez vypsání hodnot, čtení credentials či volání poskytovatele. Hosted cesta vyžaduje Astru medium přes již provisionovaný CLI a durable REST spend ledger. Chybějící autorizace/provisioning, ledger nebo cesta runtime způsobí nenulový exit; lokální development se tím nemění.
- `host.env.example`: bez secrets, neprojde ve výchozím stavu. `WORLDSTREAM_HOST_READY=yes` je provozní potvrzení operátora až po níže uvedených kontrolách; není dokladem licence nebo sítě samo o sobě.
- Read-only watchdog systemd timer: minuta, celá sonda max. 25 s, service timeout 30 s, žádná generace. Opraveno zjištěné nekonečné čekání na socket/tělo odpovědi pomocí celkového deadlinu a abort signal.

Transport Astra CLI je převzat z produktu. CLI release a Linux sandbox musejí být na cílovém stroji ověřeny a pinovány operátorem před startem; nekopírovat credential stores z autorova Windows. Tento krok neprováděl login, credential manipulaci ani provider call. Oprávnění použití účtu v hosted službě zůstává externí vstup, nikoli předpoklad.

**Restartový kontrakt:** spend kniha vyžadovaná host preflight je persistentní mimo proces a stejný prefix se při restartu nemění. Ordinary sessions/jobs nadále bydlí v paměti; restart uprostřed generace ji přeruší, staré session ID po restartu vrátí 404 a klient musí explicitně začít znovu. To je poctivě přiznaný limit a **nesplňuje** T17 AC obnovení přijmuté ordinary session/job. Není povoleno zvětšit počet replik bez sdíleného session/job store. Shared snapshot a lokální Source Save nejsou náhradou této chybějící podpory.

**Cena před nasazením:** žádný nákup nebyl proveden. Před schválením nákupu doplnit konkrétní nabídku: měsíční host + trvalý ledger + egress + log retention + případné oprávnění inference. Výpočet `730 × hodinová cena hostu + ostatní měsíční položky`; účetní tokenové sazby u subscription nejsou účtovaná inference. Bez poskytovatele/ceníku zde není poctivý numerický odhad. Nový účet/kredit ani deployment nebyl autorizován.

**Lokální důkaz:** 76/76 testů `ops/__tests__/host-preflight.test.ts`, `ops/__tests__/worldstream-watchdog.test.ts`, `src/server/__tests__/spend-store.test.ts` prošlo. Watchdog sada obsahuje skutečný child proces a lokální HTTP server; ledger je testovaný adaptér, nikoli připojené veřejné úložiště.

**Před startem na autorizovaném hostu:** zafixovat build ID a CLI release; provisionovat účet a ledger oprávněným operátorem; ověřit sandbox pod stejným service userem; připravit `.next/cache` a log rotation; nakonfigurovat TLS reverse proxy s průchozím SSE bez bufferování a timeoutem nad generation timeout; otestovat tři návštěvníky, provider timeout/cancel, vyčerpání call cap, restart během generace a jednoznačné 404/recovery; nakonec čistý externí browser. `systemd-analyze verify` a instalace jednotek nebyly na Windows provedeny. Veřejný PASS, potvrzení hosted CLI funkce a 24h monitoring zůstávají NOT_RUN.

**Důvěryhodný owner na Linux VM — nová lokální implementace:** host preflight nyní vyžaduje explicitní `WORLDSMITH_OWNER_IDENTITY=trusted-proxy` a operátorem injektovaný `WORLDSMITH_OWNER_PROXY_SECRET` (32–256 znaků base64url). `VERCEL=1` se mimo Vercel nenastavuje. Žádná skutečná hodnota nebyla vytvořena, zapsána ani čtena v této Windows session.

Proxy musí autentizovat návštěvníka a **přepsat** `x-worldsmith-owner` stabilním ID ověřeného principalu (1–128 znaků A–Z/a–z/0–9/`_.:@-`) a `x-worldsmith-proxy-key` injektovaným tajemstvím. Nikdy nepropustit klientovu hodnotu, nepoužít uživatelsky volitelný cookie/header jako principal a nevytvářet novou identitu pro každý request. Next naslouchá pouze loopback; veřejné jsou jen TLS proxy dveře. Tajemství nesmí být v browseru, logu, repozitáři nebo URL. Nasazení autentizačního proxy/adaptéru a správné předávání hlaviček musí teprve doložit oprávněný operátor; tento text není hotová provozní konfigurace.

V explicitním režimu všech devět mutačních caller routes ověřuje identitu před čtením těla nebo poskytovatelem. Chybějící/podvržená autorizace vrátí403, chybná konfigurace503; žádný fallback na `x-forwarded-for`, `x-vercel-forwarded-for` nebo anonymous bucket. Ověřený principal se do rate/session klíče zapisuje jako SHA256 digest, nikoli otevřený identifikátor. Statický proxy key sám neautentizuje člověka: důvěryhodný proxy principal je nutná součást kontraktu. Signed anonymní cookie nebyla přidána, protože její opakované vydávání by nevynucovalo per-owner mez.

Session kvóta zachovává původní politiku: od32živých sessions nejvýše8na ownera. Nejde o nový spend cap ani vlastnickou autorizaci čtecích URL. Skutečné route testy se třemi fixture ownery potvrzují3×8 přijatých sessions, odmítnutí další u každého, odmítnutí spoofed headers a zachování cizích sessions. Devět route guardů odmítá i malformed body dřív, než ho přečte. Veřejný proxy/TLS/SSE a tři reální uživatelé zůstávají NOT_RUN.

## Doplnění T17: durable asset jobs, lokální příprava 17. 9.

`src/server/asset-job-store.ts` přidává explicitně injektovaný `openAssetJobFileStore(absoluteFile, { maxBytes? })`. Výchozí a nejvyšší strop je16MiB včetně imageDataUri, nejvýše12jobů. Žádný environment/credential lookup, provider připojení ani veřejný endpoint; host wiring není automaticky zapnutý. Ordinary sessions nadále zůstávají process-local. Tato změna tedy nesplňuje celý T17 restart AC.

Store validuje bounded strict schema, identity/stage/task konzistenci a pevnou konfiguraci limitů. Před jakoukoli mutací coordinatoru se ověří velikost i schema a trvale zapíše nová verze; až pak se změní paměť. Zápis je temporary-file → fsync → atomic rename, na Linuxu navíc fsync parent directory. Windows test dokládá obsah/restart/atomic rename, nikoli Linux power-loss filesystem chování. Diskové IO/schema/byte/CAS chyby zastaví daný coordinator failclosed, nevyvolají další provider POST a nepřepíší předchozí data.

Exkluzivní soubor `<store>.lock` vzniká přes `wx`; druhý opener je odmítnut. Je to single-host/single-process vlastnictví, **nikoli distribuovaný lock**. Pro graceful restart service zastaví přijímání práce, nechá doběhnout/ukončí in-flight operace a zavolá `store.close()`. Teprve další process otevře store. Po tvrdém pádu lock zůstává: operátor ověří, že starý proces skutečně skončil, a odstraní právě tento lock; nepřebírá se automaticky podle času ani PID (riziko reuse). Bez ověření se start odmítne. Multi-replica/NFS provoz není podporovaný.

Persistují se idempotency request/candidate, task IDs/credits, referenční metadata, časy, počet pollů a `inFlightCreate`. Před initial i refine POST se marker zapisuje na disk. Po restartu:

- queued se může poprvé vytvořit;
- známý running task pokračuje readonly poll bez opakování create;
- neznámý výsledek initial/refine POST skončí `PROVIDER_OUTCOME_UNKNOWN_AFTER_RESTART`, `providerMayStillRun=true`; POST se automaticky neopakuje;
- cancellation/stale revision/absolutní deadline/poll cap a idempotency zůstávají zachované;
- nejistý nebo dál běžící zrušený provider task dál zabírá concurrency slot i v terminal stavu. Uvolnění vyžaduje doložené provider reconciliation, které tento lokální spike neautomatizuje.

Všichni klienti procesu musí sdílet **jeden** `createAssetJobs({...existingDeps, store})`; nepouštět nového koordinátora na request. Mock fixture se třemi klienty přes skutečný filesystem doložila dva running + jeden queued, restart queued/known-task, cancel uvolňující slot, nejistý initial i refine POST bez opakování a starého writeru odmítnutého po převzetí. JSON i schema corruption failclosed; image backup overflow odmítnut před paměťovou mutací a bez změny diskového souboru. **18/18 cílených testů PASS, typecheck PASS.** Žádné provider calls, účet, deployment ani persistentní ordinary session vznikly.

Další provozní krok: na již autorizovaném Linux hostu explicitně připojit store na trvalý service-owned volume, ověřit graceful stop a cold start pod stejným service userem, power-loss/crash postup a provider reconciliation. Zvlášť zůstává ordinary session persistence, spend reservation/reconciliation pro asset job a lidské schválení cizího importu.
