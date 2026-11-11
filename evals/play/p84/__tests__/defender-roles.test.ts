/**
 * P84 T2: „X chytá / brání Y, které hází Z“ – hráč je X, soupeř je Z a hraje se chytání (věc letí k hráči a ten ji
 * chytí; soupeř padá jako to, čemu se hráč vyhne). Před opravou: „A goalkeeper penguin blocks snowballs thrown by a
 * polar bear …“ hrál hod s cílem „Hit every goalkeeper“ – hráč házel na brankáře, ačkoli brankář je on a hází medvěd.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readFacts } from '@/components/play/lab';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { extractIntent } from '@/play/intent/extract';

beforeAll(async () => {
  await loadRapier();
});

const DEFENDERS = [
  ['A goalkeeper penguin blocks snowballs thrown by a polar bear until the whistle blows', 'penguin', 'polar bear', 'snowball'],
  ['A goalie fox stops pucks shot by a wolf', 'fox', 'wolf', 'puck'],
  ['A robot keeper catches balls thrown by a monkey', 'keeper', 'monkey', 'ball'],
  ['A knight blocks arrows fired by an archer', 'knight', 'archer', 'arrow'],
] as const;

describe('P84 T2: the defender is the player, the thrower is the opponent', () => {
  it.each(DEFENDERS)('%s', (sentence, you, against, caught) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    const facts = readFacts(spec, 'draft', sentence);
    expect(spec.genre?.id).toBe('catch');
    expect(facts.you).toMatch(new RegExp(`\\b${you}$`));
    expect(facts.against).toEqual([against]);
    expect(spec.roles.find((role) => role.kind === 'collectible')?.label).toBe(caught);
    expect(spec.tutorial.goalLine).not.toMatch(/^Hit every/);
    expect(spec.tutorial.goalLine).toMatch(/^Catch \d+ /);
  });

  it('the throw after “by” is the thrower’s, never an action the player misses', async () => {
    const [sentence] = DEFENDERS[0];
    const intent = extractIntent(sentence);
    expect(intent.items.some((item) => item.essential && item.verb === 'throw')).toBe(false);
    expect(intent.items.some((item) => item.essential && item.actor === 'goalkeeper')).toBe(false);
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    const reason = (await honestyForSpec(sentence, spec, 1))?.reason ?? '';
    expect(reason).toMatch(/isn't here yet/);
    expect(reason).not.toMatch(/throwing|rivals/i);
  });

  it('dodging what someone throws stays its own game', () => {
    expect(draftGameSpecWithMeta('A knight dodges arrows fired by archers', 1).spec.genre?.id).not.toBe('catch');
  });
});
