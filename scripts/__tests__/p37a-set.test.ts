/**
 * Vývojová sada P37A (T1): 150 vět psaných jako porotce, bez pohledu do
 * zapečetěné sady. Sada je k ničemu, když tiše převezme větu odjinud –
 * hlavně z testovací sady, kterou by tím pootevřela – nebo když skupiny
 * přestanou sedět, proto tu drží tvar, počty a průniky.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCorpus, loadSet, normalizeSentence } from '../play-fidelity.mjs';

const ROOT = process.cwd();
const PLAY = join(ROOT, 'evals', 'play');
const SET = join(PLAY, 'p37a', 'dev-150.json');
const readLf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

type Sentence = { id: string; source: string; group: string; tags: string[]; text: string; checklist: { item: string; slot: string }[] };
const sentencesOf = (path: string): { text: string }[] => JSON.parse(readLf(path)).sentences;

const DEV: Sentence[] = JSON.parse(readLf(SET)).sentences;

/** Skupina → písmeno id a počet vět (AC T1). */
const GROUPS = { 'unknown-verb': ['u', 60], 'non-game': ['n', 40], fantasy: ['f', 30], mix: ['m', 20] } as const;
const MIX_TAGS = ['short', 'typo', 'two-verbs'];

describe('P37A dev set', () => {
  it('holds 150 valid sentences in four groups of 60, 40, 30 and 20', () => {
    expect(checkCorpus({ sentences: DEV })).toEqual([]);
    expect(DEV).toHaveLength(150);
    expect(DEV.every((sentence) => sentence.source === 'p37a-dev')).toBe(true);
    for (const [group, [letter, count]] of Object.entries(GROUPS)) {
      const ids = DEV.filter((sentence) => sentence.group === group).map((sentence) => sentence.id);
      const expected = Array.from({ length: count }, (_, index) => `${letter}${String(index + 1).padStart(2, '0')}`);
      expect(ids, group).toEqual(expected);
    }
  });

  it('tags every sentence with what its group promises', () => {
    for (const sentence of DEV) {
      if (sentence.group === 'mix') expect(sentence.tags.filter((tag) => MIX_TAGS.includes(tag)), sentence.id).toHaveLength(1);
      else expect(sentence.tags, sentence.id).toContain(sentence.group);
    }
    const tagged = (tag: string) => DEV.filter((sentence) => sentence.tags.includes(tag)).length;
    expect(tagged('unknown-verb')).toBeGreaterThanOrEqual(60);
    expect(tagged('non-game')).toBeGreaterThanOrEqual(40);
    expect(tagged('fantasy')).toBeGreaterThanOrEqual(30);
    for (const tag of MIX_TAGS) expect(tagged(tag), tag).toBeGreaterThanOrEqual(5);
  });

  it('shares no sentence with the corpus, judge-10, the P30 dev set, the demand sentences or the sealed test', () => {
    const others = [
      ...sentencesOf(join(PLAY, 'fidelity', 'corpus.json')),
      ...sentencesOf(join(PLAY, 'fidelity', 'judge-10.json')),
      ...sentencesOf(join(PLAY, 'p30', 'dev.json')),
      ...(JSON.parse(readLf(join(PLAY, 'demand', 'corpus.json'))) as { text: string }[]),
      // Jen strojové porovnání po normalizaci; obsah testovací sady se nevypisuje.
      ...sentencesOf(join(PLAY, 'p30', 'test-200.json')),
    ];
    const known = new Set(others.map((sentence) => normalizeSentence(sentence.text)));
    const own = DEV.map((sentence) => normalizeSentence(sentence.text));
    expect(new Set(own).size).toBe(150);
    expect(DEV.filter((_, index) => known.has(own[index])).map((sentence) => sentence.id)).toEqual([]);
  });

  it('loads through the fidelity runner without touching the seal', () => {
    expect(loadSet(SET, { sealDir: join(PLAY, 'p37a') })).toHaveLength(150);
  });
});
