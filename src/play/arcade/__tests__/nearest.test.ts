/**
 * Nejbližší model katalogu místo kostky (P37A T6). Špatný model vypadá na snímku
 * pořád jako model – okem projde lenochod za „slot machine“ i zvon za „quantum
 * physics“. Test proto drží práh nad stropem abstraktních slov, shody, které
 * mají projít, a to, že návrh (`modelOf`) se nezměnil.
 */

import { describe, expect, it } from 'vitest';

import { NEAREST_MIN, heroChoice, modelOf, sceneModelOf } from '../models';
import nearest from '../nearest.json';

describe('nearest catalog model', () => {
  it('keeps the threshold above the best score an abstract word reaches', () => {
    // Po přepočtu tabulky (dávka P37D) se strop může zvednout – pak práh znovu nakalibrovat.
    expect(NEAREST_MIN).toBeGreaterThan(nearest.abstractCeiling);
  });

  it('draws the nearest model for a noun the catalog has no tag for', () => {
    expect(modelOf('luxury yacht', false)).toBe('gen3d-yacht');
    // Šiška (dřív `cc0-pine`) má od P62 T2 vlastní model, příkladem je patník.
    expect(modelOf('bollard', false)).toBeUndefined();
    expect(sceneModelOf('bollard', false)).toBe('gen3d-street-bollard');
    expect(sceneModelOf('luxury yacht', false)).toBe('gen3d-yacht');
    expect(sceneModelOf('hockey puck', false)).toBe('gen3d-hockey-puck');
    expect(sceneModelOf('acorns', false)).toBe('gen3d-acorn');
  });

  it('keeps a shape for a match below the threshold', () => {
    // „rabbit → turtle“ 0,56, „fashion → dress“ 0,62: pod prahem je shoda napůl šum.
    // „fireball“ a „yacht“ od P37D mají vlastní model z knihovny, proto tu nejsou.
    for (const label of ['quantum physics', 'receipt', 'scary receipt', 'fashion']) {
      expect(sceneModelOf(label, false), label).toBeUndefined();
      expect(sceneModelOf(label, true), label).toBeUndefined();
    }
    expect(heroChoice('quantum physics', undefined, undefined, 'enemy')).toMatchObject({ model: 'rigged:blocky-robot', level: 'fallback' });
  });

  // P54B T4: lidé bez vlastního modelu dostanou riggovanou postavu nejbližšího jména (`KIN`).
  it('dresses the people of off-topic sentences without changing the draft', () => {
    expect(heroChoice('investor', undefined, undefined, 'enemy').model).toBe('gen3d-investor');
    expect(heroChoice('angry boss', undefined, undefined, 'enemy')).toMatchObject({ model: 'rigged:q-businessman', level: 'class' });
    expect(sceneModelOf('my wife', true)).toBe('rigged:q-casual-woman');
    expect(sceneModelOf('toddler', true)).toBe('rigged:boy-a');
    expect(sceneModelOf('boss', false)).toBeUndefined();
    expect(modelOf('boss', true)).toBeUndefined();
  });
});
