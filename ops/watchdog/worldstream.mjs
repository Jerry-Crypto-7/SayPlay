#!/usr/bin/env node
/**
 * **Prober živosti worldstreamu — měří práci, ne HTTP 200.**
 *
 * Design book §24: *„Watchdog kontroluje skutečnou práci, ne HTTP 200: založí
 * omezenou relaci s mockovaným modelem, dostane `world.ready`, ověří, že se
 * v prohlížeči svět načte."*
 *
 * ## Proč `ops/watchdog/watchdog.mjs` nestačil a proč se nepřepisuje
 *
 * Ten hlídá **PID**: ptá se jádra, jestli proces existuje. To je nejspodnější
 * patro živosti a je užitečné — jenže proces, který běží, poslouchá na portu a
 * na každou větu odpoví `session.failed`, je z jeho pohledu úplně zdravý.
 * Tenhle soubor je patro nad ním a oba dávají smysl vedle sebe.
 *
 * ## Tři patra, a každé vylučuje jinou lež
 *
 * | Kontrola | Co vyloučí, co to pod ní nevyloučí |
 * |---|---|
 * | `/api/health` | „port poslouchá" — sonda doopravdy zapíše a přečte zpátky |
 * | relace dojde do fáze `world` | „server odpovídá 202" — svět doopravdy vznikl |
 * | sdílený svět se dá stáhnout zpátky | „vzniklo to a hned to zmizelo" — data, která si vezme prohlížeč, existují |
 *
 * Poslední řádek je to, co tenhle soubor umí říct o větě *„svět se v prohlížeči
 * načte"*, a **je to slabší tvrzení než ta věta**. Prober stáhne přesně ta data,
 * která si viewer bere z \`/api/worldstream/snapshots/:hash\`, a ověří, že jsou
 * celá; nespustí prohlížeč a nevykreslí ani jeden trojúhelník. Ten důkaz dělá
 * e2e sada nad skutečným canvasem a nedá se z hlídače bez dozoru mít — a psát
 * do logu „svět se načetl", když se ověřilo jen stažení, by z hlídače udělalo
 * další zdroj té lži, kterou má odhalovat.
 *
 * ## Placené volání: výchozí režim ho nemůže spustit
 *
 * Zakládání relace **je** volání modelu, a na nasazení s klíčem se za něj platí.
 * Hlídač běžící po minutách by tedy uměl utratit rozpočet dřív, než si toho
 * někdo všimne. Proto je rozdělený na dva režimy:
 *
 * - **výchozí (read-only)** — health a jeden už existující sdílený svět. Žádný
 *   prompt neodejde, takže se **nedá** utratit nic. Tohle patří na produkci.
 * - **`--allow-generation`** — přidá založení relace. Je určený pro cíl
 *   s mockovaným modelem (`WORLDSMITH_BRANCH` jiné než `live`), kde je volání
 *   zdarma, a operátor to zapnutím toho přepínače tvrdí.
 *
 * Přepínač sám o sobě není mechanismus — mechanismem je **výchozí hodnota**:
 * hlídač zapomenutý na produkci s výchozím nastavením nemá cestu, kterou by
 * peníze utratil.
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
 *   --log ops/worldstream-watchdog.jsonl --shared 5f3a… [--allow-generation]
 * ```
 */

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Jak dlouho se čeká, než relace dojde do fáze `world`. */
export const DEFAULT_WORLD_DEADLINE_MS = 20_000;

/** Jak často se ptá snapshotu relace. */
export const DEFAULT_POLL_MS = 250;

/** Věta, kterou prober zakládá relaci. Konstantní schválně — hlídač netvoří. */
export const PROBE_PROMPT = 'a small stone room with a single door';

/**
 * Proč cíl neprošel. Uzavřený seznam: nový důvod se musí pojmenovat, jinak by
 * se v logu po incidentu četlo jen „selhalo".
 */
export const PROBE_FAILURES = [
  /** `/api/health` neodpovědělo, nebo odpovědělo „nepřipraven". */
  'HEALTH_NOT_READY',
  /** Zakládání relace neskončilo očekávanou 202 s `sessionId`. */
  'SESSION_REFUSED',
  /** Relace se do deadlinu nedostala do fáze `world`. */
  'WORLD_NEVER_READY',
  /** Relace skončila poruchou — server běží a světy nevyrábí. */
  'WORLD_FAILED',
  /** Fáze je `world`, ale blueprint je prázdný nebo chybí. */
  'WORLD_EMPTY',
  /** Hotový svět nemá adresu, takže si ho prohlížeč nemá kde vzít. */
  'SHARED_WORLD_MISSING',
  /** Adresa je, ale data pod ní se nedají stáhnout celá. */
  'SHARED_WORLD_UNREADABLE',
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
 * Patro 3 — data, která si vezme prohlížeč, doopravdy existují.
 *
 * Kontroluje se **obsah**, ne stavový kód: 200 s prázdným tělem je přesně ta
 * lež, kvůli které tenhle soubor nevěří 200 nikde jinde.
 */
async function checkSharedWorld(target, address, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(`${target}${address}`, { method: 'GET' });
  } catch (error) {
    return failure('SHARED_WORLD_UNREADABLE', `shared world request failed: ${error.message}`);
  }
  if (response.status !== 200)
    return failure('SHARED_WORLD_UNREADABLE', `shared world answered ${response.status}`);

  const body = await readJson(response);
  const objects = body?.blueprint?.objects;
  if (!Array.isArray(objects) || objects.length === 0)
    return failure('SHARED_WORLD_UNREADABLE', 'the shared world carried no objects');

  return { ok: true, objects: objects.length, title: body.title ?? null };
}

