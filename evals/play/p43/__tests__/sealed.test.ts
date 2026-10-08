/**
 * Zapečetěná sada P43 (T1): 100 vět psaných jako porotce dřív, než se P43
 * čehokoli dotkl. Test drží tvar, skupiny, otisk v README, nulový průnik se
 * všemi dřívějšími sadami a pečeť – sada se otevře jen jednou a jen výslovně.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCorpus, loadSet, normalizeSentence } from '../../../../scripts/play-fidelity.mjs';

const PLAY = join(process.cwd(), 'evals', 'play');
const readLf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const TEXT = readLf(join(PLAY, 'p43', 'sealed-100.json'));
const SET: { sentences: { id: string; source: string; group: string; tags: string[]; text: string }[] } = JSON.parse(TEXT);

/** Dřívější sady, se kterými se P43 nesmí překrývat: jen normalizované věty. */
function earlierSentences(): Set<string> {
  const texts = (path: string) => (JSON.parse(readLf(join(PLAY, path))).sentences as { text: string }[]).map((s) => s.text);
  const p41 = Object.values(JSON.parse(readLf(join(PLAY, 'p41', 'sentences.json'))).groups as Record<string, { sentence: string }[]>)
    .flat().map((s) => s.sentence);
  const demandTexts = (JSON.parse(readLf(join(PLAY, 'demand', 'corpus.json'))) as { text: string }[]).map((s) => s.text);
  return new Set([
    ...texts('p30/test-200.json'), ...texts('p30/dev.json'), ...texts('p37a/dev-150.json'),
    ...texts('fidelity/corpus.json'), ...texts('fidelity/judge-10.json'), ...demandTexts, ...p41,
  ].map(normalizeSentence));
}

/** Id vět, které už v dřívější sadě jsou. */
const overlapping = (sentences: { id: string; text: string }[], known: Set<string>) =>
  sentences.filter((s) => known.has(normalizeSentence(s.text))).map((s) => s.id);

describe('P43 sealed juror set', () => {
  it('has 100 valid sentences in the four groups', () => {
    expect(checkCorpus(SET)).toEqual([]);
    expect(SET.sentences).toHaveLength(100);
    expect(new Set(SET.sentences.map((s) => s.id)).size).toBe(100);
    expect(new Set(SET.sentences.map((s) => normalizeSentence(s.text))).size).toBe(100);
    expect(SET.sentences.every((s) => s.source === 'sealed-p43')).toBe(true);
    const count = (group: string) => SET.sentences.filter((s) => s.group === group).length;
    expect(count('action')).toBeGreaterThanOrEqual(30);
    expect(count('unknown-verb')).toBeGreaterThanOrEqual(25);
    expect(count('fantasy')).toBeGreaterThanOrEqual(20);
    expect(count('non-game')).toBeGreaterThanOrEqual(15);
  });

  it('pins its SHA-256 in the README', () => {
    const sha = createHash('sha256').update(TEXT).digest('hex');
    expect(readLf(join(PLAY, 'p43', 'README.md'))).toContain(sha);
  });

  it('shares no sentence with any earlier set', () => {
    const known = earlierSentences();
    expect(overlapping(SET.sentences, known)).toEqual([]);
    // Kontrola sama musí kolizi poznat: věta z dev-150 se přepisem velikosti a interpunkce neschová.
    const leaked = JSON.parse(readLf(join(PLAY, 'p37a', 'dev-150.json'))).sentences[0].text as string;
    expect(overlapping([{ id: 'leak', text: `${leaked.toUpperCase()}!` }], known)).toEqual(['leak']);
  });
});

describe('the seal on the P43 set', () => {
  const tempSeal = () => mkdtempSync(join(tmpdir(), 'p43-seal-'));

  it('refuses to open without the explicit flag and leaves no seal', () => {
    const sealDir = tempSeal();
    expect(() => loadSet('p43-sealed', { sealDir })).toThrow(/sealed/);
    expect(existsSync(join(sealDir, 'sealed-opened.json'))).toBe(false);
  });

  it('opens once, records the opening, and refuses the second time', () => {
    const sealDir = tempSeal();
    expect(loadSet('p43-sealed', { sealDir, openTestOnce: true, runId: 'p43-final-1' })).toHaveLength(100);
    const seal = JSON.parse(readFileSync(join(sealDir, 'sealed-opened.json'), 'utf8'));
    expect(seal.runId).toBe('p43-final-1');
    expect(seal.sha256).toBe(createHash('sha256').update(TEXT).digest('hex'));
    expect(() => loadSet('p43-sealed', { sealDir, openTestOnce: true, runId: 'p43-final-2' })).toThrow(/already opened.*p43-final-1/);
  });

  it('seals by content, so a path or a subset does not sidestep it', () => {
    const sealDir = tempSeal();
    expect(() => loadSet(join(PLAY, 'p43', 'sealed-100.json'), { sealDir })).toThrow(/sealed/);
    expect(() => loadSet('p43-sealed', { sealDir, only: 'z001' })).toThrow(/sealed/);
  });

  it('is not opened yet in the repository', () => {
    expect(existsSync(join(PLAY, 'p43', 'sealed-opened.json'))).toBe(false);
  });
});
