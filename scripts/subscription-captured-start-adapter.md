# Offline převod zachyceného startu

`subscription-captured-start-adapter.py` je čistá knihovna pro jediný start, jeho
úspěšnou odpověď a volitelný offline převod notifikací. Nemá launcher, transport ani přístup k credentials. Původní
produkční brána a její SHA pin se nemění.

Vstup odpovídá stock-client capture `5919e8bd972c41b49290f0b82bcd9eab` z 11. 9. 2026.
Přenosná kopie přesných 1047 bajtů je `subscription-captured-start.fixture.json`,
SHA-256 `6e15f67afd9c7d2441bb992e566fa8d8a2b4787d0a3a3e8c258d0861b8c9d062`.
Původní archiv a jeho nezávislý replay jsou uvedeny v PROJECT-STATUS.md.

Kontrakt:

- Controller musí dodat očekávaný process handle a thread ID odděleně od rámce.
  Kontrola tvaru identity není dokladem jejího původu. Aktuální experiment žádný
  mechanismus získání process handle před startem nezavádí.
- Přijímá se pouze id9 a přesný zachycený tvar všech polí; variabilní jsou pouze
  dvě identity shodné s controllerem. Duplicitní klíče, neplatné UTF-8, konstanty
  mimo JSON, pole navíc a záměna bool/int se odmítají. Selhání je trvalé.
- Výstup je nově sestavený `trusted_cli_start_request()` z SHA-připnuté základní
  brány: id2, fixed-worker, přímé Python argv, prázdný env, envPolicy null a její
  pevný sandbox. Teprve původní brána přepisuje argv na trampoline a env na své
  pevné prostředí. Adaptér sám nic neodesílá.
- Pevný sandbox má deny root, explicitní read položky, write ve vyhrazeném cwd,
  read control marker a deny původního appserver home. Převod tedy není podmnožina
  klientského readonly oprávnění. Je to samostatný experimentální worker profil,
  který vyžaduje vlastní runtime hranici. Capture home není automaticky přidán
  do profilu; deny root ho implicitně pokrývá, což samo nedokládá kernel enforcement.
- Jediná přesná úspěšná odpověď id2/fixed-worker se mapuje na id9/původní handle.
  Chyby a další požadavkové RPC se nepodporují. Report zachovává přesné vstupní a výstupní
  bajty; replay vyžaduje očekávané identity jako externí parametry.

Test používá skutečný archivovaný rámec, provede výsledný požadavek původní
bránou, ověří trampoline/env/sandbox a zpětnou odpověď. Další testy pokrývají
odchylky, limity, pořadí, SHA a manipulaci replay. Fixture se čte ze scripts,
nikoli z dočasného scratch archivu.

## Volitelný lifecycle profil

`LifecycleAdapter` zachovává původní `StartAdapter` a jeho v1 report. Vlastní v2
report profilu `offline-captured-worker-notifications` je dokončen pouze po
úspěšné start odpovědi a `process/closed`, kterému musí předcházet jediný
`process/exited`. Notifikace mohou přijít před start odpovědí; stdout/stderr
mohou dobíhat po exitu až do closed. Přepisuje se pouze processId z fixed-worker
na externě očekávaný klientský handle. Ostatní pole včetně binárního base64
výstupu, exitCode a sandboxDenied zůstávají zachována.

Tvar zpráv vychází z archivovaného upstream commitu
`25af12f7e61572b0bc18ddb1008be543b91519b0`, souborů
`scratch/session8-worker-executor-source/codex-rs__exec-server-protocol__src__protocol.rs`
(ExecOutputDeltaNotification, ExecExitedNotification, ExecClosedNotification)
a sourozeneckého exec-server README (process/output, exited, closed).
Lifecycle vstupy testů jsou authored; skutečný zachycený klientský start zůstává
jediným runtime capture v těchto testech.

Jde o užší profil bezeztrátového průběhu: seq musí začínat 1 a navazovat bez mezer,
exit vyžaduje explicitní bool sandboxDenied (legacy chybějící/null se odmítá),
pty není povoleno. Nejvýše 64 událostí včetně start/reply a 1 MiB součtu
vstupních a výstupních bajtů; rámce i chunk používají původní přísné limity.
Na opožděnou reply je rezervován jeden event a minimální prostor; její skutečná
délka se také kontroluje. Selhání je trvalé a odmítnutý rámec nevytváří výstup.
`validate_lifecycle_report` opakuje celý průběh s externími identitami a ověřuje
přesné bajty a finální stav. Neúplný průběh odmítá.

## Volitelný read profil

`ReadAdapter` rozšiřuje lifecycle o sériové `read(raw)` a `read_reply(raw)`.
V3 report `offline-captured-worker-reads` má samostatný `validate_read_report`;
původní v1/v2 kontrakty zůstávají platné. Po start reply převádí klientská ID
10, 11, … na worker ID 3, 4, … a processId na fixed-worker. Povoluje přesný
požadavek původní brány: maxBytes 65536, waitMs 1000, afterSeq null nebo u64.
Tyto hodnoty jsou omezený experimentální kontrakt, nikoli zachycený stock-client
read požadavek. Jeden read smí čekat; nový se po closed nepřijímá, ale odpověď
na dřívější read může doběhnout. Požadavky i odpovědi sdílejí event/byte limity
s lifecycle; vyčerpání limitu během čekání znamená trvalé selhání.

Úspěšná odpověď přepisuje pouze RPC ID. Validace vyžaduje nejvýše 64 chunků,
celkem nejvýše 65536 dekódovaných bajtů, kanonický base64 a rostoucí u64 seq
větší než afterSeq. Pro neprázdné chunky je nextSeq poslední seq + 1; prázdný
read může vrátit nextSeq menší než zadaný kurzor. To odpovídá archivovanému
`local_process.rs`, `exec_read`: nextSeq začíná na process.next_seq a mění se
teprve při zařazení chunku. ReadParams/ReadResponse jsou v témže připnutém
protocol.rs jako lifecycle. Chybové RPC a nenulové failure se odmítají.
ExitCode musí odpovídat exited, closed a sandboxDenied vyžadují exited.

Read je snímek, jehož vytvoření může předcházet již přijaté notifikaci. Proto
neposouvá notification seq ani exited/closed a nenahrazuje jejich doručení.
Report je kompletní až po lifecycle closed a bez čekajícího read. Ztráty
notifikací ani jejich mezery tento profil zatím neopravuje.

Testy kombinují skutečnou start fixture s authored read/lifecycle zprávami,
ověřují původní Gate.admit/receive, překryv s notifikacemi, opožděnou odpověď,
replay manipulaci a odmítnutí neplatných identit, kurzorů, dat a limitů.

Zbývá integrace bootstrap/cwd/git discovery s reálnými odpověďmi, důvěryhodné
navázání dynamického handle, skutečný stock-client read capture a obnova při mezerách v sekvenci,
počítání skutečně doručených bajtů a izolovaný úspěšný worker lifecycle včetně
úklidu. Offline report vždy ponechává delivery/execution/production false.
