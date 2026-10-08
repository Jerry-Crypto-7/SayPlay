import { beforeAll, describe, expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness } from '@/play/arcade/witness';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import type { IntentTriple } from '../contract';

// Stavění, osvobozování a hlídkování: sloveso se buď zahraje (svědek), nebo se
// poctivě ohlásí v `honesty.unmet` se správným aktérem i předmětem – nikdy
// nezmizí ani nedostane aktéra „patrol“. Šablony s vlastními slovy.
beforeAll(async () => { await loadRapier(); });

const HEROES = [
  { noun: 'lynx', moves: 'prowls through the canyon', place: 'canyon' },
  { noun: 'gnome', moves: 'tiptoes across the attic', place: 'attic' },
] as const;
const THINGS = [{ plural: 'lanterns', one: 'lantern' }, { plural: 'pumpkins', one: 'pumpkin' }] as const;
const CAPTIVES = [{ plural: 'puppies', one: 'puppy' }, { plural: 'parrots', one: 'parrot' }] as const;
const WATCHERS = [{ plural: 'wolves', one: 'wolf' }, { plural: 'scarecrows', one: 'scarecrow' }] as const;

const triple = (actor: string, verb: string, object: string | null): IntentTriple => ({ actor, verb, object });
const CASES = HEROES.flatMap((hero) => [
  ...THINGS.flatMap((thing) => [
    { sentence: `A ${hero.noun} stacks ${thing.plural}.`, triple: triple(hero.noun, 'stack', thing.one) },
    { sentence: `A ${hero.noun} ${hero.moves} and stacks ${thing.plural}.`, triple: triple(hero.noun, 'stack', thing.one) },
  ]),
  ...CAPTIVES.flatMap((captive) => [
    { sentence: `A ${hero.noun} ${hero.moves} and frees caged ${captive.plural}.`, triple: triple(hero.noun, 'interact', captive.one) },
    { sentence: `A ${hero.noun} releases trapped ${captive.plural} in the ${hero.place}.`, triple: triple(hero.noun, 'interact', captive.one) },
    { sentence: `A ${hero.noun} ${hero.moves} to free the ${captive.plural}.`, triple: triple(hero.noun, 'interact', captive.one) },
    { sentence: `A ${hero.noun} liberates ${captive.plural}.`, triple: triple(hero.noun, 'interact', captive.one) },
  ]),
  ...WATCHERS.flatMap((watcher) => [
    { sentence: `A ${hero.noun} ${hero.moves} while ${watcher.plural} patrol.`, triple: triple(watcher.one, 'guard', hero.noun) },
    { sentence: `A ${hero.noun} dodges ${watcher.plural} who patrol the ${hero.place}.`, triple: triple(watcher.one, 'guard', hero.noun) },
  ]),
  { sentence: `A ${hero.noun} patrols the ${hero.place}.`, triple: triple(hero.noun, 'guard', hero.place) },
]);
const same = (a: IntentTriple, b: IntentTriple) => a.actor === b.actor && a.verb === b.verb && a.object === b.object;

describe('stack, free and patrol reach a mechanic or an honest admission', () => {
  it('covers every verb form for two heroes', () => {
    expect(CASES).toHaveLength(2 * (2 * 2 + 2 * 4 + 2 * 2 + 1));
  });

  it.each(CASES)('$sentence', async ({ sentence, triple: expected }) => {
    vi.stubEnv('PLAY_READER', 'off');
    try {
      const { spec } = draftGameSpecWithMeta(sentence, 1);
      const made = arcadeWorldOf(spec, 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const witnesses = verifyArcade(made.world, undefined, made.roleBindings).witnesses;
      const unmet = (await honestyForSpec(sentence, spec, 1, made.world))?.unmet ?? [];
      const played = witnesses.some((witness) => matchesWitness(expected, witness));
      const admitted = unmet.some((item) => same(item, expected));
      expect(played || admitted, `${expected.actor}/${expected.verb}/${expected.object} lost; unmet=${JSON.stringify(unmet)}`).toBe(true);
      expect(unmet.some((item) => item.actor === 'patrol'), 'no actor called patrol').toBe(false);
    } finally { vi.unstubAllEnvs(); }
  }, 60_000);
});
