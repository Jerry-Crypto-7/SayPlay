/**
 * Jednořádkový příkaz konečného měření P45 (T10) s podvrženými kroky: sada se
 * načte jednou pro obě strany (druhé `loadSet` na zapečetěné sadě by odmítlo)
 * a strana A (`main`) a B (HEAD) se nikde nezamění. Příkaz rozhodne o sloučení
 * tří plánů bez lidského oka.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { funCommand } from '../../../../scripts/play-fidelity.mjs';

const SENTENCES = [{ id: 's1', text: 'one' }, { id: 's2', text: 'two' }];
const FUN = { n: 2, playable: 2, deadTimeMedianS: 2.5, risingShare: 0.75, behavioursMedian: 2, finaleShare: 0.5, met: true };

/** Kroky, které si zapíšou, s čím je kdo volal; `loadSet` jako pečeť: podruhé odmítne. */
function steps({ bShare = 0.6, fun = FUN }: { bShare?: number; fun?: typeof FUN } = {}) {
  const calls: { loadSet: unknown[][]; run: { sentences: unknown; base: string; run: string; pace: boolean; draftOnly: boolean }[]; pairwise: Record<string, unknown>[]; measure: { set: string; open: boolean }[] } = { loadSet: [], run: [], pairwise: [], measure: [] };
  return {
    calls,
    loadSet: (name: string, opts: unknown) => {
      calls.loadSet.push([name, opts]);
      if (calls.loadSet.length > 1) throw new Error('test set already opened');
      return SENTENCES;
    },
    runSentences: async (sentences: unknown, options: Record<string, unknown>) => {
      calls.run.push({ sentences, base: options.base as string, run: options.run as string, pace: options['pace-clip'] === true, draftOnly: options['draft-only'] === true });
    },
    pairwise: async (options: Record<string, unknown>) => {
      calls.pairwise.push(options);
      return { summary: { n: 2, aWins: 0, bWins: 1, ties: 1, bShare, leftWinShare: 0.5 } };
    },
    measure: async (set: string, open: boolean) => {
      calls.measure.push({ set, open });
      return fun;
    },
  };
}

const options = (over: Record<string, unknown> = {}) => ({ set: 'p45-panel', 'base-a': 'http://127.0.0.1:3218', 'base-b': 'http://127.0.0.1:3217', run: 'x', outDir: mkdtempSync(join(tmpdir(), 'p45-fun-cmd-')), ...over });

describe('P45 fun command', () => {
  it('loads the set once and plays the same sentences against both sides', async () => {
    const s = steps();
    await funCommand(options({ set: 'p45-sealed', 'open-sealed-once': true }), s);
    expect(s.calls.loadSet).toHaveLength(1);
    expect(s.calls.loadSet[0]?.[0]).toBe('p45-sealed');
    expect(s.calls.loadSet[0]?.[1]).toMatchObject({ openTestOnce: true });
    expect(s.calls.run.map((r) => r.sentences)).toEqual([SENTENCES, SENTENCES]);
    expect(s.calls.measure).toEqual([{ set: 'sealed', open: true }]);
  });

  it('never opens the sealed set for the measurement of the panel', async () => {
    const s = steps();
    await funCommand(options(), s);
    expect(s.calls.loadSet[0]?.[1]).toMatchObject({ openTestOnce: false });
    expect(s.calls.measure).toEqual([{ set: 'panel', open: false }]);
  });

  it('plays side A on --base-a into <run>-a and side B on --base-b into <run>-b', async () => {
    const s = steps();
    await funCommand(options(), s);
    expect(s.calls.run.map(({ base, run, pace, draftOnly }) => ({ base, run, pace, draftOnly }))).toEqual([
      { base: 'http://127.0.0.1:3218', run: 'x-a', pace: true, draftOnly: true },
      { base: 'http://127.0.0.1:3217', run: 'x-b', pace: true, draftOnly: true },
    ]);
    expect(s.calls.pairwise[0]).toMatchObject({ a: 'x-a', b: 'x-b', seed: 45045 });
  });

  it('writes result-<run>.json with side A as main and B as HEAD, and the targets', async () => {
    const s = steps({ bShare: 0.6 });
    const opts = options({ seed: '7' });
    await funCommand(opts, s);
    const result = JSON.parse(readFileSync(join(opts.outDir, 'result-x.json'), 'utf8'));
    expect(result.a).toMatchObject({ base: 'http://127.0.0.1:3218', run: 'x-a', commit: '0714a352' });
    expect(result.b).toMatchObject({ base: 'http://127.0.0.1:3217', run: 'x-b' });
    expect(s.calls.pairwise[0]).toMatchObject({ seed: 7, 'a-commit': '0714a352', 'b-commit': result.b.commit });
    expect(result.pairwise.bShare).toBe(0.6);
    expect(result.fun).toEqual(FUN);
    expect(result.targets.pairwiseB).toEqual({ goal: '>= 0.55', value: 0.6, met: true });
    expect(result.met).toBe(true);
  });

  it('misses when b does not reach the pairwise target or the fun targets fail', async () => {
    const low = steps({ bShare: 0.54 });
    const opts = options();
    await funCommand(opts, low);
    const result = JSON.parse(readFileSync(join(opts.outDir, 'result-x.json'), 'utf8'));
    expect(result.targets.pairwiseB.met).toBe(false);
    expect(result.met).toBe(false);
    const cd = options({ 'target-b': '0.65' });
    await funCommand(cd, steps({ bShare: 0.6 }));
    expect(JSON.parse(readFileSync(join(cd.outDir, 'result-x.json'), 'utf8')).targets.pairwiseB).toEqual({ goal: '>= 0.65', value: 0.6, met: false });
    const dull = options();
    await funCommand(dull, steps({ bShare: 0.9, fun: { ...FUN, met: false } }));
    expect(JSON.parse(readFileSync(join(dull.outDir, 'result-x.json'), 'utf8')).met).toBe(false);
  });
});
