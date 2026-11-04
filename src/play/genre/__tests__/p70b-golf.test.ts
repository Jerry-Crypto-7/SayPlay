/**
 * P70B T2: golf je vždy minigolf. Audit 4. 11. (`evals/play/p70b/dev.json`): holé „golf“, „golf on the moon“, „golf with
 * a penguin“, „golfing at the beach“ hrály hod – rytíř házel na jamku – a hra minigolfu nad golfovou větou hlásila
 * vymyšlené slovo („Balling isn't here yet – here's a mini golf game“). Klasifikátor, skladatel i hláška to vypadají
 * dobře i rozbité, proto věty z auditu.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';

import { classifyGenre } from '../classify';

const GOLF = (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p70b', 'dev.json'), 'utf8')) as { sentences: { half: string; text: string }[] }).sentences
  .filter((s) => s.half === 'golf')
  .map((s) => s.text);
const top = (sentence: string): string => {
  const best = classifyGenre(sentence, null).ranked[0]!;
  return `${best.genre}.${best.mode}`;
};

beforeAll(async () => {
  await loadRapier();
});

describe('golf always means minigolf (P70B T2)', () => {
  it('the quick game plays minigolf for all 20 golf sentences of the audit', () => {
    expect(GOLF).toHaveLength(20);
    expect(GOLF.filter((text) => top(text) !== 'minigolf.default')).toEqual([]);
  });

  it('the composer plays the same minigolf hole as the quick game', () => {
    const off = GOLF.filter((text) => draftGameSpecWithMeta(text, 1).genre?.genre !== 'minigolf');
    expect(off).toEqual([]);
  }, 240_000);

  it.each(['golfing', 'lets go golfing with my dog', 'golf but in a volcano', 'a golf game for my grandpa'])('a bare golf sentence plays minigolf: %s', (sentence) => {
    expect(top(sentence)).toBe('minigolf.default');
  });

  it.each([
    'bonk the moles popping out of the golf course',
    'You wander anywhere across a meadow scooping up scattered golf balls, scoring one point per ball in your bag.',
    'a golfer drives a cart across the golf course collecting lost balls',
    'whack a mole but with gophers popping out of a golf course',
  ])('golf as the place or the thing of another game stays out of minigolf: %s', (sentence) => {
    expect(top(sentence)).not.toBe('minigolf.default');
  });

  it('the honesty strip stays hidden when a golf sentence plays its own minigolf hole', async () => {
    for (const text of ['golf', 'golf on the moon', 'hit the ball into the hole', 'a cat plays golf', 'golf course with water hazards', 'golfing at the beach']) {
      const meta = draftGameSpecWithMeta(text, 1);
      expect(await honestyForSpec(text, meta.spec, 1), text).toBeNull();
    }
  }, 240_000);

  it('a golf sentence played as another game never names a made-up action like "Balling"', async () => {
    const other = draftGameSpecWithMeta('throw the ball at the target', 1).spec;
    expect(other.genre?.id).not.toBe('minigolf');
    const honesty = await honestyForSpec('golf on the moon', other, 1);
    expect(honesty?.reason ?? '').not.toMatch(/\bballing\b/i);
  }, 120_000);
});
