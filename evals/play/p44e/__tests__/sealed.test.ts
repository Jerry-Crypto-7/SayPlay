import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkCorpus, loadSet, normalizeSentence } from '../../../../scripts/play-fidelity.mjs';

const PLAY = join(process.cwd(), 'evals/play');
const DIR = join(PLAY, 'p44e');
const lf = (text: string) => text.replace(/\r\n/g, '\n');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (path: string) => lf(readFileSync(path, 'utf8'));
type Row = { id: string; text: string; source: string; tags: string[]; checklist: {slot: string}[] };
const corpus = () => JSON.parse(read(join(DIR, 'sealed-200.json'))) as {sentences: Row[]};
const temps: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'p44e-seal-')); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true}); });

function sentenceHashes(value: unknown, result = new Set<string>()) {
  if (Array.isArray(value)) value.forEach((entry) => sentenceHashes(entry, result));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if ((key === 'text' || key === 'sentence') && typeof entry === 'string') result.add(hash(normalizeSentence(entry)));
      else if (typeof entry === 'object') sentenceHashes(entry, result);
    }
  }
  return result;
}
function earlier() {
  const known = new Set<string>();
  const add = (text: string) => sentenceHashes(JSON.parse(text), known);
  for (const file of ['p30/test-200.json', 'p30/dev.json', 'p37a/dev-150.json', 'fidelity/corpus.json', 'fidelity/judge-10.json', 'demand/corpus.json', 'p41/sentences.json']) add(read(join(PLAY, file)));
  const walk = (dir: string) => { for (const entry of readdirSync(dir, {withFileTypes: true})) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name.endsWith('.json')) add(read(path)); } };
  walk(join(PLAY, 'p42'));
  for (const file of ['panel.json', 'sealed-100.json']) {
    const path = join(PLAY, 'p43', file);
    add(existsSync(path) ? read(path) : execFileSync('git', ['show', `features/p43-co-porotce-vidi:evals/play/p43/${file}`], {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}));
  }
  return known;
}
function distribution(rows: Row[]) {
  return { total: rows.length, heroes: rows.filter((row) => row.checklist.some((entry) => entry.slot === 'hero')).length,
    items: rows.reduce((sum, row) => sum + row.checklist.filter((entry) => ['role', 'any'].includes(entry.slot)).length, 0),
    tags: ['non-game', 'unknown-verb', 'fantasy'].map((tag) => rows.filter((row) => row.tags.includes(tag)).length) };
}
const expected = {total: 200, heroes: 118, items: 251, tags: [48, 126, 41]};

describe('P44E independent sealed set', () => {
  it('has the exact distribution and valid unique checklists', () => {
    const set = corpus();
    expect(checkCorpus(set).length).toBe(0);
    expect(distribution(set.sentences)).toEqual(expected);
    expect(set.sentences.every((row) => row.source === 'sealed-p44e')).toBe(true);
    expect(sentenceHashes(set).size).toBe(200);
    const changed = structuredClone(set.sentences);
    const hero = changed.find((row) => row.checklist.some((entry) => entry.slot === 'hero'))!;
    hero.checklist = hero.checklist.filter((entry) => entry.slot !== 'hero');
    expect(distribution(changed)).not.toEqual(expected);
  });
  it('pins LF bytes and detects a CRLF seal', () => {
    const text = read(join(DIR, 'sealed-200.json'));
    expect(read(join(DIR, 'README.md'))).toContain(hash(text));
    expect(hash(text.replace(/\n/g, '\r\n'))).not.toBe(hash(text));
  });
  it('has no overlap, while detecting an injected development sentence', () => {
    const known = earlier();
    expect([...sentenceHashes(corpus())].filter((digest) => known.has(digest)).length).toBe(0);
    const leaked = JSON.parse(read(join(PLAY, 'p37a/dev-150.json'))).sentences[0].text;
    expect(known.has(hash(normalizeSentence(`${leaked.toUpperCase()}!`)))).toBe(true);
  });
  it('refuses implicit and subset openings', () => {
    const sealDir = temp();
    expect(() => loadSet('p44e-sealed', {sealDir})).toThrow(/set is sealed/);
    expect(() => loadSet(join(DIR, 'sealed-200.json'), {sealDir, only: 'e001'})).toThrow(/set is sealed/);
    expect(existsSync(join(sealDir, 'sealed-opened.json'))).toBe(false);
  });
  it('records one explicit opening and refuses a second', () => {
    const sealDir = temp();
    expect(loadSet('p44e-sealed', {sealDir, openTestOnce: true, runId: 'p44e-test'}).length).toBe(200);
    const seal = JSON.parse(read(join(sealDir, 'sealed-opened.json')));
    expect(seal.runId).toBe('p44e-test');
    expect(seal.sha256).toBe(hash(read(join(DIR, 'sealed-200.json'))));
    expect(() => loadSet('p44e-sealed', {sealDir, openTestOnce: true})).toThrow(/already opened/);
  });
  it('keeps the real evaluation sealed', () => {
    expect(existsSync(join(DIR, 'sealed-opened.json'))).toBe(false);
  });
});
