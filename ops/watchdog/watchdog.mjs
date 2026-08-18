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
/** Kdy to vzdát, když hlídaný proces žije dál. Bez toho by watchdog přežil běh. */
const maxMs = Number(argument('max-ms', '60000'));

if (!Number.isInteger(pid) || pid <= 0 || logPath === undefined) {
  process.stderr.write('watchdog: --pid <n> a --log <cesta> jsou povinné\n');
  process.exit(2);
}

function record(event, extra = {}) {
  appendFileSync(logPath, `${JSON.stringify({ event, pid, label, at: Date.now(), ...extra })}\n`, 'utf-8');
}

/**
 * Žije hlídaný proces?
 *
 * `EPERM` znamená „existuje, ale není náš" — tedy žije. Kdyby se to počítalo
 * jako smrt, watchdog by ohlásil pád pokaždé, když ho někdo spustí pod jiným
 * uživatelem než hlídanou službu, což je běžné nasazení.
 */
function alive() {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

if (!alive()) {
  record('process-gone', { detected: 'at-start' });
  process.exit(0);
}

record('watching', { intervalMs, maxMs });

const startedAt = Date.now();
const timer = setInterval(() => {
  if (!alive()) {
    clearInterval(timer);
    record('process-gone', { detected: 'while-watching', watchedForMs: Date.now() - startedAt });
    process.exit(0);
  }

  if (Date.now() - startedAt >= maxMs) {
    clearInterval(timer);
    record('gave-up', { watchedForMs: Date.now() - startedAt });
    process.exit(0);
  }
}, intervalMs);
