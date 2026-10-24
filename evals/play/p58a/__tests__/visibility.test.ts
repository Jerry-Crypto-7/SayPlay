/**
 * Souhrn viditelnosti P58A (T9): hra, která nevznikla (`visible.mjs play` zapsal `error`, snímek ani odpověď soudce
 * neexistují), je věta, ve které soudce nic neviděl – ne díra, která by běh shodila, a nikdy „vidět“.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { rowsOf, tally } from '../visibility.mjs';

it('counts a game that was never created as nothing seen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p58a-visibility-'));
  const set = join(dir, 'set.json');
  writeFileSync(set, JSON.stringify({ sentences: [{ id: 'v02', text: 'a dog escapes a farmer', hero: 'dog', foe: 'farmer', item: 'ball' }] }));
  writeFileSync(join(dir, 'v02.json'), JSON.stringify({ id: 'v02', nouns: ['dog', 'farmer'], error: 'POST 500 ' }));

  const rows = rowsOf(dir, set);
  expect(rows[0]).toMatchObject({ all: false, judge: 'none', nouns: [{ noun: 'dog', visible: false, role: 'hero' }, { noun: 'farmer', visible: false, role: 'other' }] });
  expect(tally(rows)).toMatchObject({ sentences: 1, allSeen: 0, nouns: 2, nounsSeen: 0, judges: { none: 1 } });
});