/**
 * Patro 2 — z věty vznikne svět.
 *
 * Čte se **snapshot relace**, ne proud událostí. Proud je pro prohlížeč, který
 * chce vidět mezikroky; hlídač chce vědět jediné — jestli to došlo na konec — a
 * snapshot je autoritativní odpověď na přesně tuhle otázku (§21). Navíc přežije
 * přerušené spojení, což je stav, ve kterém hlídač často je.
 */
async function checkGeneration(target, fetchImpl, clock) {
  let created;
  try {
    created = await fetchImpl(`${target}/api/worldstream/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: PROBE_PROMPT }),
    });
  } catch (error) {
    return failure('SESSION_REFUSED', `session request failed: ${error.message}`);
  }

  const opened = await readJson(created);
  if (created.status !== 202 || typeof opened?.sessionId !== 'string')
    return failure('SESSION_REFUSED', `sessions answered ${created.status}`);

  const startedAtMs = clock.now();
  for (;;) {
    let response;
    try {
      response = await fetchImpl(`${target}/api/worldstream/sessions/${opened.sessionId}`, { method: 'GET' });
    } catch (error) {
      return failure('WORLD_NEVER_READY', `snapshot request failed: ${error.message}`);
    }
    const snapshot = await readJson(response);

    if (snapshot?.phase === 'failed')
      return failure('WORLD_FAILED', String(snapshot.fault ?? 'the session failed without a reason'));

    if (snapshot?.phase === 'world') {
      const objects = snapshot.blueprint?.objects;
      if (!Array.isArray(objects) || objects.length === 0)
        return failure('WORLD_EMPTY', 'the session reached `world` with no objects');
      if (typeof snapshot.sharedWorld !== 'string')
        return failure('SHARED_WORLD_MISSING', 'the finished world has no address to load from');
      return {
        ok: true,
        sessionId: opened.sessionId,
        sharedWorld: snapshot.sharedWorld,
        objects: objects.length,
        elapsedMs: clock.now() - startedAtMs,
      };
    }

    if (clock.now() - startedAtMs >= clock.deadlineMs)
      return failure('WORLD_NEVER_READY', `still in phase ${snapshot?.phase ?? 'unknown'} after the deadline`);

    await clock.wait(clock.pollMs);
  }
}

/**
 * Celý prober. `fetch` i hodiny jdou dovnitř parametrem, takže se dá bez
 * síťování a bez čekání změřit i každá cesta selhání — a právě ty jsou to,
 * kvůli čemu hlídač existuje.
 */
export async function probeWorldstream(options) {
  const {
    target,
    fetchImpl = fetch,
    sharedWorld = null,
    allowGeneration = false,
    now = () => Date.now(),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    deadlineMs = DEFAULT_WORLD_DEADLINE_MS,
    pollMs = DEFAULT_POLL_MS,
  } = options;

  const checks = {};

  const health = await checkHealth(target, fetchImpl);
  if (!health.ok) return { ok: false, reason: health.reason, detail: health.detail, checks };
  checks.health = { ready: true, elapsedMs: health.elapsedMs };

  // **Adresa sdíleného světa se bere z generace, když proběhla, jinak z
  // parametru.** Read-only režim tak umí ověřit patro 3 nad světem, který
  // vznikl dřív — a je to zároveň jediná kontrola, která na produkci s klíčem
  // dává smysl pouštět po minutách.
  let address = sharedWorld;

  if (allowGeneration) {
    const generation = await checkGeneration(target, fetchImpl, { now, wait, deadlineMs, pollMs });
    if (!generation.ok) return { ok: false, reason: generation.reason, detail: generation.detail, checks };
    checks.generation = {
      objects: generation.objects,
      elapsedMs: generation.elapsedMs,
      sessionId: generation.sessionId,
    };
    address = generation.sharedWorld;
  }

  if (address !== null) {
    const shared = await checkSharedWorld(target, address, fetchImpl);
    if (!shared.ok) return { ok: false, reason: shared.reason, detail: shared.detail, checks };
    checks.sharedWorld = { address, objects: shared.objects };
  }

  return { ok: true, checks };
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function argument(name, fallback = undefined) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1 || at + 1 >= process.argv.length) return fallback;
  return process.argv[at + 1];
}

function flag(name) {
  return process.argv.includes(`--${name}`);
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

  // Zapisovatelnost se ověří TEĎ, ne až u prvního nálezu. Chybný adresář by
  // jinak shodil hlídače přesně ve chvíli poruchy, kterou měl ohlásit.
  record(logPath, { event: 'watchdog.started', target }, 3);

  const verdict = await probeWorldstream({
    target: target.replace(/\/+$/, ''),
    sharedWorld: argument('shared', null),
    allowGeneration: flag('allow-generation'),
    deadlineMs: Number(argument('deadline-ms', String(DEFAULT_WORLD_DEADLINE_MS))),
    pollMs: Number(argument('poll-ms', String(DEFAULT_POLL_MS))),
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
