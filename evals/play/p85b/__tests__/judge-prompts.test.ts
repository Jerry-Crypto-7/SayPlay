/**
 * P85B T3: `docs/submission/judge-prompts.md` says what the reader produced, not what we hoped. Every sentence
 * in it has a saved Node reading (`prompts-check.json`) that passed the publish gate and gave the same game twice,
 * and the start card, goal and strip the doc quotes are that reading's, word for word. Re-reading the sentences
 * against the code is `prompts-check.ts --check`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { PromptReading } from '../prompts-check';

const doc = readFileSync('docs/submission/judge-prompts.md', 'utf8');
const { readings } = JSON.parse(readFileSync('evals/play/p85b/prompts-check.json', 'utf8')) as { readings: PromptReading[] };

/** Table rows of the doc whose second or first cell is a sentence in backticks. */
const rows = doc
  .split('\n')
  .filter((line) => line.startsWith('|'))
  .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
  .map((cells) => ({ cells, sentence: cells.map((cell) => /^`([^`]+)`$/.exec(cell)?.[1]).find((text) => text !== undefined) }))
  .filter((row): row is { cells: string[]; sentence: string } => row.sentence !== undefined);

describe('judge prompts', () => {
  it('lists 12 sentences inside the scope and 3 outside, the same 15 the reading file holds', () => {
    expect(readings.filter(({ scope }) => scope === 'in')).toHaveLength(12);
    expect(readings.filter(({ scope }) => scope === 'out')).toHaveLength(3);
    expect(rows.map(({ sentence }) => sentence).sort()).toEqual(readings.map(({ sentence }) => sentence).sort());
  });

  it('every reading passed the publish gate and gave the same game twice', () => {
    expect(readings.filter(({ gate, sameTwice }) => gate !== 'pass' || !sameTwice)).toEqual([]);
  });

  it('quotes the card, the goal and the strip of each reading word for word', () => {
    for (const { cells, sentence } of rows) {
      const reading = readings.find((candidate) => candidate.sentence === sentence)!;
      const row = cells.join(' | ');
      if (reading.scope === 'in') expect(cells[2], sentence).toBe(reading.card);
      expect(row, sentence).toContain(`"${reading.goal}"`);
      if (reading.strip !== null) expect(row, sentence).toContain(`"${reading.strip}"`);
    }
  });
});
