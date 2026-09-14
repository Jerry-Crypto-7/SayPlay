# Lokální demo přes předplatné

## Aktuální brána — 10. 9. 2026, sedmá auditní session

Výchozí legacy launcher je nyní **zablokovaný před loginem a spawnem** chybou `SUBSCRIPTION_PRODUCTION_NOT_VALIDATED`. Odstraněny jsou binary/distro env overrides. Níže uvedené živé výsledky a spuštění popisují historický stav 8. 9.; nejsou důkazem současné připravenosti. Nový credential-free CLI supervisor, resource envelope a ordinary browser orchestrace se validují odděleně. Max/model `gpt-5.6-sol`/effort `low` zůstávají stejné; žádný API fallback.

Odemčení vyžaduje skutečný pevný dispatcher a ověření jeho filesystem/control/auth/network/resource/cleanup hranic. Synthetic sandbox PASS ani status přihlášení z historického běhu to nenahrazují. Neprovádět přímý login příkaz níže jako náhradu této brány.

Rozhodnutí uživatele, 8. 9. 2026: demo má využít již placený Claude Code / Codex plán. Dodatečný API rozpočet je **0 USD**. Toto upřesnění nahrazuje požadavek na API klíč a USD limit pro demo; nesmí se automaticky zapnout API fallback ani dobíjení.

## Zvolená cesta a skutečný stav

Pro vlastní lokální demo je připojen oficiální Codex CLI přihlášený přes ChatGPT. `npm run demo:subscription` otevře ovládané Chromium a vlastní server pouze na `127.0.0.1:3116`. Source request se přes lokální Playwright bridge dostane do stejného source handleru a proposeru; ostatní API cesty jsou v tomto okně blokované. Přístup k CLI není veřejný HTTP endpoint. Původní cold API transport zůstává oddělený.

Ověřeno na tomto stroji:

- WSL2: `Ubuntu-24.04`, Linux `6.18.33.2-microsoft-standard-WSL2`.
- Linuxový Codex CLI na PATH ve WSL (`CODEX_WSL_BINARY` přepíše cestu, `CODEX_WSL_DISTRO` distribuci), verze `0.145.0`.
- Vestavěný profil `:read-only` skutečně odmítl testovací zápis do `scratch/subscription-demo` a vytvoření síťového socketu. Test sandboxu nevolal model.
- Po uživatelově přihlášení oficiální `codex login status` ve WSL: **Logged in using ChatGPT**. Nebyly čteny ani kopírovány soubory přihlášení.

Při budoucím odhlášení použít oficiální tok `wsl -d Ubuntu-24.04 --exec codex login` s ChatGPT předplatným. Žádný token ani klíč se neposílá do chatu nebo aplikace. Adaptér ověřuje ChatGPT login před každým voláním, odstraní API proměnné z prostředí volaného procesu a vynucuje ChatGPT autentizaci bez načítání uživatelské konfigurace poskytovatelů. Shell, web search a apps jsou pro emisi vypnuté; model dostává jen instrukce a source data. Výstup s neočekávaným použitím nástrojů se odmítne.

## Spuštění

Po změně aplikace nejprve `npm run build`. Pro ruční demo spustit `npm run demo:subscription`, v otevřeném okně použít **Build from a source**. Předvyplněný `subscription-demo-source.txt` obsahuje i přesnou geometrii a pohyb. Jiné zdroje mohou vyžadovat upřesnění. Skutečný serverový limit source vstupu je 2000 znaků; 4000 uvedených v obecném evidence UI tento limit nemění.

Pro automatickou ukázku ve viditelném okně v PowerShellu:

```powershell
$env:RC_DEMO_GUIDED='1'
npm run demo:subscription
```

Ukázka vytvoří čerstvou scénu, aktivuje A, přesune návštěvníka, po 13 sekundách aktivuje B, změní časovač z 20 na 10 sekund a ověří rozdíl větví. Okno poté zůstane otevřené. Zavření okna ukončí lokální server; relace má limit 30 minut. Pro další ruční start vymazat `RC_DEMO_GUIDED`. Nepřecházet do běžného odděleně otevřeného browseru: připojení k předplatnému platí pouze v okně otevřeném spouštěčem.

`RC_DEMO_SMOKE=1` spouští stejnou ověřovací sekvenci headless a po skončení okno zavře. `RC_DEMO_PROBE=1` provede pouze minimální ověření JSON spojení. Žádný z těchto režimů není třicetipárový benchmark. Každá relace má vlastní `scratch/subscription-demo/<uuid>/journal.jsonl`, výstupy zdroje a při ověřovacím průchodu screenshot a runtime observation.

