/**
 * P56A T8: `readForChain()` je kontrakt pro řetěz mikroher (P56C). Pinuje tvar a jeden zdroj pravdy – hrdina, svět
 * a název jsou tytéž jako ve specu návrhu téže věty, se čtením i bez něj.
 */

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { LOOK_IDS, lookOf } from '@/play/arcade/look';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { readForChain } from '@/play/read/for-chain';
import { VERB_CLASSES, type Reading } from '@/play/read/schema';

interface Sentence { readonly id: string; readonly text: string }

const AUDIT = (JSON.parse(readFileSync('evals/play/p56a/audit-12.json', 'utf8')) as { sentences: Sentence[] }).sentences;
const READS = new Map(
  (JSON.parse(readFileSync('evals/play/p56a/readings/audit-12.gpt-oss-20b.json', 'utf8')) as { readings: { id: string; reading: Reading | null }[] }).readings.map((row) => [row.id, row.reading]),
);
const CASES = AUDIT.flatMap((sentence) => [
  { name: `${sentence.id} read`, text: sentence.text, reading: READS.get(sentence.id) ?? null },
  { name: `${sentence.id} words`, text: sentence.text, reading: null },
]);

beforeAll(async () => { await loadRapier(); });

describe('readForChain – what the microgame chain gets from the sentence (P56A T8)', () => {
  it.each(CASES)('$name: every field, at most 4 verbs, source by the reading', ({ text, reading }) => {
    const read = readForChain(text, reading);
    expect(Object.keys(read).sort()).toEqual(['foe', 'hero', 'item', 'look', 'source', 'title', 'verbs']);
    expect(read.hero).not.toBe('');
    expect(LOOK_IDS).toContain(read.look);
    expect(read.verbs.length).toBeLessThanOrEqual(4);
    for (const verb of read.verbs) expect(VERB_CLASSES).toContain(verb.class);
    expect(read.source).toBe(reading === null ? 'lexicon' : 'llm');
  });

  it.each(CASES)('$name: hero, look and title are those of the drafted spec', ({ text, reading }) => {
    const spec = draftGameSpecWithMeta(text, 1, { reading }).spec;
    const read = readForChain(text, reading);
    expect(read.hero).toBe(spec.roles.find((role) => role.kind === 'player')?.label);
    expect(read.look).toBe(lookOf(spec.theme));
    expect(read.title).toBe(spec.title);
  });

  it('takes the verbs of the reading, main verb first', () => {
    const reading = READS.get('a01')!;
    expect(readForChain(AUDIT[0].text, reading).verbs).toEqual(reading.verbs);
  });

  it('names the main verb of the sentence without a reading', () => {
    const verbs = readForChain('a knight jumps over lava pits', null).verbs;
    expect(verbs).toEqual([{ word: 'jump', class: 'platform' }]);
  });
});
