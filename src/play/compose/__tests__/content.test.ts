import { loadRapier } from '@/play/arcade/physics/world';
import { beforeAll, describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '../../draft';
import { extractIntent } from '../../intent/extract';

const ASTRONAUT = 'I want a game where a tiny astronaut repairs a broken spaceship by collecting glowing crystals on an icy moon while avoiding cracks in the ice and a grumpy alien that throws snowballs at him';

describe('P41 composition preserves named content and fallback intent', () => {
  it('shares the established absurd-transfer ordering only for an unrecognized game action', () => {
    const draft = draftGameSpecWithMeta('a long queue at the pharmacy on a friday afternoon', 1);
    expect(draft.genre).toMatchObject({ genre: 'arena', mode: 'escape', cast: [{ label: 'long queue', does: 'chase_me' }] });
    expect(draft.spec.tutorial?.goalLine).toBe('Dodge the long queues!');
  });

  it('a playable absurd transfer does not certify an unsupported requested action', () => {
    const draft = draftGameSpecWithMeta('fold a mountain of clean towels on the couch', 1);
    expect(draft.genre?.cast).toContainEqual(expect.objectContaining({ label: 'clean towel' }));
    expect(draft.composition?.unmet).toContainEqual(expect.objectContaining({ verb: 'fold' }));
  });

  it('does not replace a named protagonist with a later subordinate actor', () => {
    const draft = draftGameSpecWithMeta(ASTRONAUT, 1);
    expect(draft.genre?.hero).toBe('astronaut');
    expect(draft.spec.roles).toContainEqual(expect.objectContaining({ kind: 'player', label: 'astronaut' }));
    expect(draft.composition?.unmet.length).toBeGreaterThan(0);
  });

  it('keeps an explicit setting even when a different live recipe supplies the game', () => {
    const draft = draftGameSpecWithMeta('walk my dog along the beach while eating an ice cream', 1);
    expect(draft.genre?.setting).toBe('beach');
    expect(draft.spec.theme.setting).toBe('beach');
  });

  it('keeps named cargo visible and proves its actual delivery', () => {
    const draft = draftGameSpecWithMeta('A pizza delivery scooter races through traffic to deliver before the pizza gets cold', 1);
    expect(draft.spec.roles).toContainEqual(expect.objectContaining({ label: 'pizza' }));
    expect(draft.composition?.witnesses).toContainEqual(expect.objectContaining({ verb: 'deliver', object: expect.objectContaining({ label: 'pizza' }), evidence: 'carried-to-destination' }));
  });

  it('keeps an explicit throwing target separate from basketball ammunition', () => {
    const sentence = 'throw a basketball into a hoop from crazy angles';
    const intent = extractIntent(sentence);
    expect(intent.items).toContainEqual(expect.objectContaining({ verb: 'throw', object: 'hoop', essential: true }));
    const draft = draftGameSpecWithMeta(sentence, 1);
    expect(draft.genre?.cast?.find(item => item.does === 'throw_at')?.label).toBe('hoop');
    expect(draft.genre?.cast).toContainEqual(expect.objectContaining({ label: 'basketball', does: 'scenery', verb: 'throw' }));
  });

  it('does not let fallback ordering override a requested movement mechanic', () => {
    const draft = draftGameSpecWithMeta('game in a car with shooting and racing', 1);
    expect(draft.composition?.recipe.move).toBe('drive');
  });

  it('does not name a command word as the protagonist of an explanation', () => {
    const draft = draftGameSpecWithMeta('explain to my parents why i dropped out of college', 1);
    expect(extractIntent(draft.intent!.sentence).hero).not.toBe('explain');
    expect(draft.genre?.hero).not.toBe('explain');
  });
});


describe('named surfaces and background activities', () => {
  it.each([
    ["a wizard's apprentice sweeps the dusty floor of a magic tower", 'dusty floor', 'sweep'],
    ['a walrus mops a slippery ice rink before the hockey game', 'slippery ice rink', 'mop'],
  ])('%s preserves its named surface without certifying cleaning', (sentence, label, verb) => {
    const draft = draftGameSpecWithMeta(sentence, 1);
    expect(draft.genre).toMatchObject({ genre: 'arena', mode: 'collect', heroAction: 'sweep' });
    expect(draft.genre?.cast?.find(item => item.does === 'collect')?.label).toBe(label);
    expect(draft.composition?.unmet).toContainEqual(expect.objectContaining({ verb }));
  });

  it('keeps digging explicit and unmet while a collecting recipe plays the search', () => {
    const draft = draftGameSpecWithMeta('a mole digs tunnels under the farm looking for lost carrots', 1);
    expect(draft.genre?.cast).toContainEqual(expect.objectContaining({ label: 'carrot', does: 'collect' }));
    expect(draft.composition?.unmet).toContainEqual({ actor: 'mole', verb: 'dig', object: 'tunnel' });
  });

  it('a scheduled sports event does not request sports gameplay', () => {
    const intent = extractIntent('a walrus mops a slippery ice rink before the hockey game');
    expect(intent.items.some(item => item.verb === 'ball' || item.verb === 'score')).toBe(false);
    expect(intent.items).toContainEqual(expect.objectContaining({ actor: 'walrus', verb: 'mop', object: 'rink', essential: true }));
  });

  it.each(['a two-minute chase', 'a high-speed chase', 'a minute chase'])('does not turn duration or speed into the pursuer: %s', description => {
    const sentence = `A city with one million simulated citizens and ${description}.`;
    expect(extractIntent(sentence).items.some(item => item.verb === 'chaser' && /minute|speed/.test(item.actor))).toBe(false);
  });

  it.each(['top-down', 'side-scrolling', 'first-person', 'twin-stick'])('does not invent a %s shooting target from a style adjective', style => {
    const sentence = `a ${style} shooter`;
    expect(extractIntent(sentence).items).toContainEqual(expect.objectContaining({ verb: 'shoot', object: null }));
    expect(draftGameSpecWithMeta(sentence, 1).genre?.cast?.some(item => item.label === style)).toBe(false);
  });
});


describe('defense is distinct from surviving', () => {
  it.each(['defend the castle from waves of goblins', 'protect the tower from monsters'])('%s remains explicit and unmet', sentence => {
    const verb = sentence.split(' ')[0];
    const intent = extractIntent(sentence);
    expect(intent.items).toContainEqual(expect.objectContaining({ axis: 'unknown', verb, essential: true }));
    expect(intent.items.some(item => item.verb === 'survive' && item.essential)).toBe(false);
    expect(draftGameSpecWithMeta(sentence, 1).composition?.unmet).toContainEqual(expect.objectContaining({ verb }));
  });
});


it.each([
 ['a chicken crossing an endless road like crossy road', 'traffic'],
 ['red light green light like squid game', 'watcher'],
 ['five nights at freddys but in a school', 'watcher'],
 ['horror game where a creepy doll moves when u dont look', 'watcher'],
])('does not inject an unnamed inferred participant: %s', (sentence, label) => {
 const draft = draftGameSpecWithMeta(sentence, 1);
 expect(draft.genre?.cast?.some(item => item.label === label)).toBe(false);
 expect(draft.composition?.unmet).toContainEqual(expect.objectContaining({ actor: label }));
});

it('free throws keep the basketball as ammunition, not as their target', () => {
 const draft = draftGameSpecWithMeta('basketball free throws', 1);
 expect(draft.genre?.cast).toContainEqual(expect.objectContaining({ label: 'basketball', does: 'scenery', verb: 'throw' }));
 expect(draft.genre?.cast?.some(item => item.label === 'ball' && item.does === 'throw_at')).toBe(false);
});


it('fills missing collectible slots from the actual setting', () => {
 const draft=draftGameSpecWithMeta('treasure hunt on a tropical island');
 expect(draft.genre?.cast).toContainEqual(expect.objectContaining({label:'shell',does:'collect'}));
 expect(draft.genre?.cast?.some(item=>item.label==='coin')).toBe(false);
});
it('keeps a subordinate alien throwing at the astronaut separate from avoided cracks',()=>{
 const intent=extractIntent(ASTRONAUT);
 expect(intent.hero).toBe('astronaut');
 expect(intent.items).toContainEqual(expect.objectContaining({actor:'alien',verb:'throw',object:'astronaut'}));
 expect(draftGameSpecWithMeta(ASTRONAUT).genre?.cast).toContainEqual(expect.objectContaining({label:'crack',does:'avoid'}));
});
it('keeps a defensive throwing opponent and its ammunition while admitting defense',()=>{
 const draft=draftGameSpecWithMeta('defend a castle from dragons by throwing snowballs');
 expect(draft.genre?.cast).toContainEqual(expect.objectContaining({label:'dragon',does:'throw_at'}));
 expect(draft.genre?.cast).toContainEqual(expect.objectContaining({label:'snowball',does:'scenery',verb:'throw'}));
 expect(draft.composition?.unmet).toContainEqual(expect.objectContaining({verb:'defend'}));
});

// Composition now executes physical ball witnesses even in synchronous draft tests.
beforeAll(async () => { await loadRapier(); });
