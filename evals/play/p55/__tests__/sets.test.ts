/**
 * Zapečetěná sada P55 (T2): 80 vět nezávislého autora, hlídaná otiskem. Do konečného měření (T9) ji kromě tohoto
 * testu nic nečte a test na výstup dává jen id – změna jediného bajtu = nová sada, ne tichá úprava. Průnik s p54c
 * (dev i otevřený holdout, na kterých se ladí) by z měření udělal měření na tréninkových větách.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { P55_HOLDOUT_SHA256, openSealedOnce, sha256Lf } from '../seal';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p55');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

interface Sentence { readonly id: string; readonly family: string; readonly genre: string | null; readonly text: string }
const holdout = (): Sentence[] => (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: Sentence[] }).sentences;
const textsOf = (path: string): string[] => (JSON.parse(readLf(join(PLAY, path))) as { sentences: { text: string }[] }).sentences.map((s) => s.text);

const countBy = <T>(list: readonly T[], key: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of list) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
};

describe('P55 sealed holdout', () => {
  it('matches its recorded SHA-256, also written in the README', () => {
    expect(sha256Lf(readLf(join(DIR, 'holdout.json')))).toBe(P55_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P55_HOLDOUT_SHA256);
  });

  it('has 60 targets in the planned genre shares and 20 distractors', () => {
    const sentences = holdout();
    expect(sentences).toHaveLength(80);
    expect(countBy(sentences.filter((s) => s.family === 'target'), (s) => String(s.genre))).toEqual({ catch: 8, whack: 8, defense: 8, slice: 8, hop: 7, crowd: 7, merge: 7, push: 7 });
    expect(sentences.filter((s) => s.family === 'distractor' && s.genre === null)).toHaveLength(20);
    expect(new Set(sentences.map((s) => s.id)).size).toBe(80);
  });

  it('shares no sentence with the p54c dev and opened holdout sets, nor within itself', () => {
    const tuned = new Set([...textsOf('p54c/dev.json'), ...textsOf('p54c/holdout.json'), ...textsOf('p30/dev.json')].map(normalizeSentence));
    // Kontrola sama kolizi pozná: věta p54c dev se přepisem velikosti a interpunkce neschová.
    expect(tuned.has(normalizeSentence(textsOf('p54c/dev.json')[0]!.toUpperCase()))).toBe(true);
    const sentences = holdout();
    // Jen id, ne věta: sada se do výstupu testu nedostane.
    expect(sentences.filter((s) => tuned.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(new Set(sentences.map((s) => normalizeSentence(s.text))).size).toBe(sentences.length);
  });
});

describe('openSealedOnce', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a sealed set once and refuses the second opening', () => {
    dir = mkdtempSync(join(tmpdir(), 'p55-seal-'));
    const body = '{"sentences":[]}\n';
    writeFileSync(join(dir, 'holdout.json'), body);
    expect(openSealedOnce(dir, sha256Lf(body), 'abc', 'test')).toBe(body);
    expect(JSON.parse(readFileSync(join(dir, 'holdout-opened.json'), 'utf8'))).toMatchObject({ sha256: sha256Lf(body), commit: 'abc' });
    expect(() => openSealedOnce(dir, sha256Lf(body), 'abc', 'test')).toThrow(/already opened/);
  });

  it('refuses a set whose bytes changed since sealing, before recording an opening', () => {
    dir = mkdtempSync(join(tmpdir(), 'p55-seal-'));
    writeFileSync(join(dir, 'holdout.json'), '{"sentences":[1]}\n');
    expect(() => openSealedOnce(dir, sha256Lf('{"sentences":[]}\n'), 'abc', 'test')).toThrow(/is not the sealed/);
    expect(() => readFileSync(join(dir, 'holdout-opened.json'))).toThrow();
  });
});
