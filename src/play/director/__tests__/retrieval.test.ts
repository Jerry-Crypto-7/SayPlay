/**
 * Ověřené příklady v promptu režiséra (P30A T8). Připíchnuté je, co by se
 * v odpovědi modelu nedalo poznat: příklad, který robot nedohraje, by model
 * učil nehratelný tvar; věta z testovací sady by měření četlo s odpovědí;
 * blok nad rozpočtem by zdražil každé volání; a bez proměnné se prompt nesmí
 * pohnout ani o bajt.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { derivedSeeds, playabilityIssues, seedFrom } from '@/app/api/play/_publish';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import type { GenreModule } from '@/play/genre/contract';
import { GENRE_MODULES } from '@/play/genre/index';
import type { GenerationBranch } from '@/server/pipeline';

import { direct } from '..';
import { readyModes } from '../answer-schema';
import { buildCompactRequest } from '../compact';
import { blockingIssues, critique } from '../critic';
import { checklistLines } from '../prompt';
import { readGenreAnswer } from '../read';
import { DIRECTOR_EXAMPLES, EXAMPLES_MAX, EXAMPLES_MAX_CHARS, EXAMPLES_MIN, exampleSpec, examplesBlock, nearestExamples } from '../retrieval';

const setOf = (file: string): { id: string; text: string }[] => JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p30', file), 'utf8')).sentences;
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const DEV = setOf('dev.json');
const TEST = setOf('test-200.json');

beforeAll(async () => {
  await loadRapier();
});

describe('the example pool', () => {
  // P32B T4: odpověď je `GenreSpec`, hru z něj skládá modul žánru – stejná cesta jako odpověď modelu.
  it('holds only games the robot plays to a win', () => {
    for (const example of DIRECTOR_EXAMPLES) {
      const read = readGenreAnswer(example.answer);
      expect(read, example.id).toMatchObject({ ok: true });
      if (!read.ok) continue;
      expect(blockingIssues(critique(read.spec)), example.id).toEqual([]);
      expect(playabilityIssues(read.spec, derivedSeeds(seedFrom(example.sentence.trim()))), example.id).toEqual([]);
    }
  });

  it('shares no sentence with the sealed test set or the dev set', () => {
    const measured = new Set([...TEST, ...DEV].map((sentence) => normalize(sentence.text)));
    expect(TEST).toHaveLength(200);
    expect(DIRECTOR_EXAMPLES.filter((example) => measured.has(normalize(example.sentence))).map((example) => example.id)).toEqual([]);
    expect(new Set(DIRECTOR_EXAMPLES.map((example) => example.id)).size).toBe(DIRECTOR_EXAMPLES.length);
  });
});

describe('nearestExamples', () => {
  it('picks the closest games by the words of the sentence, the same every time', () => {
    const picked = nearestExamples('a fox runs through the snowy forest jumping logs', 'runner');
    expect(picked[0]!.id).toBe('e01');
    expect(nearestExamples('a fox runs through the snowy forest jumping logs', 'runner').map((example) => example.id)).toEqual(picked.map((example) => example.id));
    expect(nearestExamples('fire the cannon at the monsters from a pirate ship', 'voyage')[0]!.id).toBe('e10');
    expect(nearestExamples('sneak past the guard dogs in the museum', 'arena')[0]!.id).toBe('e16');
  });

  it('offers only examples in a mode that plays today', () => {
    const ready = (id: string) => {
      const spec = exampleSpec(DIRECTOR_EXAMPLES.find((example) => example.id === id)!);
      return readyModes(GENRE_MODULES[spec.genre] as GenreModule).includes(spec.mode);
    };
    const offered = DIRECTOR_EXAMPLES.flatMap((example) => nearestExamples(example.sentence, exampleSpec(example).genre)).map((example) => example.id);
    expect(offered.filter((id) => !ready(id))).toEqual([]);
    const carry = nearestExamples('carry the kitten back to its basket', 'quest').map((example) => example.id);
    expect(carry.includes('e17')).toBe(ready('e17'));
  });

  it.each([...DEV, ...TEST])('gives 3–5 examples within the character budget: $id', sentence => {
      const picked = nearestExamples(sentence.text, draftGameSpecWithMeta(sentence.text).genre?.genre ?? null);
      expect(picked.length, sentence.id).toBeGreaterThanOrEqual(EXAMPLES_MIN);
      expect(picked.length, sentence.id).toBeLessThanOrEqual(EXAMPLES_MAX);
      expect(examplesBlock(picked).length, sentence.id).toBeLessThanOrEqual(EXAMPLES_MAX_CHARS);
  });

  it('drops examples from the end until the block fits, never below three', () => {
    const long = DIRECTOR_EXAMPLES.map((example) => ({ ...example, answer: { ...example.answer, plan: 'x'.repeat(900) } }));
    expect(nearestExamples('a fox runs through a forest', 'runner', long)).toHaveLength(EXAMPLES_MIN);
  });
});

describe('the director prompt', () => {
  const sentence = 'a hedgehog rolls down a hill collecting apples';
  const draft = draftGameSpecWithMeta(sentence).genre;

  /** Větev, která si zapamatuje požadavek a odpoví, že model není. */
  const recording = () => {
    const seen: string[] = [];
    const branch: GenerationBranch = {
      id: 'live',
      pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
      worstCaseUsd: () => 0,
      generate: async (call) => {
        seen.push(call.request.user);
        return { ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: 'recorded', usage: null };
      },
    };
    return { seen, branch };
  };

  it('is byte-for-byte the old prompt without the examples switch', async () => {
    const plain = recording();
    await direct(sentence, { branch: plain.branch, now: Date.now, compact: true });
    expect(draft).not.toBeNull();
    // P37A T8: zpráva nese mezi větou a výchozím bodem kontrolní seznam věty (`checklistLines`); příklady dál jen s přepínačem.
    expect(plain.seen).toEqual([`${sentence}\n\n${checklistLines(sentence)}\n\nStarting point (a keyword guess, replace what it got wrong): ${JSON.stringify(draft)}`]);
    expect(buildCompactRequest(sentence, draft)).toEqual(buildCompactRequest(sentence, draft, false));
  });

  it('carries 3–5 verified examples after the starting point when switched on', async () => {
    const plain = recording();
    const withExamples = recording();
    await direct(sentence, { branch: plain.branch, now: Date.now, compact: true });
    await direct(sentence, { branch: withExamples.branch, now: Date.now, compact: true, examples: true });
    const [user] = withExamples.seen;
    expect(user!.startsWith(`${plain.seen[0]!}\n\nVerified games for similar sentences`)).toBe(true);
    const lines = user!.slice(plain.seen[0]!.length).trim().split('\n').slice(1);
    expect(lines.length).toBeGreaterThanOrEqual(EXAMPLES_MIN);
    expect(lines.length).toBeLessThanOrEqual(EXAMPLES_MAX);
    for (const line of lines) expect(DIRECTOR_EXAMPLES.map((example) => example.sentence)).toContain(JSON.parse(line).sentence);
  });
});
