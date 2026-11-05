/**
 * Riggované postavy T3 pro výchozí a kategorijní hrdiny a nepřátele (P54B T4).
 * Statická liška místo riggované vypadá na snímku „skoro dobře“ – stojí, jen se
 * nehýbe –, proto test drží id modelu: přesná identita z věty vyhrává (banán),
 * postava T3 se stejným jménem nahradí statický model (liška, kuchař), výchozí
 * id rolí `fox`, `explorer` a `robot` se kreslí riggovanou postavou a mřížka
 * (`modelOf`) kreslí dál svůj statický model.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpec } from '../../draft';
import { defaultHero } from '../../genre/roles';
import { KIN, RIGGED_ALIAS, enemyModel, heroChoice, heroModel, modelOf, riggedCharacter, sceneModelOf } from '../models';

const P54 = (id: string): string => `rigged:${id}`;

describe('rigged characters for heroes and enemies (P54B T4)', () => {
  it('a fox from the sentence is the rigged fox', () => {
    expect(heroModel(draftGameSpec('a fox runs', 1))).toBe(P54('q-fox'));
  });

  it('a chef from the sentence is a rigged chef, not the waiter', () => {
    const hero = heroModel(draftGameSpec('a chef flips pancakes', 1));
    expect(hero).toMatch(/^rigged:q-chef/);
    expect(riggedCharacter(hero)).toBeDefined();
  });

  it('exact identity wins: the banana stays the banana', () => {
    expect(heroModel(draftGameSpec('a banana runs from a monkey', 1))).toBe('gen3d-banana');
  });

  it('the default meadow hero is the rigged fox; the role label stays `fox`', () => {
    expect(defaultHero('meadow', 'runner', 'collect flowers')).toBe('fox');
    const choice = heroChoice(defaultHero('meadow', 'runner', 'collect flowers'), 'runner', 'runner');
    expect(choice).toMatchObject({ model: P54('q-fox'), level: 'identity' });
  });

  it('the default explorer and the default robot enemy are drawn rigged', () => {
    const explorer = heroChoice('', undefined, 'runner');
    expect(explorer.level).toBe('fallback');
    expect(riggedCharacter(explorer.model)?.id).toMatch(/^q-/);
    expect(heroChoice('', undefined, 'shooter', 'enemy')).toMatchObject({ model: P54('blocky-robot'), level: 'fallback' });
    expect(enemyModel(draftGameSpec('a robot collects batteries on Mars', 1))).toBe(P54('blocky-robot'));
  });

  it('a category picks the T3 character of the nearest name: animal, person, monster', () => {
    expect(heroChoice('a hyena', undefined, 'runner')).toMatchObject({ model: P54('q-wolf'), level: 'class' });
    expect(heroChoice('my dad', undefined, 'runner')).toMatchObject({ model: P54('q-casual-man'), level: 'class' });
    expect(heroChoice('the dentist', undefined, 'runner')).toMatchObject({ model: P54('q-doctor'), level: 'class' });
    expect(heroChoice('a monster', undefined, 'shooter', 'enemy').model).toBe(P54('q-big-orc'));
    // Scéna a řetěz věrnosti čtou kategorii stejně jako volba hrdiny.
    expect(sceneModelOf('a hyena', true)).toBe(P54('q-wolf'));
  });

  it('a static model with a more exact identity keeps the word (scientist, nurse, llama)', () => {
    expect(heroChoice('scientist', undefined, 'runner').model).toBe('gen3d-lab-scientist');
    expect(heroChoice('nurse', undefined, 'runner').model).toBe('gen3d-nurse');
    expect(heroChoice('llama', undefined, 'runner').model).toBe('cc0-llama');
    // P71E T2: drak je wyverna, ne létající drak s netopýří hlavou; malý drak Quaternius má svůj tag.
    expect(heroChoice('dragon', undefined, 'runner').model).toBe('gen3d-wyvern');
    expect(heroChoice('a dragon', undefined, 'shooter', 'enemy').model).toBe('gen3d-wyvern');
    expect(sceneModelOf('dragon', true)).toBe('gen3d-wyvern');
  });

  it('every kin and alias target is a character with clips', () => {
    for (const id of [...KIN.map(([kin]) => kin), ...Object.values(RIGGED_ALIAS)]) expect(riggedCharacter(P54(id)), id).toBeDefined();
  });

  it('the grid keeps drawing its static catalog model', () => {
    expect(modelOf('fox', true)).toBe('fox');
    expect(modelOf('badger', true)).toBe('fox');
    expect(modelOf('robot', true)).toBe('robot');
  });
});
