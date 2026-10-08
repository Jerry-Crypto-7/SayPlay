/**
 * Slepý párový soudce P45 (T9) s podvrženým soudcem: špatně přeložená strana
 * obrátí verdikt každého sloučení P45 a JSON přitom vypadá bezvadně. Test drží
 * los ze seedu, překlad A/B na stranu běhu, list složený na tutéž stranu,
 * remízu za půl, slepý adresář soudce a odpověď, která se nepřeptává.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { blindQuestion } from '../../../../scripts/p37d/judge-sheet.mjs';
import { PAIR_QUESTION, pairSides, pairwise } from '../../../../scripts/play-fidelity.mjs';

const IDS = Array.from({ length: 40 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`);

/** Dva běhy klipů průběhu; `onlyA` má klip jen v běhu A. */
function runs(): { runsDir: string } {
  const runsDir = mkdtempSync(join(tmpdir(), 'p45-pair-'));
  for (const run of ['main-a', 'head-b']) {
    mkdirSync(join(runsDir, run));
    for (const id of [...IDS, 'onlyA']) {
      const pace = run === 'head-b' && id === 'onlyA' ? undefined : { robot: true, frames: [`${id}-draft-pace-1.png`, `${id}-draft-pace-2.png`], endedAtTick: null };
      writeFileSync(join(runsDir, run, `${id}.json`), JSON.stringify({ id, pace }));
    }
  }
  return { runsDir };
}

type Answer = 'A' | 'B' | 'tie';

/** Soudce, který odpoví `pick` a zapíše, kolikrát se ho kdo ptal a na jaký list. */
function judge(pick: (sheet: string) => Answer) {
  const asked: string[] = [];
  const ask = async (sheet: string, _schema: string, answerFile: string): Promise<{ code: number }> => {
    asked.push(sheet);
    writeFileSync(answerFile, JSON.stringify({ winner: pick(sheet), why: 'test' }));
    return { code: 0 };
  };
  return { ask, asked };
}

/** Skladatel listu, který si zapíše, z jakého běhu je levý a pravý sloupec. */
function composer() {
  const sheets = new Map<string, { left: string; right: string }>();
  const compose = async (left: readonly string[], right: readonly string[], path: string): Promise<void> => {
    sheets.set(path, { left: left[0] as string, right: right[0] as string });
    writeFileSync(path, 'png');
  };
  return { compose, sheets };
}

const options = (runsDir: string, out: string, seed = 45045) => ({ a: 'main-a', b: 'head-b', seed: String(seed), out, runsDir, concurrency: '2' });
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

describe('pairwise judge', () => {
  it('draws the left side from the seed alone, in id order', () => {
    expect(pairSides(45045, 40)).toEqual(pairSides(45045, 40));
    expect(pairSides(45045, 40)).not.toEqual(pairSides(45046, 40));
    const left = pairSides(45045, 40);
    expect(left.filter((side) => side === 'b').length).toBeGreaterThan(5);
    expect(left.filter((side) => side === 'a').length).toBeGreaterThan(5);
  });

  it('translates a judge that always picks the left column into the drawn sides', async () => {
    const { runsDir } = runs();
    const out = join(runsDir, 'verdict.json');
    const { compose, sheets } = composer();
    await pairwise(options(runsDir, out), { ask: judge(() => 'A').ask, compose });
    const verdict = read(out);
    const left = pairSides(45045, 40);
    expect(verdict.schema).toBe('pairwise.v1');
    expect(verdict.pairs.map((p: { id: string }) => p.id)).toEqual(IDS);
    expect(verdict.pairs.map((p: { left: string }) => p.left)).toEqual(left);
    expect(verdict.pairs.every((p: { left: string; winner: string }) => p.winner === p.left)).toBe(true);
    const bLeft = left.filter((side) => side === 'b').length;
    expect(verdict.summary).toEqual({ n: 40, aWins: 40 - bLeft, bWins: bLeft, ties: 0, bShare: Math.round((bLeft / 40) * 1000) / 1000, leftWinShare: 1 });
    // List má vlevo opravdu ten běh, který los dal doleva.
    for (const [i, pair] of verdict.pairs.entries()) {
      const sheet = [...sheets.entries()].find(([path]) => path.includes(`${pair.id}-sheet`))?.[1];
      expect(sheet?.left).toContain(left[i] === 'a' ? 'main-a' : 'head-b');
      expect(sheet?.right).toContain(left[i] === 'a' ? 'head-b' : 'main-a');
    }
  });

  it('records the runs, their commits, the seed and how the sides were drawn', async () => {
    const { runsDir } = runs();
    const out = join(runsDir, 'verdict.json');
    await pairwise({ ...options(runsDir, out), 'a-commit': '0714a352', 'b-commit': 'f7a12718' }, { ask: judge(() => 'B').ask, compose: composer().compose });
    const verdict = read(out);
    expect(verdict.a).toEqual({ run: 'main-a', commit: '0714a352' });
    expect(verdict.b).toEqual({ run: 'head-b', commit: 'f7a12718' });
    expect(verdict.seed).toBe(45045);
    expect(verdict.order).toMatch(/45045/);
    expect(verdict.summary.leftWinShare).toBe(0);
  });

  it('counts a tie as half a win for each side', async () => {
    const { runsDir } = runs();
    const out = join(runsDir, 'verdict.json');
    await pairwise(options(runsDir, out), { ask: judge(() => 'tie').ask, compose: composer().compose });
    expect(read(out).summary).toEqual({ n: 40, aWins: 0, bWins: 0, ties: 40, bShare: 0.5, leftWinShare: 0.5 });
  });

  it('does not ask again for an answer it already has', async () => {
    const { runsDir } = runs();
    const out = join(runsDir, 'verdict.json');
    const first = judge(() => 'A');
    await pairwise(options(runsDir, out), { ask: first.ask, compose: composer().compose });
    const again = judge(() => 'B');
    await pairwise(options(runsDir, out), { ask: again.ask, compose: composer().compose });
    expect(first.asked).toHaveLength(40);
    expect(again.asked).toHaveLength(0);
    expect(read(out).summary.leftWinShare).toBe(1);
  });

  it('shows the judge only sheet.png and the schema, and a question that names no run', async () => {
    const { runsDir } = runs();
    const out = join(runsDir, 'verdict.json');
    const seen: { files: string[]; args: string[]; question: string }[] = [];
    const ask = async (sheet: string, schema: string, answerFile: string, question: string): Promise<{ code: number }> => {
      // Adresář a argumenty staví skutečný `blindQuestion`; otázku test kontroluje zvlášť.
      const { cwd, args } = blindQuestion(sheet, schema);
      seen.push({ files: readdirSync(cwd).sort(), args, question });
      rmSync(cwd, { recursive: true, force: true });
      writeFileSync(answerFile, JSON.stringify({ winner: 'A', why: 'test' }));
      return { code: 0 };
    };
    await pairwise({ ...options(runsDir, out), only: 's01,s02' }, { ask, compose: composer().compose });
    expect(seen).toHaveLength(2);
    for (const { files, args, question } of seen) {
      expect(files).toEqual(['schema.json', 'sheet.png']);
      expect(args[args.indexOf('-i') + 1]).toBe('sheet.png');
      expect(question).toBe(PAIR_QUESTION);
      expect(question).not.toMatch(/main-a|head-b|0714a352|\bmain\b|\bHEAD\b/);
    }
  });
});
