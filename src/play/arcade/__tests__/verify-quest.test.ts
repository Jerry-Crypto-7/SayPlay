/**
 * Sloveso úkolu dokazuje posun stavu cíle (P32G T3).
 *
 * Co by vypadalo dobře a přitom bylo špatně: pravidlo `interact` si při každém
 * tiku držení píše rozdělanou práci do čítače `trigger`. Kdyby se to počítalo
 * jako změna, hasič by měl „dokázané“ hašení, i když strom nikdy nezhasne.
 * Důkaz slovesa úkolu je proto jen `stateChange` na cíli.
 */

import { describe, expect, it } from 'vitest';

import type { ArcadeWorld } from '../contract';
import { type ArcadeLibrary, buildWorld } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { questSpatial, questStation } from '../pieces/quest';
import { verifyArcade } from '../verify';

function build(seed: number, parts: ReturnType<typeof questSpatial.parts>): ArcadeWorld {
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const SEED = 7;
const HEROES = {
  hasič: { verb: 'extinguish', world: () => build(SEED, questSpatial.parts(SEED, questSpatial.params.parse({ count: 4, states: 3, verb: 'extinguish' }), undefined)) },
  čaroděj: { verb: 'light', world: () => build(SEED, questSpatial.parts(SEED, questSpatial.params.parse({ count: 5, chasers: 2, verb: 'light' }), undefined)) },
  kuchař: { verb: 'flip', world: () => build(SEED, questStation.parts(SEED, questStation.params.parse({ verb: 'flip' }), undefined)) },
};

/** Knihovna, kde `interact` drží práci v čítači, ale stav cíle neposune a nevyhraje. */
const DEAD_INTERACT: ArcadeLibrary = (() => {
  const live = ARCADE_LIBRARY.rules.interact;
  if (live === undefined) throw new Error('interact missing from the library');
  const dead = { ...live, fire: (ctx: Parameters<typeof live.fire>[0], params: unknown) => live.fire(ctx, params).filter((effect) => effect.kind !== 'stateChange' && effect.kind !== 'win') };
  return { ...ARCADE_LIBRARY, rules: { ...ARCADE_LIBRARY.rules, interact: dead } };
})();

describe('quest verbs are proven by target state changes', () => {
  for (const [hero, { verb, world }] of Object.entries(HEROES)) {
    it(`${hero} (${verb}): the bot wins and the proof is a target changing state`, () => {
      const verdict = verifyArcade(world());
      expect(verdict.failures).toEqual([]);
      const proof = verdict.verbs.find((known) => known.verb === verb);
      expect(proof?.changed).toBe(true);
      expect(proof?.evidence).toMatch(/^body \d+ now in state \d+ at tick \d+$/);
    });
  }

  it('an interact rule that never moves a target state is VERB_NO_EFFECT', () => {
    const verdict = verifyArcade(HEROES.hasič.world(), DEAD_INTERACT);
    expect(verdict.bot.changes.has('extinguish')).toBe(false);
    expect(verdict.failures).toContainEqual(expect.stringContaining('VERB_NO_EFFECT:extinguish'));
  });
});
