/**
 * Zapečetěná sada P45 (T2): 100 vět psaných nezávislým autorem jako porotce,
 * který chce hru, u které se pobaví. Test drží tvar, skupiny, otisk v README,
 * nulový průnik se všemi dřívějšími sadami a pečeť – sada se otevře jen jednou
 * a jen výslovně. Věty nevypisuje: průnik porovnává přes otisky, při chybě
 * hlásí jen id.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCorpus, loadSet, normalizeSentence } from '../../../../scripts/play-fidelity.mjs';

const PLAY = join(process.cwd(), 'evals', 'play');
const SEALED = join(PLAY, 'p45', 'sealed-100.json');
const readLf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const json = (path: string) => JSON.parse(readLf(join(PLAY, path)));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const TEXT = readLf(SEALED);

interface Sentence { id: string; source: string; group: string; text: string }
const SET: { sentences: Sentence[] } = JSON.parse(TEXT);

const GROUPS = { threat: 40, everyday: 25, fantasy: 20, 'non-game': 15 } as const;

/** Odchylky od rozložení skupin; prázdné = sedí. */
function groupIssues(sentences: readonly Sentence[]): string[] {
  const issues = Object.entries(GROUPS).flatMap(([group, want]) => {
    const got = sentences.filter((s) => s.group === group).length;
    return got === want ? [] : [`${group}: ${got}, needs ${want}`];
  });
  const unknown = sentences.filter((s) => !(s.group in GROUPS)).map((s) => s.id);
  return unknown.length === 0 ? issues : [...issues, `unknown group: ${unknown.join(',')}`];
}

/** Otisky normalizovaných vět všech dřívějších sad – věty samotné test nikde nedrží. */
function earlierPrints(): Set<string> {
  const texts = (path: string) => (json(path).sentences as { text: string }[]).map((s) => s.text);
  const grouped = (path: string) => Object.values(json(path).groups as Record<string, { sentence: string }[]>).flat().map((s) => s.sentence);
  const demand = (json('demand/corpus.json') as { text: string }[]).map((s) => s.text);
  return new Set([
    ...texts('p30/test-200.json'), ...texts('p30/dev.json'), ...texts('p37a/dev-150.json'), ...texts('fidelity/corpus.json'),
    ...texts('fidelity/judge-10.json'), ...demand, ...grouped('p41/sentences.json'), ...texts('p43/panel.json'), ...texts('p43/sealed-100.json'),
    ...grouped('p44c/sealed-110.json'), ...texts('p44e/sealed-200.json'), ...texts('p45/panel.json'),
  ].map((text) => sha(normalizeSentence(text))));
}

/** Id vět, jejichž otisk už v dřívější sadě je. */
const overlapping = (sentences: readonly { id: string; text: string }[], known: Set<string>) =>
  sentences.filter((s) => known.has(sha(normalizeSentence(s.text)))).map((s) => s.id);

describe('P45 sealed fun set', () => {
  it('has 100 valid sentences from the sealed-p45 source', () => {
    // Jen počet nálezů: nález nese název položky seznamu, a ten se z testu ven nedostane.
    expect(checkCorpus(SET).length).toBe(0);
    expect(SET.sentences).toHaveLength(100);
    expect(new Set(SET.sentences.map((s) => s.id)).size).toBe(100);
    expect(new Set(SET.sentences.map((s) => sha(normalizeSentence(s.text)))).size).toBe(100);
    expect(SET.sentences.filter((s) => s.source !== 'sealed-p45').map((s) => s.id)).toEqual([]);
  });

  it('keeps the four groups at 40 / 25 / 20 / 15', () => {
    expect(groupIssues(SET.sentences)).toEqual([]);
    // Kontrola musí poznat i jednu chybějící větu skupiny.
    const short = SET.sentences.map((s, index) => (index === SET.sentences.findIndex((t) => t.group === 'threat') ? { ...s, group: 'everyday' } : s));
    expect(groupIssues(short)).toEqual(['threat: 39, needs 40', 'everyday: 26, needs 25']);
  });

  it('pins its SHA-256 over LF bytes in the README', () => {
    expect(readLf(join(PLAY, 'p45', 'README.md'))).toContain(sha(TEXT));
  });

  it('shares no sentence with any earlier set, the P45 panel included', () => {
    const known = earlierPrints();
    expect(overlapping(SET.sentences, known)).toEqual([]);
    // Kontrola sama musí kolizi poznat: věta panelu se přepisem velikosti a interpunkce neschová.
    const leaked = json('p45/panel.json').sentences[0].text as string;
    expect(overlapping([{ id: 'leak', text: `${leaked.toUpperCase()}!` }], known)).toEqual(['leak']);
  });
});

describe('the seal on the P45 set', () => {
  const tempDir = () => mkdtempSync(join(tmpdir(), 'p45-seal-'));

  it('refuses to open without the explicit flag and leaves no seal', () => {
    const sealDir = tempDir();
    expect(() => loadSet('p45-sealed', { sealDir })).toThrow(/sealed/);
    expect(existsSync(join(sealDir, 'sealed-opened.json'))).toBe(false);
  });

  it('opens once, records the opening, and refuses the second time', () => {
    const sealDir = tempDir();
    expect(loadSet('p45-sealed', { sealDir, openTestOnce: true, runId: 'p45-final-1' })).toHaveLength(100);
    const seal = JSON.parse(readFileSync(join(sealDir, 'sealed-opened.json'), 'utf8'));
    expect(seal.runId).toBe('p45-final-1');
    expect(seal.sha256).toBe(sha(TEXT));
    expect(() => loadSet('p45-sealed', { sealDir, openTestOnce: true, runId: 'p45-final-2' })).toThrow(/already opened.*p45-final-1/);
  });

  it('seals the LF bytes even when the checkout has CRLF line endings', () => {
    const sealDir = tempDir();
    const crlf = join(tempDir(), 'sealed-100.json');
    writeFileSync(crlf, TEXT.replace(/\n/g, '\r\n'));
    loadSet(crlf, { sealDir, openTestOnce: true, runId: 'p45-crlf' });
    expect(JSON.parse(readFileSync(join(sealDir, 'sealed-opened.json'), 'utf8')).sha256).toBe(sha(TEXT));
  });

  it('seals by content, so a path or a subset does not sidestep it', () => {
    const sealDir = tempDir();
    expect(() => loadSet(SEALED, { sealDir })).toThrow(/sealed/);
    expect(() => loadSet('p45-sealed', { sealDir, only: 'x001' })).toThrow(/sealed/);
  });

  // Otevřela ji jednou finální měření P46 (`abe38f04`); záznam musí sedět na obsah sady, ne na jiný soubor.
  it('was opened once, by the P46 final run, over these exact bytes', () => {
    const opened = json('p45/sealed-opened.json');
    expect(opened.runId).toBe('p46-final');
    expect(opened.sha256).toBe(sha(TEXT));
  });
});
