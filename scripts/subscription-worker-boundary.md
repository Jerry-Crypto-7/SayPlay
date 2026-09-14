# Pevný worker za CLI sandboxem

`subscription-worker-lockdown.py` je skutečný instalovatelný Linux seccomp filtr.
`subscription-worker-boundary-child.py` jej instaluje až po CLI/bwrap sandbox
setup; `subscription-worker-boundary.py` validuje úplné pozorování. Supervisor
povoluje pouze pevný režim `worker-boundary`, nikoli caller argv. Start tohoto
režimu vyžaduje SHA-256 obou worker helperů shodné s jejich skutečně zkopírovanými
bajty v read-only runtime image. Driver porovnává ready hodnoty s hashi zdrojů
zmrazenými před spuštěním. Pouhé vrácení ready hodnoty zpět by nestačilo.

CLI zůstává důvěryhodný proces. Používá pouze syntetickou privátní konfiguraci;
žádný skutečný auth/session soubor se nepřipojuje. Worker nedostává řídicí pipe,
host mounty, cgroup mount ani externí síť. Jeho běžný stdout je samostatná datová
pipe. Výstup workeru nelze vydávat za důvěryhodnou produkční attestaci.

Filtr přidává zákaz namespace/mount/process-access syscallů a cizích ABI;
nejde o kompletní syscall allowlist. PID1 supervisor a CLI stále sdílejí candidate
resource leaf. Vnější systemd manager zůstává autoritou mimo leaf; test běžného
ukončení neprokazuje jeho chování při OOM/trvale nereagujících procesech.

## První skutečná integrace, 10. 9. 2026

Index `scratch/session8-worker-boundary-first-summary.json` zachovává tři pokusy:

- První start odmítl Windows WSL `E_ACCESSDENIED` před spuštěním capsule.
- Opakování s úzkou eskalací PASS: 19 odmítnutých syscallů ve čtyřech kontextech
  (hlavní worker, nové vlákno, fork, exec). Privátní sentinel/config/alias EACCES,
  nepřístupné cgroup a host cesty, žádný inherited control/output descriptor
  supervisoru. Seccomp_filters 1→2, NNP=1 a vstupní capabilities 0. Sedm
  pozorovaných pidfd ESRCH, prázdná namespace, úplný transcript.
- Stejný worker uvnitř vlastní systemd UUID unit PASS. Před startem přesný
  readback 2 GiB / swap 0 / tasks 64; po běhu vlastní unit i leaf odstraněny.
  Vyčerpání těchto candidate limitů tím nebylo testováno.

Tyto dva úspěšné běhy předcházejí rozšíření v2 o ABI, clone flags a existující
vlákno. Neprokazují TSYNC na existujícím vláknu: původní snapshot navíc četl
`/proc/self/status`, nikoli status konkrétního vlákna. Původní raw a scope
zůstávají zachované, nikoli přeznačené na novější zdroje.

## Další návaznost

V2 skutečně prošla ve vlastní candidate systemd unit:
`scratch/session8-worker-v2-summary.json`, raw SHA-256
`bbc40c956a1a09a80a162e561165403fa78f2c607ae894a026b292b50ae6b87d`.
Devatenáct denial kontrol v pěti kontextech včetně již existujícího vlákna
čteného přes `/proc/thread-self`, osm clone namespace flagů EPERM a dva fixed
getpid ABI potomci SIGSYS31 s předchozím instruction markerem. Devět pozorovaných
pidfd ESRCH, unit/leaf odstraněny, source before/after shodné. Není to test
vyčerpání candidate limitů ani obecný hostile-proof důkaz. Worker unit 37 PASS
včetně bound collector faultů a distinct FIFO identity. Nezávislé review P2
collector/thread/descriptor je uzavřené v `scratch/session8-dispatcher-security-review.md`.

Pět původních TS scénářů rovněž skutečně prošlo (1 integrační test): version,
private, cancel, pětisekundový KILL a paced output limit; nový ready worker
field je kompatibilní. `scratch/session8-cli-ts-compatibility.json` a
`scratch/session8-cli-ts-9655b1c2-aaa5-47e0-a100-8744ded38132/summary.json`.
Tento běh předchází následnému přidání app-server helperu/profile.

Pevný test stále není univerzální executor hook pro každý příkaz CLI. Produkční
napojení vyžaduje vynutitelné použití této hranice pro všechny nedůvěryhodné
příkazy, oddělené auth/network prerequisites a produkční cleanup. Default
`codex-subscription.ts` zůstává `SUBSCRIPTION_PRODUCTION_NOT_VALIDATED`.
Model/low/subscription a limity 180000/200000/5000 ms, 8 MiB se nemění.

Přijatý rozdíl mezi CLI brokerem a příkazy odpovídá tomu, že CLI konfigurace
odděleně řídí shell a app nástroje; samotný network proxy jejich všechny cesty
nefiltruje. [Oficiální reference konfigurace](https://learn.chatgpt.com/docs/config-file/config-reference).
Tato aktuální dokumentace není sama ověřením implementace pinned CLI 0.145.0.
