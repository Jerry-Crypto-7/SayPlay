#!/usr/bin/env node
/**
 * **Prober živosti dema — měří práci, ne HTTP 200.**
 *
 * ## Proč `ops/watchdog/watchdog.mjs` nestačil a proč se nepřepisuje
 *
 * Ten hlídá **PID**: ptá se jádra, jestli proces existuje. To je nejspodnější
 * patro živosti a je užitečné — jenže proces, který běží, poslouchá na portu a
 * na každý dotaz odpoví prázdnem, je z jeho pohledu úplně zdravý. Tenhle soubor
 * je patro nad ním a oba dávají smysl vedle sebe.
 *
 * ## Dvě patra, a každé vylučuje jinou lež
 *
 * | Kontrola | Co vyloučí, co to pod ní nevyloučí |
 * |---|---|
 * | `/api/health` | „port poslouchá" — sonda doopravdy zapíše a přečte zpátky |
 * | publikovaná hra se dá stáhnout zpátky | „úložiště je zdravé, ale hry v něm nejsou" — data, která si vezme prohlížeč, existují |
 *
 * Druhé patro je **slabší tvrzení než „hra se v prohlížeči hraje"**: prober
 * stáhne přesně ta data, která si stránka `/play/:id` bere z
 * `/api/play/games/:id`, a ověří, že je v nich hratelný svět; nespustí prohlížeč
 * a nevykreslí ani jeden trojúhelník. Ten důkaz dělá e2e sada nad skutečným
 * canvasem a nedá se z hlídače bez dozoru mít.
 *
 * ## Hlídač nic netvoří
 *
 * Nová hra by na nasazení s klíčem spustila i AI verzi, a ta je placené volání
 * modelu. Hlídač běžící po minutách by tak uměl utratit rozpočet dřív, než si
 * toho někdo všimne — proto jen čte: health a jednu už existující hru.
 *
 * ## Ticho není dobrá zpráva ani tady
 *
 * Táž doktrína jako v `watchdog.mjs`: zapisovatelnost logu se ověří na startu,
 * selhání zápisu končí nenulovým kódem a hláškou na `stderr`, a návratové kódy
 * se rozlišují — `2` špatné parametry, `3` nezapisovatelný log, `4` zápis
 * selhal za běhu, `5` cíl neprošel kontrolou.
 *
 * ```
 * node ops/watchdog/worldstream.mjs --target https://demo.example \
 *   --log ops/worldstream-watchdog.jsonl [--game 5f3a…]
 * ```
 *
 * `--game` bere **holé id i celou cestu** — `gameAddress()` doplní
 * `/api/play/games/` tomu prvnímu.
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Adresa publikované hry z toho, co operátor napsal na příkazovou řádku.
 *
 * `checkGame` skládá `${target}${address}`, takže **holé id se musí na cestu
 * doplnit tady** — jinak `--game 5f3a…` složí `https://demo.example5f3a…`
 * a skončí `GAME_UNREADABLE`, tedy poruchou cíle, který je ve skutečnosti zdravý.
 */
export function gameAddress(value) {
  if (value === null || value.startsWith('/')) return value;
  return `/api/play/games/${value}`;
}

/**
 * Proč cíl neprošel. Uzavřený seznam: nový důvod se musí pojmenovat, jinak by
 * se v logu po incidentu četlo jen „selhalo".
 */
export const PROBE_FAILURES = [
  /** Entire probe (including response bodies) exceeded its wall-clock budget. */
  'PROBE_TIMEOUT',
  /** `/api/health` neodpovědělo, nebo odpovědělo „nepřipraven". */
  'HEALTH_NOT_READY',
  /** Hra pod adresou se nedá stáhnout, nebo v ní není hratelný svět. */
  'GAME_UNREADABLE',
];

function failure(reason, detail) {
  return { ok: false, reason, detail };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Patro 1 — připravenost. Vlastní sondu nemá, ptá se té, kterou má server:
 * `/api/health` doopravdy zapíše, přečte zpátky, porovná a uklidí.
 */
async function checkHealth(target, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${target}/api/health`, { method: 'GET' });
  } catch (error) {
    return failure('HEALTH_NOT_READY', `health request failed: ${error.message}`);
  }
  const body = await readJson(response);
  if (response.status !== 200 || body?.ready !== true)
    return failure('HEALTH_NOT_READY', `health answered ${response.status} ${body?.reason ?? ''}`.trim());
  return { ok: true, elapsedMs: body.elapsedMs ?? null };
}

/**
 * Patro 2 — data, která si vezme prohlížeč, doopravdy existují.
 *
 * Kontroluje se **obsah**, ne stavový kód: 200 s prázdným tělem je přesně ta
 * lež, kvůli které tenhle soubor nevěří 200 nikde jinde. Hratelný svět je
 * `arcade` u arkády, nebo `blueprint` u mřížky (`PublishedGame`).
 */
async function checkGame(target, address, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${target}${address}`, { method: 'GET' });
  } catch (error) {
    return failure('GAME_UNREADABLE', `game request failed: ${error.message}`);
  }
  if (response.status !== 200) return failure('GAME_UNREADABLE', `game answered ${response.status}`);

  const body = await readJson(response);
  const world = body?.arcade ?? body?.blueprint;
  if (typeof body?.spec !== 'object' || body.spec === null || typeof world !== 'object' || world === null)
    return failure('GAME_UNREADABLE', 'the game carried no playable world');

  return { ok: true, title: body.version?.title ?? null };
}

