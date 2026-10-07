/**
 * Měřidlo P43 (T2): panel je pevný a nepřekrývá se se zapečetěnými sadami,
 * měřidlo nečte `test-200` a zapečetěnou `sealed-100` otevře jen výslovně a
 * jen po zlomené pečeti; „poznané u vět se svědkem“ počítá jen věty se svědkem.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCorpus, normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { type Row, setOf, summary } from '../visible';

const P43 = join(process.cwd(), 'evals', 'play', 'p43');
const PANEL = JSON.parse(readFileSync(join(P43, 'panel.json'), 'utf8'));
const texts = (path: string) => new Set((JSON.parse(readFileSync(path, 'utf8')).sentences as { text: string }[]).map((s) => normalizeSentence(s.text)));

describe('P43 visibility panel', () => {
  it('is 30 valid dev sentences, none from a sealed set', () => {
    expect(checkCorpus(PANEL)).toEqual([]);
    expect(PANEL.sentences).toHaveLength(30);
    const sealed = new Set([...texts(join(P43, '..', 'p30', 'test-200.json')), ...texts(join(P43, 'sealed-100.json'))]);
    expect(PANEL.sentences.filter((s: { text: string }) => sealed.has(normalizeSentence(s.text))).map((s: { id: string }) => s.id)).toEqual([]);
    expect(PANEL.sentences.filter((s: { source: string }) => ['test', 'sealed-p43'].includes(s.source))).toEqual([]);
  });

  it('never names test-200 and reaches sealed-100 only through the opt-in branch', () => {
    for (const file of ['visible.ts', 'visible.measure.ts']) {
      const source = readFileSync(join(P43, file), 'utf8');
      expect(source).not.toMatch(/test-200/);
      expect(source.match(/sealed-100\.json/g)?.length ?? 0).toBeLessThanOrEqual(file === 'visible.ts' ? 1 : 0);
    }
  });

  it('reads the panel by default and refuses the sealed set while the seal holds', () => {
    expect(setOf().map((s) => s.id)).toEqual(PANEL.sentences.map((s: { id: string }) => s.id));
    const dir = mkdtempSync(join(tmpdir(), 'p43-seal-'));
    writeFileSync(join(dir, 'sealed-100.json'), JSON.stringify({ sentences: [{ id: 'x1', text: 'secret', checklist: [] }] }));
    expect(() => setOf({ openSealedOnce: true, dir })).toThrow(/sealed set is closed/);
    writeFileSync(join(dir, 'sealed-opened.json'), '{}');
    expect(setOf({ openSealedOnce: true, dir }).map((s) => s.id)).toEqual(['x1']);
  });

  it('counts the witnessed verb share over witnessed sentences only', () => {
    const row = (id: string, witnessed: boolean, verbRecognized: boolean | null): Row =>
      ({ id, genre: 'arena', witnessed, verbRecognized, heroModel: null, heroRecognized: null, itemModel: 0, itemOf: 0 });
    const s = summary([row('a', true, true), row('b', true, false), row('c', false, true), row('d', true, null)]);
    expect(s.verbRecognized).toEqual({ hit: 2, of: 3, share: 0.667 });
    expect(s.verbRecognizedWitnessed).toEqual({ hit: 1, of: 2, share: 0.5 });
  });
});
