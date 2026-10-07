/**
 * Načasování, rytmus, souboj a poletování zpátky jako žánry (P36A T11): věty
 * poptávky s tou třídou slovesa dostanou svůj žánr, každý nový žánr robot
 * vyhraje za 30–90 s a nečinný hráč prohraje, a věta bez slovesa z tabulky už
 * nepadá vždy do běžce.
 *
 * Co by vypadalo dobře a bylo špatně: modul je registrovaný, ale klasifikátor
 * do něj žádnou větu nepošle; hra je hratelná, ale trvá 8 s nebo hraje sama.
 * Hra se staví stejnou cestou jako z `/play` – rychlý návrh, semínka publikace,
 * robot a nečinný hráč.
 */

import { describe, expect, it } from 'vitest';

import { derivedSeeds, seedFrom } from '@/app/api/play/_publish';
import { compileArcade } from '@/play/arcade/compile';
import { ARCADE_HZ } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { draftGameSpecWithMeta } from '@/play/draft';

import { GENRE_MODULES } from '../index';

/** Věty poptávky (`evals/play/demand/corpus.json`) podle ruční třídy slovesa (`rules/coverage.json`). */
const SENTENCES: readonly (readonly [string, string])[] = [
  ['tap at the right time to stop the moving platform', 'timing'],
  // P41: the jumps must actually move the hero; timing remains an unmet action.
  ['time your jumps through spinning rings', 'platformer'],
  ['cut the rope at the right moment to feed the monster', 'timing'],
  ['tap to the beat with glowing tiles', 'rhythm'],
  ['piano tiles but falling from space', 'rhythm'],
  ['A drummer frog plays on lily pads and the pond lights up with the beat', 'rhythm'],
  ['cowboy duel at high noon, first to shoot wins', 'duel'],
  ['like flappy bird but underwater', 'flap'],
];

interface Published {
  readonly winSeconds: number;
  readonly idle: string;
}

/** Jako dveře publikace: první semínko, na kterém robot vyhraje. */
function publish(sentence: string): Published {
  const spec = draftGameSpecWithMeta(sentence, 1).spec;
  for (const seed of derivedSeeds(seedFrom(sentence))) {
    const compiled = compileArcade(spec, seed);
    if (!compiled.ok) continue;
    const { arcade: world, winsAtTick } = compiled.value;
    if (world == null || winsAtTick === null) continue;
    return { winSeconds: winsAtTick / ARCADE_HZ, idle: replay(world, [], ARCADE_LIBRARY).outcome };
  }
  throw new Error(`${sentence}: no seed publishes`);
}

describe('timing, rhythm, duel and flap are genres again (P36A T11)', () => {
  it('registers the four modules', () => {
    expect(Object.keys(GENRE_MODULES)).toEqual(expect.arrayContaining(['timing', 'rhythm', 'duel', 'flap']));
  });

  it.each(SENTENCES)('"%s" → %s', (sentence, genre) => {
    expect(draftGameSpecWithMeta(sentence, 1).genre?.genre as string).toBe(genre);
  });

  it.each(SENTENCES)('"%s": the robot wins in 30–90 s and an idle player loses', (sentence) => {
    const game = publish(sentence);
    expect(game.winSeconds).toBeGreaterThanOrEqual(30);
    expect(game.winSeconds).toBeLessThanOrEqual(90);
    expect(game.idle).toBe('lost');
  });
});

describe('a sentence without a verb of the table is not always a runner', () => {
  // Téma a podstatná jména rozhodnou (hudba → rytmus, rival → souboj, křídla → poletování), běžec až poslední možnost.
  it.each([
    ['a song about the sea with drums and lights', 'rhythm'],
    ['my rival from school at high noon', 'duel'],
    ['a tiny bird with wings in a cave full of pipes', 'flap'],
  ])('"%s" → %s', (sentence, genre) => {
    expect(draftGameSpecWithMeta(sentence, 1).genre?.genre as string).toBe(genre);
  });
});

// P39 T6: poletování střelbu neumí – co se ve větě střílí, je překážka s tím jménem, ne zahozená věc.
describe('flap reads the cast', () => {
  it('turns a thing it cannot shoot into the obstacle it dodges', () => {
    const game = GENRE_MODULES.flap.compile({ genre: 'flap', mode: 'default', hero: 'bird', setting: 'cave', cast: [{ label: 'bat', does: 'shoot_at' }, { label: 'gem', does: 'collect' }] });
    expect(game.roles.find((role) => role.id === 'pipe')?.label).toBe('bat');
    expect(game.roles.find((role) => role.id === 'coin')?.label).toBe('gem');
  });

  it('keeps the pipe where the sentence names nothing to dodge', () => {
    const meta = draftGameSpecWithMeta('a tiny bird with wings in a cave full of pipes', 1);
    expect(meta.spec.roles.find((role) => role.id === 'pipe')?.label).toBe('pipe');
  });
});

// P39 T7: souboj bije, s čím se věta bije; věž skládá a rytmus hraje, co věta sbírá – ne první jmenovanou věc.
describe('duel, timing and rhythm read the cast', () => {
  const roleOf = (game: { readonly roles: readonly { readonly id: string; readonly label: string }[] }, id: string) => game.roles.find((role) => role.id === id)?.label;

  it('the duel fights the thing it fights', () => {
    const game = GENRE_MODULES.duel.compile({ genre: 'duel', mode: 'default', hero: 'samurai', setting: 'dojo', cast: [{ label: 'crow', does: 'avoid' }, { label: 'ninja', does: 'fight' }] });
    expect(roleOf(game, 'rival')).toBe('ninja');
  });

  it('the stack stacks the thing it collects, the song plays it', () => {
    const cast = [{ label: 'wolf', does: 'scenery' as const }, { label: 'pancake', does: 'collect' as const }];
    expect(roleOf(GENRE_MODULES.timing.compile({ genre: 'timing', mode: 'stack', hero: 'chef', setting: 'kitchen', cast }), 'block')).toBe('pancake');
    expect(roleOf(GENRE_MODULES.rhythm.compile({ genre: 'rhythm', mode: 'default', hero: 'frog', setting: 'pond', cast }), 'note')).toBe('pancake');
  });

  it('a sentence that names what it stacks reaches the stack through the draft', () => {
    const meta = draftGameSpecWithMeta('stack pancakes as high as you can', 1);
    expect(meta.genre?.genre).toBe('timing');
    expect(meta.spec.roles.find((role) => role.id === 'block')?.label).toBe('pancake');
  });
});
