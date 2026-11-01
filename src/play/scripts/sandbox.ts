/**
 * Sandbox skriptu úrovně (P68 T13, pilot za `PLAY_SCRIPTS`): kód od modelu `build(api)` běží v QuickJS (wasm),
 * jen v době tvorby – na serveru při AI verzi a v laboratorní stránce, nikdy na cestě rychlé hry ani při hraní.
 *
 * - **Jeden kontext na běh** (vlastní runtime), nic nepřežije do dalšího.
 * - **Rozpočet instrukcí** se počítá v obsluze přerušení: QuickJS ji volá jednou za `POLLS_PER_INTERRUPT` kroků
 *   interpretu (skoky smyček, volání), takže součet je počet kroků a místo zastavení je v každém prostředí totéž.
 *   Volání API přičte `HOST_CALL_POLLS`. Přetečení = selhání `budget`, ne časový limit – hodiny tu nerozhodují nikdy.
 * - **Paměť** `SCRIPT_MEMORY_BYTES`, **zásobník** `SCRIPT_STACK_BYTES`.
 * - **Bez hodin a globální náhody:** `Date` (vypnutý intrinsic i smazané jméno) a `Math.random` ve VM nejsou;
 *   náhoda jen z hostitele (`api.rng.int`, `pure-rand` se semínkem hry). Síť, časovače ani DOM QuickJS nemá.
 */

