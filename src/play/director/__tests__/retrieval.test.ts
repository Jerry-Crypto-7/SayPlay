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
import { draftGameSpec } from '@/play/draft';
import type { GenerationBranch } from '@/server/pipeline';

import { direct } from '..';
import { buildCompactRequest, composeCompact } from '../compact';
import { blockingIssues, critique } from '../critic';
import { DIRECTOR_EXAMPLES, EXAMPLES_MAX, EXAMPLES_MAX_CHARS, EXAMPLES_MIN, examplesBlock, nearestExamples } from '../retrieval';

const setOf = (file: string): { id: string; text: string }[] => JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p30', file), 'utf8')).sentences;
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
const DEV = setOf('dev.json');
const TEST = setOf('test-200.json');

beforeAll(async () => {
  await loadRapier();
});

describe('the example pool', () => {
  it('holds only games the robot plays to a win', () => {
    for (const example of DIRECTOR_EXAMPLES) {
      const read = composeCompact(example.sentence, example.answer);
      expect(read, example.id).toMatchObject({ ok: true });
      if (!read.ok) continue;
      expect(blockingIssues(critique(read.spec)), example.id).toEqual([]);
      expect(playabilityIssues(read.spec, derivedSeeds(seedFrom(example.sentence.trim()))), example.id).toEqual([]);
      // Pravidla promítnutá do hry, ne jen napsaná v příkladu.
      expect(read.spec.rules?.length ?? 0, example.id).toBe((example.answer.rules as unknown[]).length);
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
    expect(nearestExamples('fire the cannon at the monsters from a pirate ship', 'shooter')[0]!.id).toBe('e10');
    expect(nearestExamples('carry the kitten back to its basket', 'move_free')[0]!.id).toBe('e17');
  });

  it('gives 3–5 examples within the character budget for every measured sentence', () => {
    for (const sentence of [...DEV, ...TEST]) {
      const picked = nearestExamples(sentence.text, draftGameSpec(sentence.text).control ?? 'tap_go');
      expect(picked.length, sentence.id).toBeGreaterThanOrEqual(EXAMPLES_MIN);
      expect(picked.length, sentence.id).toBeLessThanOrEqual(EXAMPLES_MAX);
      expect(examplesBlock(picked).length, sentence.id).toBeLessThanOrEqual(EXAMPLES_MAX_CHARS);
    }
  });

  it('drops examples from the end until the block fits, never below three', () => {
    const long = DIRECTOR_EXAMPLES.map((example) => ({ ...example, answer: { ...example.answer, plan: 'x'.repeat(900) } }));
    expect(nearestExamples('a fox runs through a forest', 'runner', long)).toHaveLength(EXAMPLES_MIN);
  });
});

describe('the director prompt', () => {
  const sentence = 'a hedgehog rolls down a hill collecting apples';
  const draft = draftGameSpec(sentence);

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
    expect(plain.seen).toEqual([`${sentence}\n\nStarting point (keep or improve): ${JSON.stringify({
      control: draft.control ?? 'tap_go',
      addons: draft.addons ?? [],
      look: draft.theme.look ?? null,
      setting: draft.theme.setting,
      title: draft.title,
      labels: draft.roles.map((role) => ({ role: role.id, label: role.label })),
      goal: draft.tutorial.goalLine,
    })}`]);
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
