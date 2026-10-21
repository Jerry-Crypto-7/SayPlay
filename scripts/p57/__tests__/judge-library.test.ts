import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { gridPlan } from '../../assets/qa-grid.mjs';
import { CODEX_DAILY_CAP, cellsBack, judgeIds, judgesFor, mergeAttempts, summarize, takeCodexCall } from '../judge-library.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const counterFile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'p57-codex-'));
  dirs.push(dir);
  return path.join(dir, 'codex-calls.json');
};

describe('judgesFor', () => {
  it('gives odd sheets to Codex, even sheets to Opus and every tenth sheet to both', () => {
    expect([1, 2, 3, 9, 10, 11, 20].map(judgesFor)).toEqual([['codex'], ['claude'], ['codex'], ['codex'], ['claude', 'codex'], ['codex'], ['claude', 'codex']]);
    const sheets = Array.from({ length: 40 }, (_, index) => judgesFor(index + 1));
    expect(sheets.filter((judges) => judges.length === 2)).toHaveLength(4);
  });
});

describe('takeCodexCall', () => {
  it('allows 30 Codex calls a day, counts them in the file and starts again the next day', () => {
    const file = counterFile();
    expect(CODEX_DAILY_CAP).toBe(30);
    const today = Array.from({ length: CODEX_DAILY_CAP + 1 }, () => takeCodexCall(file, '2026-10-21'));
    expect(today.filter(Boolean)).toHaveLength(30);
    expect(today.at(-1)).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '2026-10-21': 30 });
    expect(takeCodexCall(file, '2026-10-22')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ '2026-10-21': 30, '2026-10-22': 1 });
  });
});

describe('judgeIds', () => {
  it('judges the top list in usage order, then the sample, each id once', () => {
    expect(judgeIds({ top300: ['b', 'a', 'c'], sample100: ['z', 'a', 'y'] })).toEqual(['b', 'a', 'c', 'z', 'y']);
  });
});

describe('cells back to models', () => {
  it('keeps the given order on the sheets, so the most used models share the first sheets', () => {
    const ids = ['m09', 'm03', 'm07', 'm01', 'm05'];
    const plan = gridPlan(ids.map((assetId) => ({ assetId })), 2, { keepOrder: true });
    expect(plan).toEqual([
      { sheet: 'grid-001', cells: ['m09', 'm03', 'm07', 'm01'] },
      { sheet: 'grid-002', cells: ['m05'] },
    ]);
  });

  it('maps each scored cell to its model through the grid index and leaves unread cells null', () => {
    const sheet = { sheet: 'grid-002', cells: ['gen3d-barn', 'cc0-rock', 'gen3d-fence'] };
    const scored = [{ cell: 1, name: 'barn', score: 8, recognisable: true, broken: false, styleFit: true, reason: 'ok' }, null, { cell: 3, name: 'fence', score: 3, recognisable: true, broken: true, styleFit: false, reason: 'holes' }];
    expect(cellsBack(sheet, scored)).toEqual({
      'gen3d-barn': { sheet: 'grid-002', cell: 1, name: 'barn', score: 8, recognisable: true, broken: false, styleFit: true, reason: 'ok' },
      'cc0-rock': null,
      'gen3d-fence': { sheet: 'grid-002', cell: 3, name: 'fence', score: 3, recognisable: true, broken: true, styleFit: false, reason: 'holes' },
    });
  });
});

describe('summarize', () => {
  const scored = (cell: number, score: number) => ({ cell, name: 'thing', score, recognisable: true, broken: false, styleFit: true, reason: 'r' });
  const usage = { top300: ['a', 'b', 'c'], sample100: ['x'] };
  const plan = { sheets: [{ sheet: 'grid-001', cells: ['a', 'b'] }, { sheet: 'grid-002', cells: ['c', 'x'] }] };

  it('averages the judges that read a cell, keeps unread cells null and measures agreement on the overlap only', () => {
    const report = summarize(usage, plan, {
      'grid-001': { codex: { cells: [scored(1, 9), scored(2, 4)] }, claude: { cells: [scored(1, 6), null] } },
      'grid-002': { claude: { cells: [null, scored(2, 7)] } },
    });
    expect(report.models.a.score).toBe(7.5);
    expect(report.models.b.score).toBe(4);
    expect(report.models.c.score).toBeNull();
    expect(report.nulls).toEqual(['c']);
    expect(report.agreement).toMatchObject({ cells: 1, share: 0 });
    expect(report.below6).toEqual(['b']);
    expect(report.top50Below8).toEqual(['a', 'b']);
  });

  it('fills only the holes of the first attempt from the second', () => {
    expect(mergeAttempts([scored(1, 9), null, null], [scored(1, 2), scored(2, 5), null])).toEqual([scored(1, 9), scored(2, 5), null]);
  });
});
