/**
 * Skript úrovně ve vlastním vlákně (P68 R4): práce uvnitř jedné vestavěné funkce, kterou rozpočet kroků nezastaví,
 * skončí na pojistce hodin, a hlavní vlákno mezitím odpovídá. Výsledek vlákna je tentýž jako v hlavním vlákně
 * (determinismus i místa zastavení rozpočtem), vlákno, které umře bez odpovědi, promise zamítne.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { SCRIPT_WORKERS_MAX, runScriptIsolated } from '../isolated';
import { LAB_PROGRAMS, LAB_SEEDS } from '../lab';
import { type QuickJs, loadQuickJs, runScript } from '../sandbox';

/** Nález revize T13: v hlavním vlákně > 10 min při 10 000 krocích, smyčka událostí celou dobu stojí. */
const STUCK_IN_BUILTIN = 'function build(api) { const s = "a".repeat(4e6); let n = 0; for (;;) n += s.indexOf("b") + 1; }';

let quickjs: QuickJs;
beforeAll(async () => {
  quickjs = await loadQuickJs();
});

describe('wall clock', () => {
  it('kills a script stuck inside one built-in call, and the main thread answers meanwhile', async () => {
    const wallMs = 1_000;
    let ticks = 0;
    const ticker = setInterval(() => {
      ticks += 1;
    }, 20);
    const started = performance.now();
    const run = await runScriptIsolated(STUCK_IN_BUILTIN, { game: 'hop', params: { rows: 30 }, seed: 7 }, wallMs);
    const elapsed = performance.now() - started;
    clearInterval(ticker);
    expect(run.ok ? '' : run.error.kind).toBe('timeout');
    expect(run.polls).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(wallMs - 5);
    expect(elapsed).toBeLessThan(wallMs + 1_500);
    // 20 ms tiky po celou dobu běhu: smyčka událostí hlavního vlákna nestála.
    expect(ticks).toBeGreaterThanOrEqual(Math.floor(wallMs / 20 / 2));
  });
});

describe('workers at once', () => {
  it(`at most ${SCRIPT_WORKERS_MAX} run together, the rest wait, and the clock of each starts with its own worker`, async () => {
    const wallMs = 800;
    const started = performance.now();
    const runs = await Promise.all(Array.from({ length: 2 * SCRIPT_WORKERS_MAX }, () => runScriptIsolated(STUCK_IN_BUILTIN, { game: 'hop', params: { rows: 30 }, seed: 7 }, wallMs)));
    const elapsed = performance.now() - started;
    expect(runs.map((run) => (run.ok ? '' : run.error.kind))).toEqual(Array.from({ length: 2 * SCRIPT_WORKERS_MAX }, () => 'timeout'));
    // Dvě vlny po `wallMs`: všechny naráz by skončily za jedno `wallMs`.
    expect(elapsed).toBeGreaterThanOrEqual(2 * wallMs - 20);
    expect(elapsed).toBeLessThan(2 * wallMs + 2_000);
  });
});

describe('same result as the main thread', () => {
  it('every lab program on every seed, budget stops included, within the default wall clock', async () => {
    for (const program of LAB_PROGRAMS) {
      for (const seed of LAB_SEEDS) {
        const options = { game: 'hop', params: { rows: program.rows }, seed } as const;
        expect(await runScriptIsolated(program.code, options), `${program.id} seed ${seed}`).toEqual(runScript(quickjs, program.code, options));
      }
    }
  });

  it('a custom step budget reaches the worker', async () => {
    const options = { game: 'hop', params: { rows: 30 }, seed: 1, budgetPolls: 50_000 } as const;
    const isolated = await runScriptIsolated('function build(api) { for (;;) {} }', options);
    expect(isolated.polls).toBe(60_000);
    expect(isolated).toEqual(runScript(quickjs, 'function build(api) { for (;;) {} }', options));
  });
});

describe('the bundled worker on the platform', () => {
  // Bez buildu to vitest nevidí: jméno chunku z `isolated.ts` musí sedět se sledováním souborů funkce a server ho
  // musí hledat vedle chunků. Rozchod = na platformě každý skript spadne a AI verze jede vždy bez něj.
  it('the worker chunk name, the traced file and the server worker path agree', async () => {
    const { default: config } = (await import(/* @vite-ignore */ new URL('../../../../next.config.mjs', import.meta.url).href)) as { default: { outputFileTracingIncludes: Record<string, string[]>; webpack: (c: { output: Record<string, unknown> }, o: { isServer: boolean; nextRuntime?: string }) => unknown } };
    expect(readFileSync('src/play/scripts/isolated.ts', 'utf8')).toMatch(/new Worker\(new URL\('\.\/script-worker\.ts', import\.meta\.url\), \{ name: 'script-worker',/);
    expect(config.outputFileTracingIncludes['/api/play/**']).toContain('./.next/server/chunks/script-worker.js');
    const server = { output: {} as Record<string, unknown> };
    config.webpack(server, { isServer: true, nextRuntime: 'nodejs' });
    expect(server.output.workerPublicPath).toBe('./');
    const client = { output: {} as Record<string, unknown> };
    config.webpack(client, { isServer: false });
    expect(client.output.workerPublicPath).toBeUndefined();
  });
});

describe('a worker that dies before it answers', () => {
  it('rejects instead of answering', async () => {
    await expect(runScriptIsolated('function build(api) {}', { game: 'nope' as 'hop', params: {}, seed: 1 })).rejects.toThrow();
  });
});
