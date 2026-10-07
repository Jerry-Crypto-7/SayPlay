import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { matchesWitness } from '../../arcade/witness';
import { draftGameSpecWithMeta } from '../../draft';

beforeAll(loadRapier);

it.each([
  ['a jeep drives through a canyon firing rockets at drones', 'jeep', 'rocket', 'drone'],
  ['a submarine swims through a reef, firing torpedoes and delivering medicine', 'submarine', 'torpedo', null],
  ['a fox runs through a forest and fires arrows at skeletons', 'fox', 'arrow', 'skeleton'],
  ['a wizard fires fireballs at ogres in a cave', 'wizard', 'fireball', 'ogre'],
] as const)('%s gives ammunition and its target different physical roles', (sentence, actor, ammo, target) => {
  for (const seed of [1, 5]) {
    const draft = draftGameSpecWithMeta(sentence, seed);
    const witnesses = draft.composition?.witnesses ?? [];
    const shot = witnesses.find(w => matchesWitness({ actor, verb: 'shoot', object: ammo }, w));
    expect(shot, JSON.stringify({ seed, unmet: draft.composition?.unmet })).toBeDefined();
    expect(shot?.object?.roleKind).toBe('item');
    expect(shot?.object?.roleId).toBe('ammunition');
    expect(shot?.run).toBe('winner');
    if (target !== null) expect(witnesses.some(w => matchesWitness({ actor, verb: 'shoot', object: target }, w))).toBe(true);
    expect(draft.spec.roles.filter(role => ['patrol', 'hazard', 'target'].includes(role.kind)).map(role => role.label)).not.toContain(ammo);
  }
}, 120000);
