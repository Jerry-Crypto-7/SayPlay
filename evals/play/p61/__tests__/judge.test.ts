/**
 * P61 T1: slepé měřidlo kvality hry. Soudce, který vidí jméno produktu, větve nebo cestu, vrátí přesvědčivé a špatné
 * číslo – list proto nese jen písmena řádků, otázka jen větu a `sheet.png` leží v adresáři jen se schématem.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { blindQuestion } from '../../../../scripts/p37d/judge-sheet.mjs';
import { ANSWER_SCHEMA, isAnswerFor, planSheets, questionFor, sheetLabels, summarize } from '../judge.mjs';

/** Co nesmí soudce nikdy vidět: jméno produktu, větve, druh strany ani cestu. */
const LEAKS = /sayplay|worldsmith|p61|main|branch|quick|reading|upgrade|chain|[a-z]:[\\/]|\/caches|\.png|evals/i;

const sentences = [
  { id: 'a', text: 'zombie shooter in a mall', sides: [{ kind: 'main-quick', dir: 'D:/caches/p61/main-dev/a/desktop/quick' }, { kind: 'main-reading', dir: 'D:/caches/p61/main-dev/a/desktop/reading' }] },
  { id: 'b', text: 'A knight collects three keys while dodging ghosts', sides: [{ kind: 'main-quick', dir: 'D:/caches/p61/main-dev/b/desktop/quick' }] },
  { id: 'c', text: 'A corgi runs through the park', sides: ['main-quick', 'main-reading', 'p61-quick', 'p61-reading'].map((kind) => ({ kind, dir: `D:/caches/p61/x/${kind}` })) },
];

