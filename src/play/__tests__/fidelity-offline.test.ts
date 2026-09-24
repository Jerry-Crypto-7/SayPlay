/**
 * Offline mapa ztrát (P27A T2): dva běhy nad stejným kódem dají stejná data,
 * korpus má 30 vět a příčiny jsou seřazené od nejčetnější. Mapa, která se
 * mezi běhy hne, by rozdíl po opravě neukázala.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { offlineChain } from '../../../scripts/play-fidelity.mjs';

const DIR = join(process.cwd(), 'evals', 'play', 'fidelity');
const CORPUS = JSON.parse(readFileSync(join(DIR, 'corpus.json'), 'utf8'));

describe('offline fidelity loss map', () => {
  const first = offlineChain(CORPUS.sentences);

  it('is the same on a second run', () => {
    expect(JSON.stringify(offlineChain(CORPUS.sentences))).toBe(JSON.stringify(first));
  });

  it('covers all 30 sentences with every stage', () => {
    expect(first.summary.sentences).toBe(30);
    expect(first.sentences).toHaveLength(30);
    for (const sentence of first.sentences) {
      for (const item of sentence.items) expect(Object.keys(item).sort()).toEqual(['drawn', 'inSpec', 'item', 'read', 'slot', 'why']);
    }
    // Stupně jdou po sobě: nakreslené je čtené, čtené je ve specu.
    expect(first.summary.drawn).toBeLessThanOrEqual(first.summary.read);
    expect(first.summary.read).toBeLessThanOrEqual(first.summary.inSpec);
  });

  it('lists at most five causes, most sentences first', () => {
    expect(first.causes.length).toBeGreaterThan(0);
    expect(first.causes.length).toBeLessThanOrEqual(5);
    const counts = first.causes.map((cause) => cause.sentences);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    for (const cause of first.causes) {
      expect(cause.why).not.toBe('ok');
      expect(cause.ids).toHaveLength(cause.sentences);
    }
  });

  it('the committed map keeps the timestamp in the header only', () => {
    const committed = JSON.parse(readFileSync(join(DIR, 'draft-chain.json'), 'utf8'));
    expect(typeof committed.header.measuredAt).toBe('string');
    const { header: _header, ...body } = committed;
    expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(body.summary.sentences).toBe(30);
  });
});
