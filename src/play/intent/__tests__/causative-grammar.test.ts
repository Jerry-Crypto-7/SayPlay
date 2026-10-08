import { expect, it } from 'vitest';
import { extractIntent } from '../extract';
import { singular } from '../../draft/lexicon';

it.each([
 ['Give me a ferret running in an orchard, collecting apples along the way.', 'ferret', 'run', null],
 ['Keep the dolphin swimming in the harbor, but do not catch fish.', 'dolphin', 'glide', null],
 ['Give me a badger jumping through a grove.', 'badger', 'jump', null],
 ['Keep a lizard walking around a ruin.', 'lizard', 'walk', null],
 ['Make a penguin iron shirts in a cabin.', 'penguin', 'iron', 'shirt'],
 ['Let a mechanic lubricate gears in a garage.', 'mechanic', 'lubricate', 'gear'],
 ['Make a robot polish mirrors in a workshop.', 'robot', 'polish', 'mirror'],
 ['Have a tailor embroider a scarf.', 'tailor', 'embroider', 'scarf'],
 ['A walrus tunes violins in a theater.', 'walrus', 'tune', 'violin'],
 ['An octopus varnishes shelves.', 'octopus', 'varnish', 'shelf'],
 ['In the bay, shrimp are what the swimming seahorse must catch.', 'seahorse', 'catch', 'shrimp'],
 ['Pearls are what the swimming seal should collect.', 'seal', 'collect', 'pearl'],
 ['At the station, drones are what the walking robot must shoot.', 'robot', 'shoot', 'drone'],
 ["A crane flies over a swamp; don't collect flowers, but do catch mosquitoes.", 'crane', 'catch', 'mosquito'],
 ['A submarine swims through a reef, firing torpedoes and delivering medicine.', 'submarine', 'shoot', 'torpedo'],
])('extracts the grammatical actor and argument: %s', (sentence, actor, verb, object) => {
 const intent=extractIntent(sentence as string);
 expect(intent.hero).toBe(actor);
 expect(intent.items).toContainEqual(expect.objectContaining({actor,verb,object,essential:true}));
});
it('retains the fronted clause movement and original sentence', () => {
 const sentence='In the bay, shrimp are what the swimming seahorse must catch.';
 const intent=extractIntent(sentence);
 expect(intent.sentence).toBe(sentence);
 expect(intent.setting).toBe('bay');
 expect(intent.items).toContainEqual(expect.objectContaining({actor:'seahorse',verb:'glide'}));
});
it('preserves independent negation with emphatic do', () => {
 const intent=extractIntent('a bat flies; never collect flowers but do catch mosquitoes');
 expect(intent.negated).toContain('collect');
 expect(intent.items.some(item=>item.verb==='collect')).toBe(false);
 expect(intent.items).toContainEqual(expect.objectContaining({actor:'bat',verb:'catch',object:'mosquito'}));
});
it.each(['a fox explores a ruin freely', 'a cat roams a warehouse quietly'])('keeps adverbs outside the place noun: %s', sentence => {
 expect(extractIntent(sentence).setting).toBe(sentence.includes('ruin') ? 'ruin' : 'warehouse');
});
it.each(['make a snowy mountain', 'let a robot walk through a town', 'keep shooting drones'])('does not invent unknown verbs for modifiers or known commands: %s', sentence => {
 expect(extractIntent(sentence).items.some(item=>item.axis==='unknown')).toBe(false);
});
it.each([['torpedoes','torpedo'],['mosquitoes','mosquito'],['heroes','hero'],['shoes','shoe'],['canoes','canoe']])('singularizes %s without losing a noun-final e', (plural, noun)=> {
 expect(singular(plural)).toBe(noun);
});
it('retains a finite unknown intransitive action without a fabricated object', () => {
 expect(extractIntent('a fox hibernates in a cave').items).toContainEqual(expect.objectContaining({axis:'unknown',actor:'fox',verb:'hibernate',object:null}));
});
it('does not emit a prohibited unknown action', () => {
 const intent=extractIntent('let a mechanic lubricate gears but do not embroider scarves');
 expect(intent.items.some(item=>item.verb==='embroider')).toBe(false);
});
