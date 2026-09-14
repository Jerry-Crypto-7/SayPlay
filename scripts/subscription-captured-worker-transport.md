# Evidence zápisů kolem captured adaptéru

`subscription-captured-worker-transport.py` poskytuje čistou `Transport` knihovnu
kolem SHA-připnutého `ReadAdapter`, navazující `WireTransport` a volitelnou I/O
funkci `pump`. Nemá process launcher, connect ani listen. Přijímá zdroj adaptéru a základní brány jako bytes a očekávané
process/thread identity odděleně. Základní brána i v1/v2/v3 adaptéry se nemění.

Rozhraní:

- `feed(side, raw)` dostává skutečně přečtené bytes ze strany `client` nebo
  `worker`. Přijímá rozdělené i spojené JSON řádky; prázdné čtení patří do eof.
- `pending(side)` vrací neměnnou kopii bajtů čekajících na zápis danému cíli.
- `written(side, count)` přijímá kladný skutečný výsledek zápisu právě tohoto
  prefixu. Částečné zápisy posouvají frontu; bool, nula, záporný či nadměrný
  počet znamenají trvalé selhání. Při EAGAIN caller ponechá frontu bez změny.
- `eof(side)` značí konec vstupu. Client half-close je možný po startu, zatímco
  server ještě pracuje. Worker EOF vyžaduje dokončený protokol; čekající klientský
  výstup se poté může dopsat. Duplicitní EOF nebo nedokončený JSON řádek selže.
- `abort()` patří do větve chyby I/O, deadline nebo zrušení. Vyprázdní fronty a
  trvale zneplatní dokončení i v případě dříve kompletního reportu.

U původního `Transport` jméno `worker` označuje logický směr k pevnému worker kontraktu. Obsahuje
výstup adaptéru **před přepisem argv/env původní bránou**. Není to hotový wire
transport k exec-serveru. Následující `WireTransport` doplňuje původní gate,
finální zápisy a validaci příchozích serverových zpráv. Celková stock-client
integrace včetně jeho discovery a izolovaného worker běhu stále není dokončená.

Korelace čeká na plný zápis startu před přijetím worker rámce, na plný zápis
start reply před dalším klientským read a na plný zápis read před jeho odpovědí.
Notifikace mohou předcházet start reply, jakmile je start zapsaný. Pořadí,
identity a obsah dále kontroluje připnutý adaptér. Jediný caller musí obsluhovat
stav sériově a potvrzovat zápisy přesného prefixu pending, nikoli jiné bajty.

Limity: nejvýše 131072 B na feed i JSON rámec, dohromady 1 MiB vstupních bajtů,
1 MiB vytvořeného výstupu a 4096 úspěšných feed/written/eof volání. Platí také
přísnější společný limit adaptéru 64 událostí / 1 MiB vstup+výstup.
Příliš roztříštěný přenos tedy může bezpečně selhat na počtu volání. Selhání
v dávce zruší i její dříve připravený, dosud neodeslaný výstup; už zapsané bajty
nelze vzít zpět. Caller poté musí zastavit a uklidit vlastní runtime.

Report uchovává přesné feed bytes, potvrzené počty zápisů a EOF v pořadí.
`validate_report` přehraje tyto operace s externími zdroji a identitami a porovná
celý výsledný report. `complete` a `writeAccountingComplete` vyžadují dokončený
protokol, oba vstupní EOF, prázdné fronty a žádné selhání. Samotný offline replay
nedokazuje, že OS zápis nastal nebo že ho vzdálený proces přijal. Proto zůstávají
deliveryAttested, executionAttested a productionReady vždy false.

Testy zahrnují skutečné lokální `os.pipe`/`os.write`/`os.read`, zápisy nejvýše
11 B s přesným porovnáním přečtených bajtů, rozdělené vstupy, spojené notifikace,
read reply po closed, half-close, nedoručené request/reply, neplatné počty,
EOF/abort, limity a manipulaci replay. Endpointy jsou authored; žádný klient,
exec-server ani worker proces se tím nespouští.

## Finální wire a worker handshake

`WireTransport(adapter_raw, base_raw, process_id, thread_id, pid_namespace,
mount_namespace)` používá původní SHA-připnutý Gate v profilu
trusted-cli-worker-boundary. V konstruktoru připraví vlastní worker initialize
id1; teprve po jeho plném zápisu a platné odpovědi připraví initialized.
Klientský start přijme až po plném zápisu initialized. Nepředstírá hotový
bootstrap nastavením init_ok/initialized. Worker handshake je oddělený od
klientského environment/cwd/git discovery, které tato knihovna neobsluhuje.

Mapovaný start projde Gate.admit a dostane finální trampoline argv a pevný
worker_env včetně externě dodaných namespace identit. S každým potvrzeným
worker zápisem se posouvají obě shodné fronty; Gate.started a awaiting se mění
až po posledním bajtu daného rámce. Příchozí worker rámce nejprve validuje
Gate.receive a následně adaptér, který vrací klientská ID. Selhání kterékoliv
vrstvy trvale zneplatní a vyprázdní obě vrstvy.

Report `captured-worker-final-wire-accounting` obsahuje přesné finální
wireFrames, namespace identity a stav gate. `validate_wire_report` vyžaduje
identity odděleně a přehraje skutečný worker handshake, finální zápisy i klientské
mapování. Neprokazuje existenci daných namespaces ani kernel enforcement;
bootstrapAttested a isolationAttested zůstávají false. Kompletní protokol
s nenulovým exitCode může znamenat úspěšný přenos chyby procesu, nikoli úspěšné
provedení příkazu. Výsledek worker sondy musí vyhodnotit vyšší vrstva.

## Skutečná socket I/O smyčka

`pump(transport, client_socket, worker_socket, timeout=5.0, cancelled=None)`
přebírá **vlastnictví dvou předaných socket endpointů** a vždy je zavře. Caller
musí dodat čerstvý WireTransport, sockety s různými otevřenými FD a konečný
timeout nejvýše 180 sekund. Existující souběžný přístup k endpointům není
povolený; vzdálené peer endpointy zůstávají callerovi. Funkce nic nepřipojuje,
nevytváří procesy a neukončuje cizí procesy.

Smyčka přepne endpointy na nonblocking, čte a zapisuje přes selector, zachová
EAGAIN/InterruptedError bez fiktivního pokroku a posune written pouze o skutečný
výsledek send. Klientské čtení odloží do dokončení worker handshake, takže už
odeslaný klientský start může čekat v socket bufferu. Po vstupním EOF a dopsání
fronty provede shutdown(SHUT_WR) opačného cíle. Deadline i nepovinný rychlý
cancelled callback kontroluje před čekáním a po něm, čeká nejvýše 50 ms.
Chyba I/O, zrušení, deadline, neplatný rámec nebo selhání close znamenají abort.

Pump report rozlišuje socketIo.receivedBytes/sentBytes/inputEof pozorované
přímo při I/O od přijatých protokolových událostí. Bajty odmítnutého vstupu
či neúspěšného účetnictví po send zůstávají v těchto čítačích. localSocketsClosed
se týká pouze dvou lokálních endpointů (a uzavření selectoru), nikoli vzdáleného
procesu. executionAttested, remoteCleanupAttested a productionReady zůstávají
false. Úspěšná fixture přes socketpair je důkaz lokálního propojení a pumpy,
nikoli stock-client inference, spuštění workeru nebo produkční izolace.

Další integrace potřebuje klientský bootstrap/discovery, důvěryhodné získání
dynamického handle, skutečný stock-client read tvar, ověřenou runtime izolaci,
produkční transport a úklid celého živého lifecycle.
