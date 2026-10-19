/**
 * Sloveso věty na tlačítku a v nápovědě i u akcí, které P52 přidal žánrům (T5–T8): úder v bludišti,
 * krádež ve střílečce. Obecné „Strike“ místo „Punch“ projde každým testem světa – sloveso věty by
 * zůstalo neviditelné. Věty psané pro tenhle test, ne ze sad měření.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

import { AbilityButton } from '@/components/play/arcade/ActionButton';
import type { ArcadeSession } from '@/components/play/arcade/session';

import { loadRapier } from '../arcade/physics/world';
import { draftGameSpec } from '../draft';

beforeAll(async () => {
  await loadRapier();
});

const CASES = [
  ['a knight walks through the castle maze and punches the skeletons in his way', 'walker', 'strike', 'Punch'],
  ['a cannon on the castle wall shoots the bats and snatches the coins they drop', 'shooter', 'grab', 'Snatch'],
] as const;

describe('P52 T10: the new genre actions show the sentence verb', () => {
  it.each(CASES)('%s', (sentence, control, ability, word) => {
    const spec = draftGameSpec(sentence);
    expect(spec.control).toBe(control);
    expect(spec.abilities).toContain(ability);
    const slot = spec.abilities!.indexOf(ability);
    expect(spec.abilityWords?.[slot]).toBe(word);
    expect(spec.tutorial.controlsHint).toContain(`to ${word.toLowerCase()}`);
    const session = { world: { abilities: spec.abilities } } as unknown as ArcadeSession;
    const html = renderToStaticMarkup(createElement(AbilityButton, { session, ability, slot, stack: slot, word: spec.abilityWords?.[slot] }));
    expect(html).toContain(word);
  });
});
