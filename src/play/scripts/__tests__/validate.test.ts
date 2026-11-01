/**
 * Ověření skriptu úrovně (P68 T13): `Date.now` / `Math.random` v kódu je chyba ověření ještě před VM, data mimo meze
 * mřížky a trati se odmítnou, uložený spec s daty mimo schéma se nepřečte, a platná úroveň projde robotem
 * (výhra robota i prohra nečinného do 90 s).
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

import type { ScriptRecording } from '../api';
import { scriptLevelFromRecording, scriptSourceIssues, scriptedSpecIssues } from '../validate';

const recording = (places: ScriptRecording['places'], paths: ScriptRecording['paths'] = []): ScriptRecording => ({ places, paths, draws: 0 });

describe('forbidden identifiers in the source', () => {
  it.each([
    ['Date.now', 'function build(api) { api.place("road", Date.now() % 9, 3); }', /Date/],
    ['new Date', 'function build(api) { const d = new Date(); }', /Date/],
    ['Math.random', 'function build(api) { api.place("road", Math.floor(Math.random() * 9), 3); }', /Math\.random/],
    ['spaced Math . random', 'function build(api) { const r = Math . random; }', /Math\.random/],
    ['performance.now', 'function build(api) { performance.now(); }', /performance/],
  ])('%s is a validation error', (_name, code, pattern) => {
    expect(scriptSourceIssues(code).join('; ')).toMatch(pattern);
  });

  it('a clean program has no issues', () => {
    expect(scriptSourceIssues('function build(api) { const rows = api.param("rows"); for (let z = 3; z < rows - 1; z += 3) api.place("road", api.rng.int(0, 8), z); }')).toEqual([]);
  });
});

describe('level data bounds', () => {
  const ok = scriptLevelFromRecording('hop', recording([['road', 0, 3], ['road', 8, 4], ['river', 4, 6]]), { rows: 20 });

  it('builds hop level data: bands from rows, the side from the column', () => {
    expect(ok).toEqual({
      ok: true,
      levelData: {
        game: 'hop',
        rows: 20,
        lanes: [
          { row: 3, kind: 'road', side: 'left' },
          { row: 4, kind: 'road', side: 'right' },
          { row: 6, kind: 'river', side: 'any' },
        ],
      },
    });
  });

  it.each([
    ['a start row', [['road', 4, 2]], /row 2/],
    ['the goal row', [['road', 4, 20]], /goal row/],
    ['a column off the grid', [['road', 9, 5]], /column 9/],
    ['a negative column', [['road', -1, 5]], /column -1/],
    ['a row placed twice', [['road', 4, 5], ['river', 4, 5]], /placed twice/],
    ['two bands with no grass between', [['road', 4, 5], ['river', 4, 6]], /grass row between/],
    ['a road band too wide', [['road', 4, 3], ['road', 4, 4], ['road', 4, 5], ['road', 4, 6], ['road', 4, 7], ['road', 4, 8]], /at most 5/],
    ['no traffic at all', [], /at least one/],
  ] as const)('refuses %s', (_name, places, pattern) => {
    const result = scriptLevelFromRecording('hop', recording(places as unknown as ScriptRecording['places']), { rows: 20 });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.issues.join('; ')).toMatch(pattern);
  });

  it('refuses a path: hop has none', () => {
    const result = scriptLevelFromRecording('hop', recording([['road', 4, 5]], [[[0, 3], [0, 9]]]), { rows: 20 });
    expect(result.ok ? '' : result.issues.join('; ')).toMatch(/path/);
  });

  it('a stored spec with level data out of range does not read', () => {
    const spec = draftGameSpecWithMeta('a chicken crossing a busy road', 1).spec;
    const digest = 'a'.repeat(64);
    const good = { ...spec, scriptLevel: { levelData: { game: 'hop', rows: 50, lanes: [{ row: 5, kind: 'road', side: 'any' }] }, codeDigest: digest, runtimeVersion: 'test' } };
    expect(readGameSpec(good).ok).toBe(true);
    for (const levelData of [
      { game: 'hop', rows: 51, lanes: [{ row: 5, kind: 'road', side: 'any' }] },
      { game: 'hop', rows: 50, lanes: [{ row: 1, kind: 'road', side: 'any' }] },
      { game: 'hop', rows: 50, lanes: [{ row: 5, kind: 'lava', side: 'any' }] },
      { game: 'hop', rows: 50, lanes: [{ row: 5.5, kind: 'road', side: 'any' }] },
    ]) {
      expect(readGameSpec({ ...good, scriptLevel: { ...good.scriptLevel, levelData } }).ok).toBe(false);
    }
  });
});

describe('solvable by the bot', () => {
  const quick = draftGameSpecWithMeta('a chicken crossing a busy road', 1).spec;
  const scripted = (lanes: { row: number; kind: 'road' | 'river' | 'rail'; side: 'left' | 'right' | 'any' }[], rows = 50): GameSpecV1 => ({
    ...quick,
    controlParams: { generator: 'hop_rows', tuning: { rows } },
    scriptLevel: { levelData: { game: 'hop', rows, lanes }, codeDigest: 'b'.repeat(64), runtimeVersion: 'test' },
  } as GameSpecV1);

  it('a scripted course of roads, a river and rails: the bot wins and the idle player loses within 90 s', () => {
    expect(quick.control).toBe('hop');
    const lanes: Parameters<typeof scripted>[0] = [3, 4, 5].map((row) => ({ row, kind: 'road', side: 'left' }));
    lanes.push({ row: 7, kind: 'road', side: 'right' }, { row: 9, kind: 'river', side: 'any' }, { row: 10, kind: 'river', side: 'any' }, { row: 12, kind: 'rail', side: 'any' });
    for (let row = 14; row < 48; row += 3) lanes.push({ row, kind: 'road', side: 'any' }, { row: row + 1, kind: 'road', side: 'any' });
    expect(scriptedSpecIssues(scripted(lanes), 1)).toEqual([]);
  }, 60_000);

  it('a level whose rows do not match the spec is refused before play', () => {
    const spec = { ...scripted([{ row: 5, kind: 'road', side: 'any' }]), controlParams: { generator: 'hop_rows', tuning: { rows: 30 } } } as GameSpecV1;
    expect(scriptedSpecIssues(spec, 1).join('; ')).toMatch(/does not fit/);
  });
});
