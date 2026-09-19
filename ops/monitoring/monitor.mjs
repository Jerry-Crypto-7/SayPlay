#!/usr/bin/env node
/**
 * **Hlídač dostupnosti — obejde cíle z `uptime.json` a zapíše tep.**
 *
 * `scripts/submission-check.mjs` kontrola [7] chce po `heartbeatPath` poslední
 * řádek s čitelným `at` ne starším než trojnásobek `intervalSeconds`, a v něm
 * všechny tři adresy z manifestu. Tenhle soubor je jediné, co ten řádek
 * vyrábí; bez něj je `uptime.json` záměr, ne hlídání.
 *
 * ## Ticho není zpráva
 *
 * Cíl, který neodpoví, spadne na 500 nebo vyprší, se **zapíše** jako
 * `ok:false` — hlídač kvůli němu nikdy nespadne a řádek nikdy nezahodí.
 * Zahozený řádek by kontrola [7] přečetla jako „hlídač neběží", což je
 * pravda o něčem jiném, než co se stalo. Jediné, co hlídače shodí, je to,
 * bez čeho nemá co dělat: nečitelná konfigurace (`2`) a nezapisovatelný tep (`3`).
 *
 * ```
 * node ops/monitoring/monitor.mjs --once  [--config ops/monitoring/uptime.json]
 * node ops/monitoring/monitor.mjs --loop  [--config ops/monitoring/uptime.json]
 * ```
 *
 * Bez závislostí: `fetch` a `AbortSignal.timeout` jsou v Node 18+.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_CONFIG = resolve(REPO_ROOT, 'ops/monitoring/uptime.json');
const TIMEOUT_MS = 10_000;

function argument(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at + 1 >= process.argv.length) return fallback;
  return process.argv[at + 1];
}

/** Jeden cíl → `{url, status, ms, ok}`. Chyba sítě je `status:null`, ne výjimka. */
async function probe(url) {
  const started = performance.now();
  try {
    const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { url, status: response.status, ms: Math.round(performance.now() - started), ok: response.ok };
  } catch (error) {
    return { url, status: null, ms: Math.round(performance.now() - started), ok: false, error: error.message };
  }
}

async function beat(config, heartbeatPath) {
  const targets = await Promise.all(config.targets.map((target) => probe(target.url)));
  const line = { at: new Date().toISOString(), targets };
  try {
    appendFileSync(heartbeatPath, `${JSON.stringify(line)}\n`, 'utf-8');
  } catch (error) {
    process.stderr.write(`uptime-monitor: writing ${heartbeatPath} failed: ${error.message}\n`);
    process.exit(3);
  }
}

async function main() {
  const configPath = resolve(argument('config', DEFAULT_CONFIG));
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    process.stderr.write(`uptime-monitor: cannot read ${configPath}: ${error.message}\n`);
    process.exit(2);
  }
  const heartbeatPath = resolve(REPO_ROOT, config.heartbeatPath);

  await beat(config, heartbeatPath);
  if (!process.argv.includes('--loop')) return;

  // Interval se počítá od konce obchůzky, ne od jejího začátku — pomalý cíl
  // u stropu 10 s nesmí naskládat dvě obchůzky přes sebe.
  for (;;) {
    await new Promise((tick) => setTimeout(tick, config.intervalSeconds * 1000));
    await beat(config, heartbeatPath);
  }
}

// Spouští se jenom jako program; `pathToFileURL` kvůli písmenu disku na Windows.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