## Implementační návaznost

- [x] Ověřit oficiální podporu, nainstalovaný runtime a skutečné chování sandboxu.
- [x] Lokální oddělený adaptér, stejný source proposer/validace/runtime, pouze deklarativní JSON přes stdin, bez veřejného CLI endpointu.
- [x] Ověření subscription loginu, žádný API fallback; nejvýš 12 volání na relaci, jedno současně, Linux timeout 180 s a vnější timeout 200 s. Chyba emitoru zastaví další generování v dané relaci. Shell/web/apps jsou vypnuté; credential soubory se nepřenášejí.
- [x] Účetnictví `subscription`, usage a wall time, USD cena neurčená. Neznámé usage zůstává null. Journal se zapíše před voláním; při selhání zápisu se model nespustí.
- [x] Ověřen celý čerstvý browserový průchod včetně skutečných vstupů a rozdílu větví. Není to fixture ani replay modelové odpovědi.

## Důkaz a nalezené vady

8. 9. 2026: 50 cílených testů a TypeScript prošly. Produkční build prošel. Živý smoke test skončil úspěšně s kódem 0; modelové volání trvalo 93 611 ms, usage 12 643 input / 2 322 output tokens (reasoning 481 vykázán poskytovatelem zvlášť). Celý test přibližně 151 s. Je to jedno pozorování, nikoli medián nebo p95.

Archiv úspěchu: `scratch/subscription-demo/e4b7f74c-8e4f-40f8-99bf-9adfcde1d70b/`. Screenshot byl zkontrolován. Původní větev: `case:locked=0`, `alarm=0`; změněná: `case:locked=1`, `alarm=1`, společný horizont 352, zásah 400→200 ticků ve forku 0.

Po finálním buildu prošla také viditelná automatická ukázka: `scratch/subscription-demo/4d8ed920-7674-4ca0-9dcd-a98e24d31fcc/`, marker `GUIDED_DEMO_VERIFIED`, stejné očekávané výsledky při společném horizontu 330. Model 85 524 ms, usage 12 635 input (6 656 cached) / 2 130 output, reasoning 482 vykázán zvlášť. Screenshot zkontrolován, okno ponecháno uživateli. Jde tedy o dva úspěšné čerstvé průchody po opravě promptu, nikoli obecnou garanci rychlosti nebo kvality.

Předchozí pokusy se neztratily: jeden timeout s UNKNOWN usage, úspěšný minimální connection probe, dvě žádosti o doplnění prostoru/pohybu, jeden vstup odmítnutý před inferencí kvůli délce a jeden neplatný modelový návrh. Source prompt postrádal přesný wire formát a model vymyslel jiné tvary soketů a entit. `source-surface-guide.ts` nyní dodává obecný syntaxový příklad ověřený skutečným runtimem; není to muzejní oracle. Adaptér poskytuje mechanicky odvozené UTF-8 line spans. Strukturní validace ani tyto spans nenahrazují lidské sémantické review.

Demo nevyžaduje nejprve třicetipárový cold benchmark a pět lidí. T11 výzkumné brány přesto zůstávají NOT_RUN, dokud nejsou skutečně změřeny. Připravené scény lze ukázat jako připravené; nejsou důkazem čerstvé inference ani latence předplatného.

## Oficiální podklady ověřené 8. 9. 2026

- [Codex: přihlášení přes ChatGPT versus samostatně účtovaný API klíč](https://learn.chatgpt.com/docs/auth).
- [Codex: neinteraktivní CLI, JSON a schéma výstupu](https://learn.chatgpt.com/docs/non-interactive-mode).
- [Claude Code s Pro/Max: společné limity a oddělené API účtování](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).

Claude Max také zahrnuje Claude Code, ale nelze jej automaticky považovat za API kredit pro současný HTTP provider. Toto demo používá Codex/ChatGPT login. Zbývající kvóta a případné již zakoupené kredity účtu nebyly nezávisle ověřeny; adaptér nemění účtovací nastavení ani nezřizuje placenou službu. Čerstvá inference je výslovně vedena jako spotřeba předplatného, nikoli nulová tokenová cena.

Přesný čas úspěšného vývojového CLI volání v archivu e4b7f74c-8e4f-40f8-99bf-9adfcde1d70b je 93611 ms (93.611 s). Zahrnuje lokální transport a CLI režii, nikoli jen výpočet poskytovatele.
