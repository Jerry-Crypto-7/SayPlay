# Skutečný exec-server a worker přes captured session

Milník A11.2 spouští připnutý stock exec-server a skutečnou worker sondu přes
`subscription-captured-session.py`. Klient je explicitní authored testovací
peer. Nejde o stock app-server, modelovou inferenci ani subscription demo.

## Spuštění a rozsah

Tři nové soubory tvoří uzavřený experiment:

- `subscription-captured-session-capsule.sh` vytvoří čerstvý readonly runtime
  image, oddělí root a zpřístupní pevné binárky, Python a projektové helpery.
- `subscription-captured-session-runner.py` jako PID1 ověří runtime, připraví
  skutečné testovací objekty, provede session a vyhodnotí worker sondu.
- `subscription-captured-session.measure.py` vytvoří vlastní UUID systemd
  jednotku, hlídá vnější deadline, zdrojové SHA a uklidí pouze tuto jednotku.
  Uloží stdout, stderr i konečný JSON výsledek exkluzivně do `scratch`.

Kontrolovaný běh z workspace ve Windows:

```powershell
wsl.exe -d Ubuntu-24.04 --exec /usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/timeout --signal=TERM --kill-after=5 230 /usr/bin/python3 -I -S /mnt/d/claude/Hackaton/scripts/subscription-captured-session.measure.py
```

Vlastní user/mount/network/PID/UTS namespaces a pivot root zachovávají původní
capture konstrukci. Host home, `/mnt`, credential stores a předchozí root nejsou
v runtime dostupné. Před workloadem proběhne stávající sandbox/binary kontrola.
Požadované limity zůstávají MemoryMax 2 GiB, swap 0, TasksMax 64, RuntimeMaxSec
180; pracovní pumpa má 20 s. `resourceReadbackAttested:false`: tento experiment
nenahrazuje dřívější resource stress a neuzavírá historický memory FAIL.

Worker se spouští stejným pevným policy argv jako původní gate, zakončeným
`exec-server --listen stdio`. Před ním běží `setpriv --bounding-set=-all
--inh-caps=-all --ambient-caps=-all --no-new-privs`, podle původního supervisoru.
PID1 si ponechá pravomoci pro přípravu vlastní capsule; executor je nezdědí.
Stock sandbox následně vytvoří worker namespaces a připnutý trampoline
provede vlastní lockdown. Původní policy/gate/adapter/transport se nemění.

## Skutečné objekty a měřené vlastnosti

Čtyři odlišné pipe objekty, vyhrazený home/sentinel a přijatý loopback socket
mají skutečné kernel identity. Jejich role jsou authored fixtures, nikoli
prokázané deskriptory app-serveru nebo CLI proxy. Marker je pro worker readonly;
sonda ověřuje ochranu těchto identit, odmítnutí chráněných cest a odlišné
worker PID/mount/network namespaces. Otevírá jen testované objekty podle pevné
sondy, nečte chráněná těla ani přihlašovací údaje.

Authored klient provede discovery, přesný start a přijme output/exited/closed
i při notifikacích před start reply. Po kompletním lifecycle provede half-close;
exec-server skončí a pumpa dočte skutečné EOF. **Skutečné process/read je v tomto
milníku NOT_RUN**; jeho offline testy zůstávají samostatné. Stderr se průběžně
omezeně odčítá. Výjimka cleanup nezamlčí neznámý výsledek a nepřeskočí ostatní
úklid. Parent sleduje pidfd svých namespace procesů a ověřuje prázdnou namespace.

Host vyžaduje zdrojové/binary shody, úspěšný transport replay, byte accounting,
EOF a cleanup. JSON worker sondy znovu sestaví z replayovaného worker výstupu,
porovná s deklarovaným workerReport a ověří vůči markeru a outer namespaces.
Samotné `passed` nebo `realWorkerValidated` v reportu nestačí. Offline replay
nad archivem ověřuje konzistenci pozorování; není novým kernel experimentem.

## Výsledek 11. 9. 2026

**Actual PASS**:
`scratch/continuation-captured-session-worker-actual-d0800758ae814dcba1a055ee33d7147b.json`
a sourozenecké `.stdout.bin` / `.stderr.bin`. Host 4928 ms, vnitřní běh přibližně
527 ms. Exec-server exit 0; sonda validní; šest pozorovaných pidfd ESRCH,
namespace prázdná, vlastní jednotka nepřítomná, peer thready ukončené bez chyb.
Přijato 7547 B, odesláno 8366 B, oba pump EOF a executor stderr EOF.
Čtyři chráněné home/sentinel cesty včetně `/proc/1/root` aliasů odmítnuty
s EACCES; žádná chráněná identita nezjištěna mezi worker deskriptory.

**346 PASS / 14,81 s / 10 testových souborů**:
`scratch/continuation-session-real-worker-integrated-v2.xml`.
Nové runner/driver testy tvoří 45 případů. Samostatný archivní replay
`scratch/continuation-session-real-worker-replay-v1.json` prošel všemi devíti
kontrolami, včetně všech 22 aktuálních source SHA a transport/probe replay.

První actual FAIL je zachován pod prefixem
`scratch/continuation-captured-session-worker-actual-4d86e563cb4f442f969eed57f10c031e`.
Bwrap odmítl zděděné capabilities; nešlo o selhání samotné worker sondy.
Po opravě setpriv wrapperu další běh prošel. I první běh doložil prázdnou
namespace, oba sledované pidfd ESRCH a nepřítomnou vlastní jednotku.

A11.2 je dokončen. A11 jako celek zůstává otevřené: dále je potřeba připojit
skutečný klientský turn, navázat jeho thread před startem, ověřit jeho skutečné
navazující RPC a provozní fault případy. Tento bounded experiment neprokazuje
stock-client původ, modelovou inferenci ani produkční připravenost.
