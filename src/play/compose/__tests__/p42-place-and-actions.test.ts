import { beforeAll, expect, it } from 'vitest';
import { loadRapier } from '../../arcade/physics/world';
import { draftGameSpecWithMeta } from '../../draft';
import { matchesWitness } from '../../arcade/witness';

beforeAll(loadRapier);
it.each([
  'a robot roams the factory; keep shooting drones, but never collect batteries',
  'a fox explores a garden without collecting flowers',
])('%s does not publish a collection objective after collection was forbidden', (sentence) => {
  const draft = draftGameSpecWithMeta(sentence, 1);
  expect(draft.spec.objective.kind).not.toBe('collect');
  expect(draft.spec.roles.some(role => role.kind === 'collectible')).toBe(false);
  expect(draft.composition?.witnesses.some(w => w.verb === 'collect')).toBe(false);
});

it.each([
  ['a mouse sneaks past guards in a laboratory and frees a rabbit', 'laboratory'],
  ['a wizard shoots skeletons in a dungeon while dodging their fireballs', 'dungeon'],
  ['a pirate duels a captain and then escapes the island', 'island'],
  ['explore an island as a pirate but do not collect treasure', 'island'],
  ['escape the abandoned laboratory', 'laboratory'],
  ['golf on a snowy mountain', 'mountain'],
  ['a robot runs inside a warehouse', 'warehouse'],
  ['a fox jumps across an icy lake', 'lake'],
  ['a robot roams the station shooting drones and collecting batteries', 'station'],
  ['a cat roams the warehouse, chases rats and collects stars', 'warehouse'],
  ['a robot roams an empty hangar', 'hangar'],
  ['a parrot flies through the jungle canopy', 'jungle'],
  ['send a fox on a forest stroll, with a basket of berries to gather', 'forest'],
  ['a fox walks through an observatory', 'observatory'],
  ['a robot runs inside an atrium', 'atrium'],
])('%s keeps the named location rather than its scenery category', (sentence, head) => {
  const draft = draftGameSpecWithMeta(sentence, 1);
  expect(draft.spec.theme.setting).toMatch(new RegExp(`\\b${head}\\b`));
});

it.each([
  ['a knight fights goblins in the forest and gathers their coins', 'fight', 'goblin', 'collect', 'coin'],
  ['a samurai fights ninjas and then delivers a scroll to the temple', 'fight', 'ninja', 'deliver', 'scroll'],
])('%s attaches combat to movement that also supports its other task', (sentence, first, foe, second, object) => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const draft = draftGameSpecWithMeta(sentence, seed);
    expect(draft.composition?.witnesses).toContainEqual(expect.objectContaining({ verb: first, object: expect.objectContaining({ label: foe }) }));
    expect(draft.composition?.witnesses.some(w => matchesWitness({ actor: 'hero', verb: second, object }, w)), JSON.stringify({ seed, unmet: draft.composition?.unmet })).toBe(true);
  }
}, 120000);
