/**
 * Sady P30A (T1): na vývojové se ladí, testovací se otevře jednou – na
 * závěrečné měření. Tiché otevření testovací sady zničí jediné rozhodovací
 * číslo a vypadá to normálně, proto tu drží hash, průnik s ostatními sadami
 * i pečeť `test-opened.json`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCorpus, loadSet, normalizeSentence } from '../play-fidelity.mjs';

const ROOT = process.cwd();
const P30 = join(ROOT, 'evals', 'play', 'p30');
const FIDELITY = join(ROOT, 'evals', 'play', 'fidelity');
const readLf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

type Sentence = { id: string; source: string; text: string; tags?: string[]; checklist: { item: string; slot: string; controls?: string[] }[] };
const sentencesOf = (path: string): Sentence[] => JSON.parse(readLf(path)).sentences;

const CORPUS = sentencesOf(join(FIDELITY, 'corpus.json'));
const JUDGE = sentencesOf(join(FIDELITY, 'judge-10.json'));
const DEV = sentencesOf(join(P30, 'dev.json'));
const TEST_TEXT = readLf(join(P30, 'test-200.json'));
const TEST: Sentence[] = JSON.parse(TEST_TEXT).sentences;
const DEMAND: { text: string }[] = JSON.parse(readLf(join(ROOT, 'evals', 'play', 'demand', 'corpus.json')));

/** Řádky tréninkových dat P30C, pokud existují – věta testovací sady v nich nesmí být ani jako podřetězec. */
function trainingLines(): string[] {
  const dir = join(ROOT, 'evals', 'play', 'train');
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => readLf(join(dir, name)).split('\n'))
    .map(normalizeSentence);
}

const tempSeal = () => mkdtempSync(join(tmpdir(), 'p30-seal-'));

describe('P30 dev set', () => {
  it('holds the 30 corpus sentences, judge-10 unchanged and 20 new ones', () => {
    expect(checkCorpus({ sentences: DEV })).toEqual([]);
    expect(DEV).toHaveLength(60);
    const byId = new Map(DEV.map((sentence) => [sentence.id, sentence]));
    for (const source of [...CORPUS, ...JUDGE]) expect(byId.get(source.id)).toEqual(source);
    const fresh = DEV.filter((sentence) => sentence.source === 'dev');
    expect(fresh).toHaveLength(20);
    const known = new Set([...CORPUS, ...JUDGE, ...DEMAND].map((sentence) => normalizeSentence(sentence.text)));
    for (const sentence of fresh) expect(known.has(normalizeSentence(sentence.text)), sentence.text).toBe(false);
  });
});

describe('P30 sealed test set', () => {
  it('holds 200 valid sentences, unchanged since its freeze', () => {
    expect(checkCorpus({ sentences: TEST })).toEqual([]);
    expect(TEST).toHaveLength(200);
    expect(TEST.every((sentence) => sentence.source === 'test')).toBe(true);
    expect(createHash('sha256').update(TEST_TEXT).digest('hex')).toBe('7222b9b9d9020af2294f84ca0187f3f33c6ad79806f11b0381e4064e72c629a8');
  });

  it('mixes genres the way a juror would', () => {
    const tagged = (tag: string) => TEST.filter((sentence) => sentence.tags?.includes(tag)).length;
    expect(tagged('non-game')).toBeGreaterThanOrEqual(40);
    expect(tagged('unknown-verb')).toBeGreaterThanOrEqual(40);
    expect(tagged('fantasy')).toBeGreaterThanOrEqual(30);
    const controls = new Set(TEST.flatMap((sentence) => sentence.checklist.filter((entry) => entry.slot === 'verb').flatMap((entry) => entry.controls ?? [])));
    expect(controls.size).toBeGreaterThanOrEqual(9);
  });

  it('shares no sentence with the corpus, judge-10, the 200 demand sentences, the dev set or training data', () => {
    const others = new Set([...CORPUS, ...JUDGE, ...DEMAND, ...DEV].map((sentence) => normalizeSentence(sentence.text)));
    const own = TEST.map((sentence) => normalizeSentence(sentence.text));
    expect(new Set(own).size).toBe(200);
    expect(own.filter((text) => others.has(text))).toEqual([]);
    const lines = trainingLines();
    expect(own.filter((text) => lines.some((line) => line.includes(text)))).toEqual([]);
  });

  it('normalizes case and punctuation only', () => {
    expect(normalizeSentence('  Explain quantum-physics, to my Grandma!! ')).toBe('explain quantumphysics to my grandma');
    expect(normalizeSentence('a café  in Praha')).toBe('a café in praha');
  });
});

describe('the seal on the test set', () => {
  it('refuses to open the test set without --open-test-once', () => {
    const sealDir = tempSeal();
    expect(() => loadSet('test', { sealDir })).toThrow(/sealed/);
    expect(existsSync(join(sealDir, 'test-opened.json'))).toBe(false);
  });

  it('opens it once, records the opening, and refuses the second time', () => {
    const sealDir = tempSeal();
    const sentences = loadSet('test', { sealDir, openTestOnce: true, runId: 'final-1' });
    expect(sentences).toHaveLength(200);
    const seal = JSON.parse(readFileSync(join(sealDir, 'test-opened.json'), 'utf8'));
    expect(seal.runId).toBe('final-1');
    expect(seal.sha256).toBe(createHash('sha256').update(TEST_TEXT).digest('hex'));
    expect(typeof seal.openedAt).toBe('string');
    expect(() => loadSet('test', { sealDir, openTestOnce: true, runId: 'final-2' })).toThrow(/already opened.*final-1/);
  });

  it('seals by content, so a path or a subset does not sidestep it', () => {
    const sealDir = tempSeal();
    expect(() => loadSet(join(P30, 'test-200.json'), { sealDir })).toThrow(/sealed/);
    expect(() => loadSet('test', { sealDir, only: 't001' })).toThrow(/sealed/);
  });

  it('leaves the dev set and the fidelity sets open', () => {
    const sealDir = tempSeal();
    expect(loadSet('dev', { sealDir })).toHaveLength(60);
    expect(loadSet('judge-10.json', { sealDir })).toHaveLength(10);
    expect(loadSet(undefined, { sealDir })).toHaveLength(30);
    expect(existsSync(join(sealDir, 'test-opened.json'))).toBe(false);
  });

  it('the CLI refuses the test set before it starts a browser or a run', () => {
    const env = { ...process.env };
    delete env.VITEST;
    const done = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'scripts/play-fidelity.mjs', 'run', '--set', 'test', '--run', 'p30-seal-probe', '--base', 'http://127.0.0.1:9'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    expect(done.status).not.toBe(0);
    expect(done.stderr).toMatch(/sealed|already opened/);
    expect(existsSync(join(FIDELITY, 'runs', 'p30-seal-probe'))).toBe(false);
  });
});
