/**
 * P85B T2: the evidence map for readers and agents points only at files a clean clone has, and the checker
 * that says so notices a missing file, a line past the end of one and a part with too few rows.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { evidenceProblems, referencesOf } from '../check-evidence.mjs';

const GOOD = '| x | `src/a.ts:1` | `git grep -n "one" src/a.ts` |';
const scratch = mkdtempSync(join(tmpdir(), 'p85b-evidence-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A repository with one map part of `rows` and `src/a.ts` holding one line. */
function repoWith(name: string, rows: readonly string[]): string {
  const repo = join(scratch, name);
  mkdirSync(join(repo, 'docs/submission'), { recursive: true });
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'docs/submission/evidence.md'), `## Part\n\n| Claim | Where | Check it |\n|---|---|---|\n${rows.join('\n')}\n`);
  writeFileSync(join(repo, 'src/a.ts'), 'one');
  return repo;
}

describe('evidence map', () => {
  it('every path on the real map exists and every part has at least five rows', () => {
    expect(evidenceProblems().problems).toEqual([]);
  });

  it('reads paths from code, commands and links; skips quoted arguments, flags, URLs and site paths', () => {
    const refs = referencesOf('| a | `src/x.ts:12` | `npx vitest run src/y.test.ts -t "c/d.ts"` [l](../../z.md) [s](https://e.com/a.md) `/api/health` |');
    expect(refs.map(({ path, line }) => [path, line])).toEqual([['z.md', null], ['src/x.ts', 12], ['src/y.test.ts', null]]);
  });

  it('passes a map whose paths and lines all exist', () => {
    expect(evidenceProblems(repoWith('good', [GOOD, GOOD, GOOD, GOOD, GOOD])).problems).toEqual([]);
  });

  it('flags a missing file and a line past the end', () => {
    const repo = repoWith('broken', [GOOD, GOOD, GOOD, '| x | `src/a.ts:2` | – |', '| x | `src/gone.ts` | – |']);
    expect(evidenceProblems(repo).problems).toEqual(['src/a.ts:2 – the file has 1 lines', 'src/gone.ts does not exist (from `src/gone.ts`)']);
  });

  it('flags a part with fewer than five rows', () => {
    expect(evidenceProblems(repoWith('short', [GOOD, GOOD, GOOD, GOOD])).problems).toEqual(['section "Part" has 4 rows, at least 5 are needed']);
  });
});
