/**
 * Lišta cílů (P33 T6): nepřítel není klikací cíl. Pes, který lišku honí, na
 * liště stál jako „6 s dog GO“ – klepnutí na něj poslalo lišku psovi do tlamy.
 * Teď kartu cíle nedostane (ani číslo klávesy) a lišta ho ukáže jako
 * „avoid“ bez tlačítka. Karta cíle nese ikonu typu a jméno, žádné „Go“.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { RuntimeAction } from '@/worldstream/runtime-input';

import collectExit from '@/play/__fixtures__/collect_exit.json';
import { readGameSpec } from '@/play/spec';

import { TargetCards } from '../TargetCards';
import { avoidCards, roleKinds, targetCards } from '../targets';

const ACTIONS: readonly RuntimeAction[] = [
  { actor: 'visitor', actionId: 'moveTo', target: 'gem' },
  { actor: 'visitor', actionId: 'pickup', target: 'gem' },
  { actor: 'visitor', actionId: 'moveTo', target: 'hound' },
  { actor: 'visitor', actionId: 'moveTo', target: 'gate' },
];

const OBJECTS = [{ stableId: 'houndShape', label: 'dog', binding: { entityId: 'hound' } }];

function world() {
  const read = readGameSpec(collectExit);
  if (!read.ok) throw new Error('fixture');
  const spec = { ...read.value, roles: [...read.value.roles, { id: 'dog', kind: 'chaser' as const, label: "farmer's dog", count: 1 }] };
  const entities = { visitor: { role: 'player' }, gem: { role: 'mushroom' }, hound: { role: 'dog' }, gate: { role: 'portal' } };
  return roleKinds(spec, { entities });
}

describe('enemies on the target bar', () => {
  it('a chaser gets no target card and no key number, only an avoid entry', () => {
    const kinds = world();
    const avoid = avoidCards(kinds, OBJECTS);
    expect(avoid).toEqual([{ id: 'hound', label: 'dog' }]);
    const cards = targetCards(ACTIONS, OBJECTS, new Set(avoid.map((card) => card.id)));
    expect(cards.map((card) => card.id)).toEqual(['gem', 'gate']);
  });

  it('draws the enemy without a button, with the word avoid', () => {
    const kinds = world();
    const avoid = avoidCards(kinds, OBJECTS);
    const cards = targetCards(ACTIONS, OBJECTS, new Set(avoid.map((card) => card.id)));
    const html = renderToStaticMarkup(createElement(TargetCards, { cards, avoid, kinds, selected: null, disabled: false, onTap: () => {} }));
    const enemy = html.slice(html.indexOf('data-testid="play-avoid-hound"'));
    expect(enemy).not.toBe(html);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).not.toContain('play-target-hound');
    expect(enemy.slice(0, enemy.indexOf('<button'))).toContain('>avoid<');
  });

  it('a target card is an icon and a name, never the word Go', () => {
    const kinds = world();
    const cards = targetCards(ACTIONS, OBJECTS, new Set(['hound']));
    const html = renderToStaticMarkup(createElement(TargetCards, { cards, avoid: [], kinds, selected: null, disabled: false, onTap: () => {} }));
    expect(html).not.toMatch(/>Go</i);
    expect(html.match(/<svg class="play-icon"/g)).toHaveLength(2);
    // Vybraná karta dál říká, co udělá druhé klepnutí.
    const picked = renderToStaticMarkup(createElement(TargetCards, { cards, avoid: [], kinds, selected: 'gem', disabled: false, onTap: () => {} }));
    expect(picked).toContain('Pick up');
  });
});