/**
 * Celý prober. `fetch` jde dovnitř parametrem, takže se dá bez síťování změřit
 * i každá cesta selhání — a právě ty jsou to, kvůli čemu hlídač existuje.
 */
async function runProbe({ target, fetchImpl, game = null }) {
  const checks = {};

  const health = await checkHealth(target, fetchImpl);
  if (!health.ok) return { ok: false, reason: health.reason, detail: health.detail, checks };
  checks.health = { ready: true, elapsedMs: health.elapsedMs };

  const address = gameAddress(game);
  if (address !== null) {
    const read = await checkGame(target, address, fetchImpl);
    if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail, checks };
    checks.game = { address, title: read.title };
  }

  return { ok: true, checks };
}

/** A stalled socket or response body cannot keep the operational watchdog alive forever. */
export async function probeWorldstream(options) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000)
    throw new Error('timeoutMs must be between 1 and 3600000');
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: 'PROBE_TIMEOUT', detail: 'The complete probe exceeded its deadline.', checks: {} });
    }, timeoutMs);
  });
  try {
    return await Promise.race([runProbe({ ...options, fetchImpl: (url, init) =>
      fetchImpl(url, { ...init, signal: controller.signal }) }), timeout]);
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function argument(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at + 1 >= process.argv.length) return fallback;
  return process.argv[at + 1];
}

/** Zápis, který selže nahlas. Tichý pád je k nerozeznání od klidného provozu. */
function record(logPath, event, exitCodeOnFailure) {
  try {
    appendFileSync(logPath, `${JSON.stringify({ at: Date.now(), ...event })}\n`, 'utf-8');
  } catch (error) {
    process.stderr.write(`worldstream-watchdog: zápis do ${logPath} selhal: ${error.message}\n`);
    process.exit(exitCodeOnFailure);
  }
}

async function main() {
  const target = argument('target');
  const logPath = argument('log');

  if (target === undefined || logPath === undefined) {
    process.stderr.write('worldstream-watchdog: --target <url> a --log <cesta> jsou povinné\n');
    process.exit(2);
  }

  // Rozsah, ne jen tvar čísla: `Number('')` je nula a `NaN` by z celkového
  // stropu udělal strop, který nikdy nevyprší. Kontroluje se **před** `record()`,
  // aby špatný parametr skončil kódem 2 a nesáhl ani na log, ani na síť.
  const raw = argument('timeout-ms', '30000');
  const timeoutMs = Number(raw);
  if (!(timeoutMs >= 1) || !(timeoutMs <= 3_600_000)) {
    process.stderr.write(`worldstream-watchdog: --timeout-ms musí být číslo mezi 1 a 3600000, ne ${JSON.stringify(raw)}\n`);
    process.exit(2);
  }

  // Zapisovatelnost se ověří TEĎ, ne až u prvního nálezu. Chybný adresář by
  // jinak shodil hlídače přesně ve chvíli poruchy, kterou měl ohlásit.
  record(logPath, { event: 'watchdog.started', target }, 3);

  const verdict = await probeWorldstream({
    target: target.replace(/\/+$/, ''),
    game: argument('game', null),
    timeoutMs,
  });

  record(logPath, { event: verdict.ok ? 'watchdog.ok' : 'watchdog.failed', target, ...verdict }, 4);
  process.exit(verdict.ok ? 0 : 5);
}

// Spouští se jako program jenom tehdy, když ho někdo spustil jako program.
// Importuje ho test, a ten nechce, aby se z importu stal běh. `pathToFileURL`
// schválně: na Windows je `process.argv[1]` cesta s písmenem disku a ruční
// složení `file://…` z ní udělá URL s hostitelem `d`, takže by se porovnání
// nikdy netrefilo a CLI by se z testu nedalo spustit vůbec.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
