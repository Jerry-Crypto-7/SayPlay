/**
 * P84 T1: „místo, kde klepnutí na věc s ní něco udělá“ je klikací simulace a hrdina není útržek věty.
 * Před opravou: „An aquarium where tapping a fish makes it swim …“ hrálo plavání s hrdinou „aquarium where“ a žralokem,
 * kterého věta nemá; „A pond where tapping a frog makes it jump“ skákačku s hrdinou „pond where“.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { readFacts } from '@/components/play/lab';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';

beforeAll(async () => {
  await loadRapier();
});

const TAP_PLACES = [
  ['An aquarium where tapping a fish makes it swim to the surface and blow a bubble', 'aquarium', 'fish'],
  ['A pond where tapping a frog makes it jump', 'pond', 'frog'],
  ['A garden where clicking a flower makes it bloom', 'garden', 'flower'],
  ['A night sky where tapping a star makes it twinkle', 'sky', 'star'],
] as const;

const FRAGMENT = /\b(?:where|that|which|with|and)$/;

describe('P84 T1: a place where tapping a thing does something is a tap-to-explore scene', () => {
  it.each(TAP_PLACES)('%s', (sentence, place, thing) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    const facts = readFacts(spec, 'draft', sentence);
    expect(spec.genre?.id).toBe('orrery');
    expect(facts.you).not.toBeNull();
    expect(facts.you!).not.toMatch(FRAGMENT);
    expect(facts.you!).not.toContain(place);
    expect(facts.against).toEqual([]);
    expect(facts.place).toContain(place);
    const targets = spec.roles.filter((role) => role.kind === 'target').map((role) => role.label);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((label) => label === thing)).toBe(true);
  });

  it('what the scene cannot do (swim, jump) is admitted on the strip', async () => {
    for (const [sentence] of TAP_PLACES.slice(0, 2)) {
      const { spec } = draftGameSpecWithMeta(sentence, 1);
      expect((await honestyForSpec(sentence, spec, 1))?.reason).toMatch(/isn't here yet/);
    }
  });

  it('the goal names the thing in its own plural', () => {
    expect(draftGameSpecWithMeta(TAP_PLACES[0][0], 1).spec.tutorial.goalLine).toBe('Tap the fish!');
  });
});
