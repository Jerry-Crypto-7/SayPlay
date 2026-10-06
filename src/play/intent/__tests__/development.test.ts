import { describe, expect, it } from 'vitest';

import { extractIntent } from '../extract';

describe('development-corpus extraction regressions (P41 T10)', () => {
  it.each([
    ['race cars with guns', 'car', 'race', null],
    ['shoot n race cars in the desert', 'car', 'shoot', null],
    ['race a red sports car around a track', 'car', 'drive', null],
    ['shoot your rivals while you race your car', 'car', 'shoot', 'rival'],
    ['a car race where you can shoot the other cars', 'car', 'rival', 'car'],
    ['a dragon flying through clouds collecting gems', 'dragon', 'glide', null],
    ['a fish swimming and avoiding sharks', 'shark', 'hazard', 'fish'],
    ['a ninja sneaks past guards and throws stars at them', 'ninja', 'throw', 'guard'],
    ['throw snowballs at snowmen', 'hero', 'throw', 'snowman'],
    ['a ship firing cannons at other ships', 'ship', 'shoot', 'ship'],
    ['a snowmobile racing and dodging trees', 'snowmobile', 'drive', null],
    ['swim as a dolphin and collect stars', 'dolphin', 'collect', 'star'],
    ['jump between lily pads as a frog and eat flies', 'frog', 'jump', null],
    ['froggy platformer: hop and munch the flys', 'frog', 'collect', 'fly'],
    ['sneak by the guards as a ninja and grab treasure', 'guard', 'guard', 'ninja'],
    ['ninja stealth game, steal treasure without the guards spotting you', 'guard', 'guard', 'ninja'],
    ['be a ninja, slip past guards and take the treasure', 'ninja', 'collect', 'treasure'],
    ['a bird flapping between pipes', 'pipe', 'obstacle', 'bird'],
    ['blast asteroids from a spaceship and stay alive', 'spaceship', 'shoot', 'asteroid'],
    ['zombies are chasing you, keep running to stay alive', 'hero', 'run', null],
    ['escape the castle without fighting the guards', 'guard', 'guard', 'hero'],
    ['drive a car and knit a sweater at the same time', 'car', 'knit', 'sweater'],
    ['a cat that cooks spaghetti', 'cat', 'cook', 'spaghetti'],
    ['write a poem about the sea', 'hero', 'write', 'poem'],
    ['grow tomatoes in a greenhouse', 'hero', 'grow', 'tomato'],
    ['read bedtime stories to a ghost', 'hero', 'read', 'story'],
    ['fold paper cranes', 'hero', 'fold', 'crane'],
    ['meditate on a mountain at sunrise', 'hero', 'meditate', null],
    ['draw a map of a jungle', 'hero', 'draw', 'map'],
  ])('%s preserves %s ? %s ? %s', (sentence, actor, verb, object) => {
    expect(extractIntent(sentence as string).items).toContainEqual(expect.objectContaining({ actor, verb, object, essential: true }));
  });

  it.each([
    ['a sword game without duels, you fight waves of skeletons', 'hero'],
    ['golf mini game', 'hero'],
  ])('does not promote equipment or a game adjective to the hero: %s', (sentence, actor) => {
    expect(extractIntent(sentence).items.every(item => item.actor === actor)).toBe(true);
  });

  it('retains incoming threat identity when the imperative returns to the player', () => {
    const items = extractIntent('a bear chases you, run and survive').items;
    expect(items).toContainEqual(expect.objectContaining({ actor: 'bear', verb: 'chaser', object: 'hero' }));
    expect(items).toContainEqual(expect.objectContaining({ actor: 'hero', verb: 'survive', object: null }));
  });

  it('keeps a subway as the place being escaped, not a pursuer', () => {
    const items = extractIntent('Escape the flooded subway before the security drone catches you.').items;
    expect(items).toContainEqual(expect.objectContaining({ actor: 'hero', verb: 'escape', object: 'subway' }));
    expect(items.filter(item => item.axis === 'threat')).toEqual([
      expect.objectContaining({ actor: 'drone', verb: 'chaser', object: 'hero' }),
    ]);
  });

  it('does not infer a second hazard mechanic just from the species of a pursuer', () => {
    const items = extractIntent('a shark chases you').items;
    expect(items.map(item => item.verb)).toEqual(['chaser', 'escape']);
  });
});