describe('P61 sheet blindness', () => {
  it('asks with the sentence and row letters only – no product, branch, side kind or path', () => {
    for (const item of planSheets(sentences, 7).plan) {
      const question = questionFor(item.sentence, item.rows.map((row) => row.side));
      expect(question).toContain(item.sentence);
      // `sheet.png` je neutrální jméno, pod kterým soudce list jediný vidí.
      expect(question.replace(item.sentence, '').replace('sheet.png', '')).not.toMatch(LEAKS);
    }
  });

  it('draws nothing on the sheet but one capital letter per row', () => {
    for (const item of planSheets(sentences, 7).plan) {
      const labels = sheetLabels(item.rows);
      expect(labels).toHaveLength(item.rows.length);
      for (const label of labels) expect(label).toMatch(/^[A-Z]$/);
    }
  });

  it('puts sheet.png in a fresh directory that holds nothing but the sheet and the schema', () => {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'p61-test-'));
    const sheet = path.join(scratch, 's039-main-quick-sheet.png');
    const schema = path.join(scratch, 'schema.json');
    writeFileSync(sheet, 'png');
    writeFileSync(schema, JSON.stringify(ANSWER_SCHEMA));
    try {
      for (const judge of ['codex', 'claude'] as const) {
        const { cwd, args } = blindQuestion(sheet, schema, questionFor('zombie shooter in a mall', ['A', 'B']), judge);
        expect(readdirSync(cwd).sort()).toEqual(judge === 'codex' ? ['schema.json', 'sheet.png'] : ['sheet.png']);
        expect(path.dirname(cwd)).not.toBe(scratch);
        expect(args.join(' ')).not.toContain(scratch);
        expect(args.join(' ')).not.toContain('s039');
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('P61 row order', () => {
  it('gives the same order twice for one seed and records the seed', () => {
    const first = planSheets(sentences, 61026);
    const again = planSheets(sentences, 61026);
    expect(again).toEqual(first);
    expect(first.seed).toBe(61026);
    expect(first.generator).toMatch(/xoroshiro128plus/);
  });

  it('shuffles: some seed puts another side first, and every side keeps exactly one letter', () => {
    const firstKinds = new Set(Array.from({ length: 12 }, (_, seed) => planSheets(sentences, seed).plan[2]!.rows[0]!.kind));
    expect(firstKinds.size).toBeGreaterThan(1);
    for (const item of planSheets(sentences, 3).plan) {
      expect(item.rows.map((row) => row.side)).toEqual('ABCD'.slice(0, item.rows.length).split(''));
      expect(new Set(item.rows.map((row) => row.kind)).size).toBe(item.rows.length);
    }
  });
});

describe('P61 answers and medians', () => {
  it('accepts an answer only when it scores every letter once, inside 0..1', () => {
    expect(isAnswerFor({ rows: [{ side: 'A', fidelity: 0.4, wouldPlay: 0.5, reason: 'x' }, { side: 'B', fidelity: 1, wouldPlay: 0, reason: 'y' }] }, ['A', 'B'])).toBe(true);
    expect(isAnswerFor({ rows: [{ side: 'A', fidelity: 0.4, wouldPlay: 0.5, reason: 'x' }] }, ['A', 'B'])).toBe(false);
    expect(isAnswerFor({ rows: [{ side: 'A', fidelity: 1.4, wouldPlay: 0.5, reason: 'x' }, { side: 'B', fidelity: 1, wouldPlay: 0, reason: 'y' }] }, ['A', 'B'])).toBe(false);
    expect(isAnswerFor({ rows: [{ side: 'A', fidelity: 0.4, wouldPlay: 0.5, reason: 'x' }, { side: 'A', fidelity: 1, wouldPlay: 0, reason: 'y' }] }, ['A', 'B'])).toBe(false);
  });

  it('takes medians per side from hand-entered answers; after-reading falls back to the quick game', () => {
    const plan = [
      { id: 's1', sentence: 'one', rows: [{ side: 'A', kind: 'main-reading' }, { side: 'B', kind: 'main-quick' }] },
      { id: 's2', sentence: 'two', rows: [{ side: 'A', kind: 'main-quick' }] },
      { id: 's3', sentence: 'three', rows: [{ side: 'B', kind: 'main-quick' }, { side: 'A', kind: 'main-reading' }] },
    ];
    const answers = {
      s1: { rows: [{ side: 'A', fidelity: 0.8, wouldPlay: 0.7, reason: 'mall and zombies' }, { side: 'B', fidelity: 0.2, wouldPlay: 0.4, reason: 'targets' }] },
      s2: { rows: [{ side: 'A', fidelity: 0.5, wouldPlay: 0.6, reason: 'keys' }] },
      s3: { rows: [{ side: 'B', fidelity: 0.3, wouldPlay: 0.2, reason: 'roads' }, { side: 'A', fidelity: 0.9, wouldPlay: 0.8, reason: 'corgi' }] },
    };
    const summary = summarize(plan, answers, 'main');
    expect(summary.medians['main-quick']).toEqual({ fidelity: 0.3, wouldPlay: 0.4, n: 3 });
    expect(summary.medians['main-reading']).toEqual({ fidelity: 0.85, wouldPlay: 0.75, n: 2 });
    // Po čtení: s1 0.8, s2 bez hry ze čtení = rychlá 0.5, s3 0.9.
    expect(summary.medians['main-after-reading']).toEqual({ fidelity: 0.8, wouldPlay: 0.7, n: 3 });
    expect(summary.sentences.find((row) => row.id === 's1')!.scores['main-quick']).toEqual({ fidelity: 0.2, wouldPlay: 0.4, reason: 'targets' });
  });

  it('leaves an unanswered sheet out of the medians and counts it as skipped', () => {
    const plan = [
      { id: 's1', sentence: 'one', rows: [{ side: 'A', kind: 'main-quick' }] },
      { id: 's2', sentence: 'two', rows: [{ side: 'A', kind: 'main-quick' }] },
    ];
    const summary = summarize(plan, { s1: { rows: [{ side: 'A', fidelity: 0.6, wouldPlay: 0.6, reason: 'ok' }] } }, 'main');
    expect(summary.medians['main-quick']).toEqual({ fidelity: 0.6, wouldPlay: 0.6, n: 1 });
    expect(summary.skipped).toEqual(['s2']);
  });
});
