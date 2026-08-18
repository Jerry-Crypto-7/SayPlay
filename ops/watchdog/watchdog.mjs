#!/usr/bin/env node
/**
 * Watchdog — **běží mimo hlídaný proces, a to je celý jeho smysl.**
 *
 * Hlídač uvnitř hlídaného procesu ohlídá jen ty poruchy, které ten proces
 * přežije: zaseknutou smyčku, plnou paměť, uvíznutí. Neohlídá ani jednu z těch,
 * kvůli kterým se hlídač píše — zabití zvenčí, `OOM killer`, pád runtime,
 * vypnutý stroj. Ve všech čtyřech případech zemře společně s tím, co měl
 * hlásit, a **záznam o poruše nevznikne**. Zdravotní kontrola tak vypadá stejně
 * jako klidný provoz: v obou případech nepřijde nic.
 *
 * Tenhle soubor se proto spouští jako **samostatný proces**. Když hlídaný
 * proces zabijete, tenhle běží dál a zápis provede.
 *
 * ## Ticho není v tomhle souboru nikdy dobrá zpráva
 *
 * Watchdog se spouští s `stdio: 'ignore'` a nikdo se na něj nedívá, takže každá
 * cesta, na které umře bez zápisu, vypadá zvenčí přesně jako klidný provoz —
 * tedy jako to jediné, co má tenhle soubor vyloučit. Proto:
 *
 * - **zapisovatelnost logu se ověří na startu**, ne až u prvního záznamu. Bez
 *   toho by chybný adresář shodil watchdog až ve chvíli poruchy, kterou měl
 *   ohlásit;
 * - **selhání zápisu končí nenulovým návratovým kódem a hláškou na `stderr`**,
 *   nikdy tichým pádem;
 * - **návratové kódy se rozlišují**: `2` špatné parametry, `3` nezapisovatelný
 *   log, `4` zápis selhal za běhu. Spouštěč tak pozná, co se stalo, i když
 *   výstup nikam nevede.
 *
 * ## Proč `process.kill(pid, 0)` a ne dotaz na HTTP
 *
 * Signál 0 se neposílá — jádro jen ověří, že proces existuje a že na něj máme
 * právo. Nepotřebuje port, nepotřebuje, aby hlídaný proces cokoli obsluhoval, a
 * odpoví i procesu, který se zasekl. Dotaz na HTTP by měřil něco jiného: to, že
 * obsluha odpovídá. Obojí je užitečné a tohle je to spodní z nich — existenci
 * procesu.
 *
 * ## Záznam je řádkový JSON, ne řádka do logu
 *
 * Čte to test a čte to člověk po incidentu. Připisuje se, nikdy nepřepisuje:
 * dva běhy nad týmž souborem jsou dvě události, ne poslední z nich.
 *
 * ```
 * node ops/watchdog/watchdog.mjs --pid 1234 --log ops/watchdog.jsonl \
 *   --interval-ms 100 --label emit-server
 * ```
 */

import { appendFileSync } from 'node:fs';

function argument(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at + 1 >= process.argv.length) return fallback;
  return process.argv[at + 1];
}

const pid = Number(argument('pid'));
const logPath = argument('log');
const intervalMs = Number(argument('interval-ms', '250'));
const label = argument('label', 'unnamed');
/**
 * Kdy to vzdát, když hlídaný proces žije dál. **`0` znamená nikdy**, a je to
 * výchozí hodnota: hlídač, který se po minutě sám vypne, přestane hlídat přesně
 * v tu chvíli, kdy je provoz nejdelší. Omezení je pro testy a pro ruční běh.
 */
const maxMs = Number(argument('max-ms', '0'));

if (!Number.isInteger(pid) || pid <= 0 || logPath === undefined) {
  process.stderr.write('watchdog: --pid <n> a --log <cesta> jsou povinné\n');
  process.exit(2);
}

/** Zápis, který selže nahlas. Tichý pád by byl k nerozeznání od klidného provozu. */
function record(event, extra = {}, exitCodeOnFailure = 4) {
  try {
    appendFileSync(logPath, `${JSON.stringify({ event, pid, label, at: Date.now(), ...extra })}\n`, 'utf-8');
  } catch (error) {
    process.stderr.write(`watchdog: zápis do ${logPath} selhal: ${error.message}\n`);
    process.exit(exitCodeOnFailure);
  }
}

/**
 * Žije hlídaný proces?
 *
 * `EPERM` i `EACCES` znamenají „existuje, ale není náš" — tedy žije. Kdyby se
 * odepřený přístup počítal jako smrt, watchdog by ohlásil pád pokaždé, když ho
 * někdo spustí pod jiným účtem než hlídanou službu, což je běžné nasazení.
 *
 * **Naměřeno na téhle Windows stanici** (`process.kill(4, 0)` na systémový
 * proces): vrací `EPERM`, ne `EACCES`. Recenze tvrdila opak — že libuv mapuje
 * odepřený `OpenProcess` na `EACCES` — a pro tuhle cestu to neplatí. `EACCES` se
 * proto přijímá jako pojistka pro platformy, kde by to platit mohlo, ne jako
 * popis toho, co se tady děje. **Obě větve mají vlastní test** a ani jedna se
 * neopírá o cizí PID: test si chybu vyrobí předehrou, která `process.kill`
 * nahradí, takže `ESRCH` vedle nich měří rozdíl, ne shodu.
 */
function alive() {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM' || error.code === 'EACCES';
  }
}

// Zapisovatelnost se ověřuje TEĎ, ne až u poruchy. Kód 3 se liší od 4 schválně:
// „nikdy jsem nezačal" je jiný stav než „přestal jsem uprostřed".
record('watching', { intervalMs, maxMs }, 3);

if (!alive()) {
  record('process-gone', { detected: 'at-start' });
  process.exit(0);
}

const startedAt = Date.now();
const timer = setInterval(() => {
  if (!alive()) {
    clearInterval(timer);
    record('process-gone', { detected: 'while-watching', watchedForMs: Date.now() - startedAt });
    process.exit(0);
  }

  if (maxMs > 0 && Date.now() - startedAt >= maxMs) {
    clearInterval(timer);
    record('gave-up', { watchedForMs: Date.now() - startedAt });
    process.exit(0);
  }
}, intervalMs);
