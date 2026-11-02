/**
 * Vstup vlákna skriptu úrovně (P68 R4): jeden běh `runScript` s vlastním modulem QuickJS, výsledek zpět rodiči
 * (`isolated.ts`). Chyba načtení nebo běhu shodí vlákno a rodič dostane `error`.
 */

import { parentPort, workerData } from 'node:worker_threads';

import { type ScriptRunOptions, loadQuickJs, runScript } from './sandbox';

const { code, options } = workerData as { readonly code: string; readonly options: ScriptRunOptions };

void loadQuickJs().then((quickjs) => parentPort?.postMessage(runScript(quickjs, code, options)));
