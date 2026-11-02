/**
 * Skript úrovně na serveru ve vlastním vlákně (P68 R4, nález revize T13): `runScript` v `worker_threads`, pojistka hodin.
 *
 * O výsledku rozhoduje rozpočet kroků (`sandbox.ts`), stejný ve všech prostředích. Obsluhu přerušení ale QuickJS volá
 * jen mezi kroky interpretu, takže práce uvnitř jedné vestavěné funkce jí proteče: `"a".repeat(4e6)` a `indexOf` ve
 * smyčce běžely naměřeně > 10 min při 10 000 krocích a celou dobu držely smyčku událostí serveru. Proto každý běh
 * dostane vlastní vlákno a po `SCRIPT_WALL_MS` ho `terminate()` zabije – `timeout` je selhání skriptu jako každé jiné
 * (opravné kolo, pak AI verze bez skriptu). Skript v rozpočtu doběhne o řád dřív, hodiny výsledek nikdy neurčují.
 * Jen Node; laboratorní stránka v prohlížeči volá `runScript` přímo.
 */

import { Worker } from 'node:worker_threads';

import type { ScriptRecording } from './api';
import type { ScriptRun, ScriptRunError, ScriptRunOptions } from './sandbox';

/**
 * Pojistka hodin na jeden běh včetně startu vlákna a načtení QuickJS. Naměřeno 2. 11.: zabalené vlákno z buildu ~80 ms
 * na krátký skript, nezabalený zdroj ve vitestu ~0,4 s i s nekonečnou smyčkou až do rozpočtu – 3 s je rezerva
 * i pro pomalejší stroj.
 */
export const SCRIPT_WALL_MS = 3_000;

/** Běh zabitý hodinami: záznam ani kroky z mrtvého vlákna nejsou. */
export interface ScriptTimeout {
  readonly ok: false;
  readonly error: ScriptRunError;
  readonly recording: ScriptRecording;
  readonly polls: null;
}
export type IsolatedRun = ScriptRun | ScriptTimeout;

declare const __webpack_require__: unknown;

/**
 * Bez bundleru (vitest, skripty pod `node --experimental-strip-types`) je vstup vlákna zdroj v TS: vlákno si nejdřív
 * načte zavaděč cest `@/` a přípon `.ts` (`scripts/ts-paths.mjs`), teprve pak vstup.
 */
const UNBUNDLED_BOOTSTRAP = "const { workerData } = require('node:worker_threads'); import(workerData.loader).then(() => import(workerData.entry));";

function spawn(job: { readonly code: string; readonly options: ScriptRunOptions }): Worker {
  // Webpack (Next build) zná `new Worker(new URL(…, import.meta.url))` z `worker_threads` a vstup zabalí jako vlastní
  // chunk; `name` mu dá stálé jméno `chunks/script-worker.js`, které `next.config.mjs` přidá do souborů funkce.
  if (typeof __webpack_require__ === 'function') return new Worker(new URL('./script-worker.ts', import.meta.url), { name: 'script-worker', workerData: job });
  // Cesty skládané za běhu: literál v `new URL` by webpack vzal jako asset.
  const loader = new URL(['..', '..', '..', 'scripts', 'ts-paths.mjs'].join('/'), import.meta.url).href;
  const entry = new URL(['.', 'script-worker.ts'].join('/'), import.meta.url).href;
  return new Worker(UNBUNDLED_BOOTSTRAP, { eval: true, workerData: { ...job, loader, entry }, execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'] });
}

/**
 * Kolik vláken skriptu běží v procesu naráz; další čekají ve frontě a hodiny jim běží až od startu vlákna. Vlákno drží
 * ~45 MB (revize R4: 16 souběžných zaseknutých skriptů = ~0,8 GB na 3 s). Fronta, ne odmítnutí: odmítnutý běh by
 * spustil opravné kolo, tedy další placené volání písaře.
 */
export const SCRIPT_WORKERS_MAX = 2;
let running = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (running < SCRIPT_WORKERS_MAX) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resume) => waiting.push(resume));
}

/** Uvolněné místo přejde rovnou na prvního čekajícího, takže ho mezitím nepředběhne nový běh. */
function release(): void {
  const next = waiting.shift();
  if (next === undefined) running -= 1;
  else next();
}

/**
 * `runScript` ve vlastním vlákně: výsledek je bajt po bajtu tentýž jako v hlavním vlákně, jen běh delší než `wallMs`
 * skončí `timeout`. Vlákno, které umře bez odpovědi (QuickJS se nenačte), promise zamítne – volající to bere jako
 * jakoukoli chybu cestou.
 */
export async function runScriptIsolated(code: string, options: ScriptRunOptions, wallMs = SCRIPT_WALL_MS): Promise<IsolatedRun> {
  await acquire();
  try {
    return await runInWorker(code, options, wallMs);
  } finally {
    release();
  }
}

function runInWorker(code: string, options: ScriptRunOptions, wallMs: number): Promise<IsolatedRun> {
  return new Promise((resolve, reject) => {
    const worker = spawn({ code, options });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ ok: false, error: { kind: 'timeout', message: `the script ran over its wall clock of ${wallMs} ms` }, recording: { places: [], paths: [], draws: 0 }, polls: null });
    }, wallMs);
    worker.once('message', (run: ScriptRun) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(run);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', (exitCode) => {
      clearTimeout(timer);
      reject(new Error(`the script worker exited with code ${exitCode} before it answered`));
    });
  });
}
