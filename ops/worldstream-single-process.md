# Návrh provozu Reality Compileru na jednom procesu

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
