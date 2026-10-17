/**
 * Panel sloves P47B (T1): ruční štítek `wants` je jediné, proti čemu se
 * slovník a měřidlo ladí. Panel, který opisuje věty z otevřených sad nebo
 * nemá pasti, dá vysoké číslo, které na porotě nedrží – proto test hlídá
 * pokrytí rodin a žánrů, pasti, pečeť holdoutu a překryv se všemi sadami.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ACTIONS = ['shoot', 'strike', 'dash', 'shield', 'grab'] as const;

interface VerbSentence {
  readonly id: string;
  readonly text: string;
  readonly genre: string;
  readonly family: string;
  readonly wants: readonly string[];
}

const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const sentencesOf = (path: string): VerbSentence[] => (JSON.parse(readLf(path)) as { sentences: VerbSentence[] }).sentences;
const normalise = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const dev = sentencesOf('evals/play/p47b/verb-dev.json');
const holdout = sentencesOf('evals/play/p47b/verb-holdout.json');

describe('P47B verb panel', () => {
  it('labels every sentence with at most two of the five actions, family matching the label', () => {
    for (const s of [...dev, ...holdout]) {
      expect(s.wants.length, s.id).toBeLessThanOrEqual(2);
      expect(new Set(s.wants).size, s.id).toBe(s.wants.length);
      for (const a of s.wants) expect(ACTIONS, s.id).toContain(a);
      if (s.family === 'trap') expect(s.wants, s.id).toEqual([]);
      else expect(s.wants, s.id).toContain(s.family);
      expect(s.genre.length, s.id).toBeGreaterThan(0);
    }
  });

  it('keeps ids unique across both halves and the halves large enough', () => {
    const ids = [...dev, ...holdout].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(dev.length).toBeGreaterThanOrEqual(48);
    expect(holdout.length).toBeGreaterThanOrEqual(24);
  });

  it('covers each action with six dev sentences over four genres', () => {
    for (const a of ACTIONS) {
      const rows = dev.filter((s) => s.wants.includes(a));
      expect(rows.length, a).toBeGreaterThanOrEqual(6);
      expect(new Set(rows.map((s) => s.genre)).size, a).toBeGreaterThanOrEqual(4);
    }
  });

  it('carries traps that want nothing in both halves', () => {
    expect(dev.filter((s) => s.wants.length === 0).length).toBeGreaterThanOrEqual(10);
    expect(holdout.filter((s) => s.wants.length === 0).length).toBeGreaterThanOrEqual(5);
  });

  it('matches the holdout seal over LF bytes', () => {
    const seal = JSON.parse(readLf('evals/play/p47b/holdout-seal.json')) as { sha256: string; count: number };
    expect(sha(readLf('evals/play/p47b/verb-holdout.json'))).toBe(seal.sha256);
    expect(seal.count).toBe(holdout.length);
  });

  it('shares no normalised sentence with the open sets or the sealed P45 set', () => {
    const open = ['evals/play/p45/panel.json', 'evals/play/p46/action-sentences.json', 'evals/play/p30/test-200.json'];
    // Zapečetěná sada jen jako otisky – test její text nikdy nevypíše.
    const taken = new Set([...open, 'evals/play/p45/sealed-100.json'].flatMap((p) => sentencesOf(p).map((s) => sha(normalise(s.text)))));
    const own = [...dev, ...holdout].map((s) => sha(normalise(s.text)));
    expect(new Set(own).size, 'duplicate inside the panel').toBe(own.length);
    expect([...dev, ...holdout].filter((s) => taken.has(sha(normalise(s.text)))).map((s) => s.id)).toEqual([]);
  });
});
