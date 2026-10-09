/**
 * Zpráva zábavy P45 (T7): zapečetěná sada se bez konečného měření ani neotevře
 * a souhrn bere jen hratelné hry – měřidlo, které omylem čte pečeť nebo počítá
 * neodehranou hru do mediánu, dá čísla, která vypadají správně.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { FunMetrics } from '@/play/arcade/telemetry';

import { type FunRow, funSentences, funSummary } from '../fun';

const metrics = (over: Partial<FunMetrics>): FunMetrics => ({
  eventsPerS: 1,
  longestGapS: 2,
  medianGapS: 1,
  intensityRatio: 2,
  rising: true,
  nearMisses: 1,
  livesLost: 0,
  playerDied: false,
  kills: 0,
  behaviours: ['chaser:chase', 'hazard:static'],
  behaviourCount: 2,
  finale: { present: true, why: 'boss' },
  ...over,
});

const row = (id: string, playable: boolean, m: FunMetrics | null): FunRow => ({ id, genre: 'arena', seed: playable ? 1 : null, playable, metrics: m, issues: [] });

describe('P45 fun report – the sealed set', () => {
  const sealedDir = (opened: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'p45-fun-'));
    writeFileSync(join(dir, 'sealed-100.json'), JSON.stringify({ sentences: [{ id: 'x001', text: 'canary' }] }));
    if (opened) writeFileSync(join(dir, 'sealed-opened.json'), '{}');
    return dir;
  };

  it('does not read the sealed set without P45_OPEN_SEALED_ONCE=1 and a broken seal', () => {
    const reads: string[] = [];
    const read = (path: string): string => {
      reads.push(path);
      return '{"sentences":[]}';
    };
    expect(() => funSentences('sealed', { dir: sealedDir(true), env: {}, read })).toThrow(/P45_OPEN_SEALED_ONCE/);
    expect(() => funSentences('sealed', { dir: sealedDir(false), env: { P45_OPEN_SEALED_ONCE: '1' }, read })).toThrow(/seal is not broken/);
    expect(reads).toEqual([]);
  });

  it('reads the sealed set once the flag is set and the seal is broken', () => {
    expect(funSentences('sealed', { dir: sealedDir(true), env: { P45_OPEN_SEALED_ONCE: '1' } })).toEqual([{ id: 'x001', text: 'canary' }]);
  });

  it('reads the dev panel without any flag', () => {
    expect(funSentences('panel', { env: {} })).toHaveLength(40);
  });
});

describe('P45 fun report – summary', () => {
  it('leaves a game that is not playable or did not compile out of every median and share', () => {
    const played = [row('a', true, metrics({ longestGapS: 2 })), row('b', true, metrics({ longestGapS: 4, rising: false, behaviourCount: 1, finale: { present: false, why: null } }))];
    const unplayable = row('c', false, metrics({ longestGapS: 80, rising: false, behaviourCount: 0, finale: { present: false, why: null } }));
    const s = funSummary([...played, unplayable, row('d', false, null)]);
    expect(s.n).toBe(4);
    expect(s.playable).toBe(2);
    expect(s.deadTimeMedianS).toBe(3);
    expect(s.risingShare).toBe(0.5);
    expect(s.behavioursMedian).toBe(1.5);
    expect(s.finaleShare).toBe(0.5);
  });

  it('meets a target on its bound and misses it just past it', () => {
    const at = funSummary([row('a', true, metrics({ longestGapS: 3 }))]);
    expect(at.targets.map((t) => [t.metric, t.value, t.met])).toEqual([
      ['deadTimeMedianS', 3, true],
      ['risingShare', 1, true],
      ['behavioursMedian', 2, true],
      ['finaleShare', 1, true],
    ]);
    expect(at.met).toBe(true);
    const past = funSummary([row('a', true, metrics({ longestGapS: 3.01, behaviourCount: 1 }))]);
    expect(past.targets.filter((t) => !t.met).map((t) => t.metric)).toEqual(['deadTimeMedianS', 'behavioursMedian']);
    expect(past.met).toBe(false);
  });

  it('meets nothing on a set with no playable game', () => {
    const s = funSummary([row('d', false, null)]);
    expect(s.deadTimeMedianS).toBeNull();
    expect(s.met).toBe(false);
  });
});
