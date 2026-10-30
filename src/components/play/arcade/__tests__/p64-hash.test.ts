/**
 * Otisk jádra P64 (T1): robot a nečinný hráč na buňkách rámování (`e2e/p64-cells.ts`, 19 žánrů a tři ovládání)
 * v jádře, bez prohlížeče. Hra se sestaví cestou dveří `/api/play/games` – čtení specu, semínka odvozená z něj,
 * `compileGame` – a `verifyArcade` dá výsledek, tik a hash stavu po konci běhu robota i nečinného hráče. P64 mění jen
 * kameru, HUD a ovládání; jakákoli změna otisku znamená, že se dotkla hry. `P64_HASH=write` zapíše
 * `evals/play/p64/hash-baseline.json`, jinak test porovná přesně.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileGame } from '@/play/compile';
import { verifyArcade } from '@/play/arcade/verify';
import { loadRapier } from '@/play/arcade/physics/world';
import { readGameSpec } from '@/play/spec';

import { P64_CELLS } from '../../../../../e2e/p64-cells';

const OUT = join(process.cwd(), 'evals/play/p64/hash-baseline.json');

interface Print {
  readonly cell: string;
  readonly seed: number;
  readonly bot: { readonly outcome: string; readonly tick: number; readonly hash: string };
  readonly idle: { readonly outcome: string; readonly tick: number; readonly hash: string };
  readonly replayEqual: boolean;
}

function printOf(spec: unknown, cell: string): Print {
  const read = readGameSpec(spec);
  if (!read.ok) throw new Error(read.issues.join('; '));
  const issues: string[] = [];
  // Jako dveře publikace: první semínko, se kterým se hra sestaví.
  for (const seed of derivedSeeds(seedFrom(read.value))) {
    const compiled = compileGame(read.value, seed);
    if (!compiled.ok) {
      issues.push(compiled.issues.join('; '));
      continue;
    }
    const world = compiled.value.arcade;
    if (world === undefined) throw new Error(`${cell}: not an arcade world`);
    const verdict = verifyArcade(world);
    const { outcome, tick, hash } = verdict.bot;
    return { cell, seed, bot: { outcome, tick, hash }, idle: { ...verdict.idle }, replayEqual: verdict.replayEqual };
  }
  throw new Error(`${cell}: no seed compiles – ${issues.join(' | ')}`);
}

beforeAll(async () => {
  await loadRapier();
});

describe('P64 core fingerprint of the framing cells', () => {
  it('robot and idle player end exactly as in hash-baseline.json', () => {
    const prints = Object.fromEntries(P64_CELLS.map((cell) => [cell.key, printOf(cell.spec, cell.id)]));
    if (process.env.P64_HASH === 'write') {
      writeFileSync(OUT, `${JSON.stringify({ about: { plan: 'P64 T1', measure: 'src/components/play/arcade/__tests__/p64-hash.test.ts', what: 'verifyArcade on the publish path: robot and idle player, outcome, tick and state hash at the end of the run' }, prints }, null, 1)}\n`);
    }
    expect(existsSync(OUT), 'hash-baseline.json is written with P64_HASH=write').toBe(true);
    const baseline = (JSON.parse(readFileSync(OUT, 'utf8')) as { prints: Record<string, Print> }).prints;
    expect(Object.keys(prints)).toHaveLength(22);
    expect(prints).toEqual(baseline);
    // Brána publikace drží: robot vyhraje, nečinný ne, dvě přehrání shodná.
    for (const print of Object.values(prints)) {
      expect(print.bot.outcome, print.cell).toBe('won');
      expect(print.idle.outcome, print.cell).not.toBe('won');
      expect(print.replayEqual, print.cell).toBe(true);
    }
  }, 300_000);
});
