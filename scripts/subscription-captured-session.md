# Klientské fixture spojení s pevným workerem

`subscription-captured-session.py` propojuje klientský bootstrap a discovery
s existujícím finálním `WireTransport` a jeho socketovou pumpou. Je to explicitní
experimentální profil s authored metadaty, připravený pro další izolovanou
integraci. Nespouští procesy, nečte filesystem ani credentials.

## Rozhraní a zdroje

`create(transport_raw, adapter_raw, base_raw, thread_id, pid_namespace,
mount_namespace)` přijímá zdrojové bytes a externě očekávaný thread a namespaces.
Transport kontroluje proti SHA-256
`1fd29febe98f57d42d9e49dece02745e8c5021842888400b2e9e00f03c5db657`;
ten dále ověřuje adaptér a základní bránu. Původní tři implementace a jejich
kontrakty se nemění. Návratová instance má rozhraní `feed/pending/written/eof`,
`abort` a `report` původního transportu.

`pump(transport, client_socket, worker_socket, timeout=5.0, cancelled=None)`
použije tutéž připnutou I/O smyčku. Přebírá a zavírá oba předané endpointy,
nikoli peery nebo procesy. Vyžaduje čerstvou instanci; nejprve dokončí skutečný
worker initialize/initialized handshake a poté začne číst klientský socket.
Platí limity transportu, deadline nejvýše 180 s a jeho half-close kontrakt.

`validate_report(report, transport_raw, adapter_raw, base_raw, thread_id,
pid_namespace, mount_namespace)` přehraje všechny bootstrap i lifecycle
vstupy, potvrzené zápisy a EOF a porovná celý report. Thread a namespaces
nepřebírá z reportu. Replay dokazuje vnitřní konzistenci, nikoli původ peeru
nebo existenci namespaces.

## Klientská posloupnost

| Klient | Odpověď fixture |
|---|---|
| initialize id1, codex-environment, resumeSessionId null | sessionId capture-fixture |
| initialized | žádná |
| environment/info id2 | shell sh /bin/sh, cwd file:///work, networkProxyLaunch true |
| fs/getMetadata id3/4, dvě pevné skills cesty | explicitní authored path absent |
| fs/getMetadata id5, file:///work/exec-worker | authored directory, nulové časy a velikost |
| fs/getMetadata id6/7/8, tři pevné .git cesty | explicitní authored git marker absent |
| process/start id9 | teprve skutečná mapovaná worker odpověď |

Skills cesty jsou `/work/.agents/skills` a
`/work/exec-worker/.agents/skills`, každá právě jednou, v libovolném pořadí.
Git cesty jsou `/work/exec-worker/.git`, `/work/.git` a `/.git`, každá právě
jednou, v libovolném pořadí. Všechny paths jsou přesné `file:///` URI;
metadata sandbox musí být null. Další metadata nebo libovolné host cesty
nejsou povolené. JSON porovnání rozlišuje bool, float a int, odmítá duplicitní
klíče a neznámá pole.

Git požadavky mohou přijít společně před zapsáním odpovědí. U ostatních fází
tato fixture vyžaduje úplný zápis předchozí odpovědi; souběžnost skutečného
skills discovery dostupné zdrojové archivy nedokládají. Start čeká na dopsání všech discovery
odpovědí. `clientBootstrapComplete` tedy není pravda jen proto, že parser
přijal poslední dotaz. Celý protokol navíc vyžaduje start/read korelaci,
exited/closed, oba EOF a prázdné fronty. Protokol může úspěšně přenést i chybu
workeru; vyhodnocení výsledku sondy zůstává samostatné.

Posloupnost vychází z archivovaného skutečného capture
`scratch/continuation-tool-capture-independent-replay.json` a authored odpovědí
`subscription-exec-request-capture.py`. Nové spojení metadata z hosta
nezjišťuje: `metadataAttested:false`, `bootstrapResponses:authored-fixture`.
Před živým worker během musí izolovaný workspace této deklaraci odpovídat.
Tento profil není obecnou implementací environment/filesystem RPC.

## Dynamické ID a hranice důvěry

Process ID předem nevyžadujeme. Při prvním startu nejprve samostatný připnutý
adaptér ověří celý pevný požadavek s externě očekávaným threadem a syntakticky
platným process ID. Teprve potom se ID naváže na tuto jedinou connection a
vytvoří se pevný worker start. Žádný druhý start není povolený; další read musí
použít už navázané ID. Neúspěšná validace neodešle worker start a trvale zruší
spojení i zbývající fronty.

ID je **klientem zvolený routing handle**, nikoli doklad identity nebo oprávnění.
Stejný handle ve dvou oddělených fixture spojeních neprokazuje stejný proces.
`routingIdentityAttested` a `clientProvenanceAttested` proto zůstávají false.
Externí thread je kontrola očekávaného kontraktu, nikoli autentizace socketu.
Přepsání celého transcriptu na jiný platný handle může mít konzistentní replay;
pouhá změna deklarovaného boundProcessId jej nemá.

Tento rozdíl řeší konkrétní integrační překážku: připnutý klient vytváří handle
jako číselné process ID s UUID uvnitř `unified_exec/process_manager.rs`
(archiv `scratch/continuation-tool-trigger-source/`, commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`, funkce kolem řádku 180).
Z tvaru nelze odvozovat důvěryhodný původ. Starý `StartAdapter` stále vyžaduje
obě identity externě; tato nová obálka má záměrně jiný, výslovný kontrakt.

Worker vždy dostane `fixed-worker`, pevný trampoline argv a vlastní env
z nezměněné gate včetně externích namespace hodnot. Klientské argv/env/sandbox
se nekopírují na worker wire. Worker profil přitom uděluje write do vyhrazeného
cwd, takže není pouhým zpřísněním klientského readonly sandboxu.

## Hranice dokončení A11.1

Úspěšný lokální socketpair s authored peery prokazuje propojení všech těchto
částí, skutečné místní bajty a úklid převzatých socketů. Neprokazuje spuštění
stock klienta/exec-serveru/workeru, sémantiku sondy, modelovou inferenci, kernel
izolaci ani úklid vzdálených procesů. Všechny příslušné attestation a production
flagy zůstávají false. Dalším krokem je runtime integrace do izolované capsule
s odpovídajícím workspace, ověření skutečných navazujících RPC a celé sondy;
historický memory FAIL a hlavní A11 tím nejsou uzavřené.

Ověření 11. 9. 2026: **277 PASS / 13,82 s** v šesti souborech, z toho 61
nových session testů; `scratch/continuation-captured-session-integrated-v1.xml`.
Finální konkrétní běh `scratch/continuation-captured-session-actual-v3.json`
obsahuje šest source SHA, úplný report a pozorované discovery/start/lifecycle
rámce. Přijato 2462 B, odesláno 3278 B; oba endpointy zavřené a oba peer
thready joined bez chyb. A11.1 je v plánu odškrtnutý. Starší v1/v2 evidence
zůstává zachovaná, v3 odpovídá finálním zdrojům a testům.
