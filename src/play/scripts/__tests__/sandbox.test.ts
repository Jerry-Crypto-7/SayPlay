/**
 * Sandbox skriptu úrovně (P68 T13): rozpočet počítaný v obsluze přerušení zastaví nekonečnou smyčku vždy na témže
 * místě, `Date` a `Math.random` ve VM nejsou, paměť a zásobník mají strop, náhoda je jen hostitelská ze semínka
 * a každý běh má vlastní kontext.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { POLLS_PER_INTERRUPT, SCRIPT_BUDGET_POLLS, type QuickJs, loadQuickJs, runScript } from '../sandbox';

let quickjs: QuickJs;
beforeAll(async () => {
  quickjs = await loadQuickJs();
});

const HOP = { game: 'hop', params: { rows: 30 }, seed: 7 } as const;
const run = (code: string, seed = 7) => runScript(quickjs, code, { ...HOP, seed });

/** Nekonečná smyčka, která losuje: místo zastavení je počet losů, který hostitel zapsal. */
const SPIN = 'function build(api) { let n = 0; for (;;) { n += api.rng.int(0, 9); } }';
/** Tentýž los a krok, kterým `SPIN` skončí: zapsané z Node. */
const SPIN_DRAWS = 19_600;
const SPIN_POLLS = 2_000_100;

describe('instruction budget', () => {
  it('stops an endless loop at the same draw every time, counted in interrupts, not by the clock', () => {
    const runs = [run(SPIN), run(SPIN), run(SPIN)];
    for (const result of runs) {
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.error.kind).toBe('budget');
      expect([result.recording.draws, result.polls]).toEqual([SPIN_DRAWS, SPIN_POLLS]);
      expect(result.polls).toBeGreaterThan(SCRIPT_BUDGET_POLLS);
      expect(result.polls).toBeLessThanOrEqual(SCRIPT_BUDGET_POLLS + POLLS_PER_INTERRUPT);
    }
  });

  it('stops a loop without host calls too, and a short program never meets the budget', () => {
    const endless = run('function build(api) { for (;;) {} }');
    expect(endless.ok ? null : endless.error.kind).toBe('budget');
    // Bez volání API končí přesně na prvním přerušení za rozpočtem.
    expect(endless.polls).toBe(SCRIPT_BUDGET_POLLS + POLLS_PER_INTERRUPT);
    const short = run('function build(api) { for (let z = 3; z < 20; z += 2) api.place("road", 4, z); }');
    expect(short.ok).toBe(true);
    expect(short.polls).toBeLessThan(SCRIPT_BUDGET_POLLS);
  });
});

describe('no clock and no global randomness inside the VM', () => {
  it('Date is gone even when the name is assembled at run time', () => {
    const result = run('function build(api) { const D = globalThis["Da" + "te"]; api.place("road", new D().getSeconds() % 9, 3); }');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('thrown');
    expect(result.recording.places).toHaveLength(0);
  });

  it('Math.random is gone even when the name is assembled at run time', () => {
    const result = run('function build(api) { const r = Math["ran" + "dom"]; api.place("road", Math.floor(r() * 9), 3); }');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error.kind).toBe('thrown');
    expect(result.recording.places).toHaveLength(0);
  });

  it('randomness comes only from the host stream seeded by the game', () => {
    const roll = 'function build(api) { for (let z = 3; z < 23; z += 2) api.place("road", api.rng.int(0, 8), z); }';
    const a = run(roll, 7);
    const b = run(roll, 7);
    const c = run(roll, 8);
    expect(a.recording.places).toEqual(b.recording.places);
    expect(a.recording.places).not.toEqual(c.recording.places);
    expect(a.recording.draws).toBe(10);
  });

  it('has no network, timers, DOM or host modules', () => {
    const result = run('function build(api) { const names = ["fetch", "XMLHttpRequest", "WebSocket", "document", "window", "require", "process", "setTimeout", "setInterval", "performance", "crypto"]; for (const name of names) if (typeof globalThis[name] !== "undefined") api.place("road", 4, 3 + names.indexOf(name)); }');
    expect(result.ok).toBe(true);
    expect(result.recording.places).toEqual([]);
  });
});

describe('memory, stack and isolation', () => {
  it('an array grown forever runs out of its memory, not into the host', () => {
    const result = run('function build(api) { const a = []; for (;;) a.push(new Array(1000).fill(1)); }');
    expect(result.ok ? '' : result.error.kind).toBe('memory');
    // Modul přežil: další běh jede normálně.
    expect(run('function build(api) { api.place("road", 4, 3); }').ok).toBe(true);
  });

  it('endless recursion overflows the stack', () => {
    const result = run('function build(api) { const f = (n) => f(n + 1) + 1; f(0); }');
    expect(result.ok ? '' : result.error.kind).toBe('stack');
    expect(run('function build(api) { api.place("road", 4, 3); }').ok).toBe(true);
  });

  it('each run has its own context: a global from one run is gone in the next', () => {
    expect(run('globalThis.leak = 1; function build(api) {}').ok).toBe(true);
    const second = run('function build(api) { if (typeof leak !== "undefined") api.place("road", 4, 3); }');
    expect(second.recording.places).toEqual([]);
  });

  it('reports a missing build function, a syntax error and a bad API call', () => {
    expect((r => (r.ok ? '' : r.error.kind))(run('const x = 1;'))).toBe('no-build');
    expect((r => (r.ok ? '' : r.error.kind))(run('function build(api) {'))).toBe('syntax');
    const bad = run('function build(api) { api.place("road", 4.5, 3); }');
    expect(bad.ok ? '' : bad.error.message).toMatch(/integer/);
  });
});
