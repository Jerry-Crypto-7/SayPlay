import { beforeAll, expect, it } from 'vitest';
import { arcadeWorldOf } from '../../arcade/compile';
import { loadRapier } from '../../arcade/physics/world';
import { verifyArcade } from '../../arcade/verify';
import { draftGameSpecWithMeta } from '../../draft';
import { honestyForSpec } from '../../draft/unsupported';
import { scoreTriples } from '../../../../evals/play/p41/score';

beforeAll(loadRapier);

// Round one's now-open failures are regression data, never a fresh held-out score.
const cases = [
  ['hockey on a frozen lake against robots', 'robot', 'rival', 'hero'],
  ['a boxer punches to the beat and defeats a robot', 'boxer', 'duel', 'robot'],
  ['drive a boat, race and fire', 'boat', 'shoot', null],
  ['a boat race with a cannon', 'boat', 'shoot', null],
  ['football in a stadium versus bears', 'bear', 'rival', 'hero'],
  ['a knight fights to the rhythm and defeats a troll', 'knight', 'duel', 'troll'],
  ['a truck races and fires', 'truck', 'shoot', null],
  ['a helicopter race with a machine gun', 'helicopter', 'shoot', null],
  ['punch a robot to the rhythm and knock it out', 'hero', 'duel', 'robot'],
  ['bake chocolate cookies for the king', 'hero', 'bake', 'cookie'],
  ['throw pebbles at a tin can', 'hero', 'throw', 'can'],
  ['survive a hailstorm in a boat', 'hailstorm', 'hazard', 'boat'],
  ['never stop flapping as a parrot above the jungle', 'parrot', 'flap', null],
  ['bake a loaf of bread for a hungry giant', 'hero', 'bake', 'bread'],
  ['a race with dune buggies', 'buggy', 'drive', null],
  ['a race with dune buggies', 'buggy', 'race', null],
] as const;

it.each(cases)('%s proves or publicly admits every requested action on five seeds', async (sentence, actor, verb, object) => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const draft = draftGameSpecWithMeta(sentence, seed);
    const made = arcadeWorldOf(draft.spec, seed);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const verdict = verifyArcade(made.world, undefined, made.roleBindings);
    expect(verdict.publishEligible).toBe(true);
    const honesty = await honestyForSpec(sentence, draft.spec, seed, made.world);
    const score = scoreTriples([{ actor, verb, object }], verdict.witnesses, honesty?.unmet ?? []);
    expect(score.silent, JSON.stringify({ seed, honesty, witnesses: verdict.witnesses })).toEqual([]);
    if (score.missing.length) expect(honesty?.reason.trim()).toBeTruthy();
  }
}, 120000);
