import { expect, it } from 'vitest';
import { extractIntent } from '../extract';
import { essentialTriples } from '../contract';

it.each([
 ['hockey on a frozen lake against a team of penguins','penguin','rival','hero'],
 ['basketball against a team of bears','bear','rival','hero'],
 ['bike race where you throw bananas at rival riders','rider','rival','bike'],
 ['a boat racing rival ships','ship','rival','boat'],
 ['a train racing a plane across the desert','plane','rival','train'],
 ['a truck races a bus','bus','rival','truck'],
 ['a soldier sneaks behind enemy lines at night and plants a flag','soldier','interact','flag'],
 ['a knight plants a flag','knight','interact','flag'],
 ['punch to the beat and knock out the boxer','hero','duel','boxer'],
 ['punch and knock out a robot','hero','duel','robot'],
 ['a turtle swimming to the beach while dodging plastic bags and fishing nets','turtle','reach','beach'],
 ['a turtle swimming to the beach while dodging plastic bags and fishing nets','net','obstacle','turtle'],
 ['a seal swimming to the island while avoiding rocks and wooden crates','crate','obstacle','seal'],
 ['explore the jungle as a monkey but dont collect anything','monkey','roam',null],
 ['a bear explores the forest','bear','roam',null],
 ['dont stop shooting until every alien is gone','hero','shoot','alien'],
 ['dont stop shooting until every alien is gone','hero','defeat','alien'],
 ['keep shooting until all the robots are defeated','hero','shoot','robot'],
 ['a hedgehog rolling down a hill','hedgehog','ball',null],
 ['a panda rolling across a field','panda','ball',null],
 ['stack cups into a pyramid','hero','build','pyramid'],
 ['stack blocks into a tower','hero','build','tower'],
])('%s retains %s/%s/%s', (sentence, actor, verb, object) => {
 expect(essentialTriples(extractIntent(sentence!))).toContainEqual({actor,verb,object});
});
it('keeps maze movement and unsupported gardening distinct', () => {
 expect(essentialTriples(extractIntent('explore a labyrinth'))).toContainEqual({actor:'hero',verb:'walk',object:null});
 expect(essentialTriples(extractIntent('plant roses'))).not.toContainEqual(expect.objectContaining({verb:'interact'}));
 expect(essentialTriples(extractIntent('dont shoot until every alien is gone'))).not.toContainEqual(expect.objectContaining({verb:'defeat'}));
});