import { DefaultIntrinsics, type QuickJSContext, type QuickJSHandle, type QuickJSWASMModule, newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';

import { type ScriptGame, type ScriptRecording, ScriptApiError, createScriptHost } from './api';

export type QuickJs = QuickJSWASMModule;

/** QuickJS volá obsluhu přerušení jednou za tolik kroků interpretu (`JS_INTERRUPT_COUNTER_INIT`). */
export const POLLS_PER_INTERRUPT = 10_000;
/** Výchozí rozpočet: 2 000 000 kroků interpretu = 200 volání obsluhy (~60 ms nekonečné smyčky). */
export const SCRIPT_BUDGET_POLLS = 2_000_000;
/** Kolik kroků rozpočtu stojí jedno volání API (`api.place`, `api.rng.int`…). */
export const HOST_CALL_POLLS = 100;
/**
 * Paměť VM. simplified: běh je synchronní a skript, který paměť plní drobnými poli, ji u stropu přetřásá úklidem
 * (naměřeno ~12 s, než spadne na `out of memory`) – tak dlouho drží i smyčku událostí serveru. Před zapnutím
 * přepínače v produkci přesunout běh do workeru (`worker_threads`) s vlastním limitem.
 */
export const SCRIPT_MEMORY_BYTES = 16 * 1024 * 1024;
/**
 * Zásobník QuickJS. Rámce wasm leží i na nativním zásobníku hostitele (asi dvakrát víc, než QuickJS počítá):
 * 512 kB v Node přetekl dřív zásobník V8 a modul zůstal rozbitý, 256 kB skončil čistým `stack overflow` – 128 kB
 * nechává rezervu i hlubšímu volání v prohlížeči.
 */
export const SCRIPT_STACK_BYTES = 128 * 1024;
/** Verze běhu, která se ukládá k datům úrovně: knihovna, varianta a verze API skriptu. */
export const SCRIPT_RUNTIME_VERSION = 'quickjs-emscripten-core@0.32.0+wasmfile-release-sync/script-api.v1';

/** Před kódem skriptu: jména, která do VM nepatří (Date je i vypnutý intrinsic). */
const HARDEN = 'delete globalThis.Date; delete Math.random;';
const API_FACTORY = '(place, path, int, param) => Object.freeze({ place, path, rng: Object.freeze({ int }), param })';

let loading: Promise<QuickJs> | undefined;

/**
 * Modul QuickJS, jednou na proces či stránku. Varianta s `.wasm` vedle sebe, ne s wasm vloženým v JS: vložený
 * řetězec minifikátor Next přepíše na neplatný osmičkový escape (build 1. 11. spadl na serveru i v klientu).
 */
export function loadQuickJs(): Promise<QuickJs> {
  loading ??= newQuickJSWASMModuleFromVariant(variant);
  return loading;
}

export type ScriptErrorKind = 'budget' | 'memory' | 'stack' | 'syntax' | 'no-build' | 'thrown';
export interface ScriptRunError {
  readonly kind: ScriptErrorKind;
  readonly message: string;
}
export type ScriptRun =
  | { readonly ok: true; readonly recording: ScriptRecording; readonly polls: number }
  | { readonly ok: false; readonly error: ScriptRunError; readonly recording: ScriptRecording; readonly polls: number };

export interface ScriptRunOptions {
  readonly game: ScriptGame;
  readonly params: Readonly<Record<string, number>>;
  readonly seed: number;
  readonly budgetPolls?: number;
}

const messageOf = (context: QuickJSContext, handle: QuickJSHandle): { readonly name: string; readonly message: string } => {
  try {
    const dumped = context.dump(handle) as unknown;
    if (dumped !== null && typeof dumped === 'object') {
      const { name, message } = dumped as { readonly name?: unknown; readonly message?: unknown };
      return { name: String(name ?? 'Error'), message: String(message ?? '') };
    }
    return { name: 'Error', message: String(dumped) };
  } catch {
    return { name: 'Error', message: 'unreadable error' };
  } finally {
    handle.dispose();
  }
};

/**
 * Spustí `code` (definuje globální `build`) a zavolá `build(api)`. Výsledek nese záznam volání API do místa,
 * kde běh skončil, a počet kroků interpretu (`polls`).
 */
export function runScript(quickjs: QuickJs, code: string, options: ScriptRunOptions): ScriptRun {
  const budget = options.budgetPolls ?? SCRIPT_BUDGET_POLLS;
  const host = createScriptHost(options.game, options.params, options.seed);
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(SCRIPT_MEMORY_BYTES);
  runtime.setMaxStackSize(SCRIPT_STACK_BYTES);
  let polls = 0;
  let overBudget = false;
  runtime.setInterruptHandler(() => {
    polls += POLLS_PER_INTERRUPT;
    overBudget = polls > budget;
    return overBudget;
  });
  const context = runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false } });
  const owned: QuickJSHandle[] = [];
  let poisoned = false;
  const fail = (kind: ScriptErrorKind, message: string): ScriptRun => ({ ok: false, error: { kind, message }, recording: host.recording, polls });
  const failed = (error: QuickJSHandle, during: 'define' | 'build'): ScriptRun => {
    const { name, message } = messageOf(context, error);
    if (overBudget) return fail('budget', `the script ran over its budget of ${budget} interpreter steps`);
    if (/out of memory|string too long/i.test(message)) return fail('memory', `the script ran out of its ${SCRIPT_MEMORY_BYTES} bytes of memory`);
    if (/stack overflow/i.test(message)) return fail('stack', 'the script overflowed its stack');
    if (during === 'define' && name === 'SyntaxError') return fail('syntax', `${name}: ${message}`);
    return fail('thrown', `${name}: ${message}`);
  };
  const hosted = (name: string, impl: (...args: unknown[]) => QuickJSHandle | undefined): QuickJSHandle => {
    const fn = context.newFunction(name, (...handles) => {
      // Volání hostitele stojí kroky rozpočtu: smyčka nad API by jinak za rozpočet běžela vteřiny (~8 µs na volání).
      polls += HOST_CALL_POLLS;
      if (polls > budget) {
        overBudget = true;
        return { error: context.newError('the script ran over its step budget') };
      }
      try {
        return impl(...handles.map((handle) => context.dump(handle) as unknown));
      } catch (thrown) {
        if (thrown instanceof ScriptApiError) return { error: context.newError(thrown.message) };
        throw thrown;
      }
    });
    owned.push(fn);
    return fn;
  };
  try {
    const harden = context.evalCode(HARDEN, 'harden.js');
    if (harden.error) return failed(harden.error, 'define');
    harden.value.dispose();
    const factory = context.evalCode(API_FACTORY, 'api.js');
    if (factory.error) return failed(factory.error, 'define');
    owned.push(factory.value);
    const args = [
      hosted('place', (kind, x, z) => void host.place(kind, x, z)),
      hosted('path', (points) => void host.path(points)),
      hosted('int', (a, b) => context.newNumber(host.rngInt(a, b))),
      hosted('param', (name) => context.newNumber(host.param(name))),
    ];
    const api = context.callFunction(factory.value, context.undefined, ...args);
    if (api.error) return failed(api.error, 'define');
    owned.push(api.value);
    const defined = context.evalCode(code, 'level.js');
    if (defined.error) return failed(defined.error, 'define');
    defined.value.dispose();
    const build = context.getProp(context.global, 'build');
    owned.push(build);
    if (context.typeof(build) !== 'function') return fail('no-build', 'the script must define function build(api)');
    const built = context.callFunction(build, context.undefined, api.value);
    if (built.error) return failed(built.error, 'build');
    built.value.dispose();
    return { ok: true, recording: host.recording, polls };
  } catch (thrown) {
    // Výjimka hostitele uprostřed wasm (přetečený nativní zásobník): modul je rozbitý – zahodit, neuvolňovat.
    poisoned = true;
    loading = undefined;
    return fail('stack', `the engine stopped: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  } finally {
    if (!poisoned) {
      for (const handle of owned) if (handle.alive) handle.dispose();
      context.dispose();
      runtime.dispose();
    }
  }
}
