import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALIVE_QUESTION, aliveArgs, assertOpenSet, type PanelSentence, rowOf, summary, windowStart } from '../alive';

/**
 * Měřidlo „je postava živá“ (P45D T3). Soudce, který vidí název souboru nebo dostane
 * statické snímky, dá číslo, které vypadá jako měření pohybu – proto slepota a počítání
 * nad zafixovanými odpověďmi.
 */
const dragon: PanelSentence = {
  id: 'f01',
  text: 'a dragon guards its gold hoard from greedy knights inside a volcano',
  source: 'p37a-dev',
  checklist: [
    { item: 'dragon', slot: 'hero', match: ['dragon'] },
    { item: 'knights', slot: 'role', match: ['knight'] },
  ],
};
const corgi: PanelSentence = { id: 'm03', text: 'a corgi herds sheep', checklist: [{ item: 'corgi', slot: 'hero', match: ['dog', 'puppy'] }] };
const moving = { moving: true, frames: 6 };

describe('alive meter (P45D T3)', () => {
  it('counts alive and the blind name over fixed answers', () => {
    const rows = [
      rowOf(dragon, moving, { character: 'red dragon', doing: 'flapping its wings', alive: true }),
      rowOf(corgi, moving, { character: 'small dog', doing: 'running', alive: true }),
      rowOf(corgi, { moving: false, frames: 6 }, { character: 'lizard', doing: 'standing still', alive: false }),
      rowOf(dragon, moving, null),
    ];
    expect(rows.map((row) => row.likeNoun)).toEqual([true, true, false, null]);
    expect(summary(rows)).toEqual({
      sentences: 4,
      judged: 3,
      alive: { hit: 2, of: 3, share: 0.667 },
      likeNoun: { hit: 2, of: 3, share: 0.667 },
      moving: { hit: 3, of: 4, share: 0.75 },
    });
  });

  it('never shows the judge the sentence id, the switch or the word toy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alive-test-'));
    try {
      const sheet = join(dir, 'f01-toy-off-sheet.png');
      const schema = join(dir, 'f01-schema.json');
      writeFileSync(sheet, 'png');
      writeFileSync(schema, '{}');
      const { cwd, args } = aliveArgs(sheet, schema);
      try {
        const seen = [cwd, ...args].join(' ').toLowerCase();
        expect(seen).not.toContain('f01');
        expect(seen).not.toContain('toy');
        expect(seen).not.toContain('dragon');
        expect(readdirSync(cwd).sort()).toEqual(['schema.json', 'sheet.png']);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(ALIVE_QUESTION.toLowerCase()).not.toMatch(/\btoy\b/);
  });

  it('refuses a sealed set by its name and by its seal', () => {
    expect(() => assertOpenSet('evals/play/p43/sealed-100.json', [corgi])).toThrow(/sealed/);
    expect(() => assertOpenSet('evals/play/p30/test-200.json', [corgi])).toThrow(/sealed/);
    expect(() => assertOpenSet('evals/play/p45/dev.json', [{ ...corgi, source: 'sealed-p45a' }])).toThrow(/seal/);
    expect(() => assertOpenSet('evals/play/p43/panel.json', [dragon, corgi])).not.toThrow();
  });

  it('starts the six frames where the hero first moves', () => {
    expect(windowStart([false, false, true, true, false, false, false, false, false])).toBe(2);
    // Pohyb příliš pozdě na celé okno, nebo žádný: od začátku.
    expect(windowStart([false, false, false, false, true, false, false])).toBe(0);
    expect(windowStart([false, false, false, false, false, false])).toBe(0);
  });
});
