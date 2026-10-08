import { expect, it } from 'vitest';
import { extractIntent } from '../extract';
it.each([
 ['Make a game about a goat jumping on a snowy mountain.', 'goat','jump',null],
 ['Create an adventure about a tiger running through a forest.', 'tiger','run',null],
 ['Let an otter swim along the river.', 'otter','glide',null],
 ['Have a monkey hop through the jungle after a runaway chicken.', 'monkey','catch','chicken'],
 ['Make a race across the field with a horse trying to outrun zebras.', 'horse','run',null],
 ['I want a cave flight with a bat scooping up gems.', 'bat','collect','gem'],
 ['Put me behind the wheel of a van on the highway with coins to pick up.', 'van','collect','coin'],
 ['Send a fox on a forest stroll, with a basket of berries to gather.', 'fox','collect','berry'],
 ['A crab moves freely around the beach.', 'crab','roam',null],
 ['Let a rabbit have a soccer match in the stadium versus pigs.', 'rabbit','ball',null],
 ['Make a football game with a fox in a stadium.', 'fox','ball',null],
 ['A bear knits scarves inside a cabin.', 'bear','knit','scarf'],
 ['A dog repairs clocks in a shop.', 'dog','repair','clock'],
 ['A mouse repairs a clock outside a cottage.', 'mouse','repair','clock'],
 ['A knight runs to the gate.', 'knight','reach','gate'],
 ['A dog plays football while apples fall onto the field.', 'apple','hazard','dog'],
 ['A helicopter flies down the valley while planes race it to the finish.', 'plane','rival','helicopter'],
])('preserves argument structure: %s', (sentence,actor,verb,object) => {
 expect(extractIntent(sentence as string).items).toContainEqual(expect.objectContaining({actor,verb,object,essential:true}));
});
it.each([
 ['a robot roams in an abandoned observatory','observatory'],
 ['a cat walks inside the atrium','atrium'],
 ['a fish swims underwater down the river','river'],
 ['a fox runs through the valley','valley'],
 ['a goat jumps up the cliff','cliff'],
 ['a robot roams the station','station'],
 ['a robot roams an empty hangar','hangar'],
])('preserves named location: %s', (sentence,setting)=>expect(extractIntent(sentence).setting).toBe(setting));

// Independent substitutions exercise the grammar without using evaluation labels.
it.each([
 ['Let a wizard walk through a courtyard.', 'wizard', 'walk', null],
 ['Have a puppy jump after a runaway squirrel.', 'puppy', 'catch', 'squirrel'],
 ['Create a story about a lion running across a plain.', 'lion', 'run', null],
 ['Give me a game featuring a frog jumping over logs.', 'frog', 'jump', null],
 ['A beach stroll with a tiger collecting shells.', 'tiger', 'collect', 'shell'],
 ['Put me behind the wheel of a tractor with stars to gather.', 'tractor', 'collect', 'star'],
 ['Send a rabbit on a meadow stroll, with a box of carrots to pick up.', 'rabbit', 'collect', 'carrot'],
 ['A cat roams while pears fall around it.', 'pear', 'hazard', 'cat'],
 ['A turtle walks while coconuts drop from above.', 'coconut', 'hazard', 'turtle'],
 ['A truck drives while jeeps race it.', 'jeep', 'rival', 'truck'],
 ['A bear knits blankets outside a hut.', 'bear', 'knit', 'blanket'],
])('generalizes clause structure: %s', (sentence, actor, verb, object) => {
 expect(extractIntent(sentence as string).items).toContainEqual(expect.objectContaining({actor,verb,object,essential:true}));
});
it.each(['a dog falls asleep', 'a robot falls apart', 'a cat runs without falling rocks'])('does not invent an incoming hazard: %s', sentence => {
 expect(extractIntent(sentence).items.some(item=>item.verb==='hazard')).toBe(false);
});
it('keeps direct flight/swim/glide under the established glide contract', () => {
 for (const sentence of ['an owl flies over hills', 'a plane flies through clouds', 'a fish swims in a lake', 'a bird glides above trees']) {
  expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({axis:'move',verb:'glide'}));
 }
});

it.each([
 ['a goat jumps on a snowy mountain', 'mountain'],
 ['a fox runs through a frozen valley', 'valley'],
 ['a robot walks inside a medieval warehouse', 'warehouse'],
])('retains the place noun after a setting adjective: %s', (sentence, setting) => {
 expect(extractIntent(sentence).setting).toBe(setting);
});
it.each(['an owl dodges falling branches', 'a fox avoids falling coconuts'])('keeps falling adjective hazards separate from avoidance verbs: %s', sentence => {
 const items = extractIntent(sentence).items;
 const object = sentence.includes('branches') ? 'branch' : 'coconut';
 expect(items).toContainEqual(expect.objectContaining({axis:'threat',verb:'hazard',actor:object}));
 expect(items.some(item=>item.axis==='threat' && /^(?:dodge|avoid)$/.test(item.actor))).toBe(false);
});
it('does not create a rival named after the target pronoun', () => {
 const items=extractIntent('a helicopter flies while planes race it to the finish').items;
 expect(items).toContainEqual(expect.objectContaining({verb:'rival',actor:'plane',object:'helicopter'}));
 expect(items.some(item=>item.verb==='rival' && /^(?:it|he|she|they|them|you)$/.test(item.actor))).toBe(false);
});

it.each(['machine gun', 'laser gun', 'cannon'])('keeps the pilot as actor with a %s', weapon => {
 const intent=extractIntent(`a helicopter race with a ${weapon}`);
 expect(intent.hero).toBe('helicopter');
 expect(intent.items).toContainEqual(expect.objectContaining({actor:'helicopter',verb:'shoot'}));
 expect(intent.items.some(item=>item.actor==='machine' || item.actor==='gun' || item.actor==='cannon')).toBe(false);
});
it.each([
 ['a pirate duels a captain and then escapes the island', 'island'],
 ['escape the abandoned laboratory', 'laboratory'],
 ['escape the ancient ruin', 'ruin'],
 ['escape a fortified bunker', 'bunker'],
 ['escape the underground lab', 'lab'],
])('preserves the direct escape place: %s', (sentence, setting) => {
 expect(extractIntent(sentence).setting).toBe(setting);
});
it('does not turn an escaped opponent into scenery', () => {
 expect(extractIntent('a rabbit escapes a fox').setting).toBeNull();
});
