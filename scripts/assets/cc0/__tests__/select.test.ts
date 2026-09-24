import { describe, expect, it } from 'vitest';

import { findByLabel, modelTokens, selectBroad, sentenceNouns, selectModels } from '../select.mjs';

const MODELS = [
  { pack: 'kaykit-halloween-bits', file: 'Assets/gltf/bat.gltf' },
  { pack: 'kenney-minigolf-kit', file: 'Models/GLB format/baseball-bat.glb' },
  { pack: 'kenney-factory-kit', file: 'Models/GLB format/crane.glb' },
  { pack: 'kenney-nature-kit', file: 'Models/GLB format/bird-crane.glb' },
  { pack: 'kenney-furniture-kit', file: 'Models/GLB format/computerMouse.glb' },
  { pack: 'kenney-cube-pets', file: 'Models/GLB format/animal-mouse.glb' },
  { pack: 'kenney-cube-pets', file: 'Models/GLB format/animal-seal.glb' },
  { pack: 'kenney-holiday-kit', file: 'Models/GLB format/bow-ribbon.glb' },
  { pack: 'kaykit-dungeon-remastered', file: 'Assets/gltf/bow_wooden.gltf' },
  { pack: 'kenney-nature-kit', file: 'Models/GLB format/tree-trunk.glb' },
  { pack: 'kenney-car-kit', file: 'Models/GLB format/luggage-trunk.glb' },
  { pack: 'kaykit-restaurant-bits', file: 'Assets/gltf/pitcher.gltf' },
  { pack: 'kenney-cube-pets', file: 'Models/GLB format/animal-mole.glb' },
  { pack: 'kenney-platformer-kit', file: 'Models/GLB format/star.glb' },
  { pack: 'kenney-food-kit', file: 'Models/GLB format/banana.glb' },
  { pack: 'kenney-food-kit', file: 'Models/GLB format/banana-half.glb' },
  { pack: 'kaykit-dungeon-remastered', file: 'Assets/gltf/key.gltf.glb' },
  { pack: 'kenney-furniture-kit', file: 'Models/GLB format/cardboardBoxClosed.glb' },
];

const pick = (text: string, known: readonly string[] = []) => selectModels({ sentences: [{ id: 's', text }], known: new Set(known), models: MODELS });

describe('modelTokens', () => {
  it('splits file names on dashes, underscores and camel case and drops variant letters', () => {
    expect(modelTokens('Models/GLB format/computerMouse.glb')).toEqual(['computer', 'mouse']);
    expect(modelTokens('Assets/gltf/key.gltf.glb')).toEqual(['key']);
    expect(modelTokens('Assets/gltf/Box_A.gltf')).toEqual(['box']);
    expect(modelTokens('Models/GLB format/astronautA.glb')).toEqual(['astronaut']);
  });
});

describe('sentenceNouns', () => {
  it('reads role nouns with the draft lexicon, singular heads only', () => {
    expect(sentenceNouns('A knight must collect three keys in a haunted castle while dodging ghosts.').sort()).toEqual(['ghost', 'key', 'knight']);
  });
});

describe('selectModels – ambiguous words follow the sentence or stay unpaired', () => {
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    ['A vampire bat chases you through a haunted cave', 'bat', 'kaykit-halloween-bits/Assets/gltf/bat.gltf'],
    ['I am a baseball bat that must hit the balls', 'bat', 'kenney-minigolf-kit/Models/GLB format/baseball-bat.glb'],
    ['A crane lifts crates at the construction site while you collect cranes', 'crane', 'kenney-factory-kit/Models/GLB format/crane.glb'],
    ['A crane bird flies over a pond and a crane chases you', 'crane', 'kenney-nature-kit/Models/GLB format/bird-crane.glb'],
    ['A mouse runs from a cat in the kitchen', 'mouse', 'kenney-cube-pets/Models/GLB format/animal-mouse.glb'],
    ['A seal chases you across the glacier ice', 'seal', 'kenney-cube-pets/Models/GLB format/animal-seal.glb'],
    ['collect the bows in a gift shop for the christmas present wrapping', 'bow', 'kenney-holiday-kit/Models/GLB format/bow-ribbon.glb'],
    ['An archer shoots arrows at goblins and must collect bows', 'bow', 'kaykit-dungeon-remastered/Assets/gltf/bow_wooden.gltf'],
  ];
  for (const [text, noun, expected] of cases) {
    it(`${noun}: ${text}`, () => {
      const result = pick(text);
      const hit = result.selected.find((entry: { noun: string }) => entry.noun === noun);
      expect(hit ? `${hit.pack}/${hit.file}` : null).toBe(expected);
    });
  }

  const unresolved: ReadonlyArray<readonly [string, string]> = [
    ['collect the bats', 'bat'],
    ['dodge the cranes', 'crane'],
    ['grab the trunk', 'trunk'],
    ['a pitcher chases you', 'pitcher'],
    ['avoid the moles', 'mole'],
    ['I am a seal and must collect every seal', 'seal'],
  ];
  for (const [text, noun] of unresolved) {
    it(`${noun} without context stays ambiguous: ${text}`, () => {
      const result = pick(text);
      expect(result.selected.some((entry: { noun: string }) => entry.noun === noun)).toBe(false);
      expect(result.ambiguous.map((entry: { noun: string }) => entry.noun)).toContain(noun);
    });
  }
});

describe('selectModels', () => {
  it('prefers the plain model over a part or a variant', () => {
    const hit = pick('a banana runs from a monkey').selected.find((entry: { noun: string }) => entry.noun === 'banana');
    expect(hit?.file).toBe('Models/GLB format/banana.glb');
  });

  it('keeps a compound noun whole instead of pairing its head with a different thing', () => {
    const models = [
      ...MODELS,
      { pack: 'kenney-food-kit', file: 'Models/GLB format/corn-dog.glb' },
      { pack: 'kenney-cube-pets', file: 'Models/GLB format/animal-dog.glb' },
      { pack: 'kenney-food-kit', file: 'Models/GLB format/can.glb' },
      { pack: 'kenney-pirate-kit', file: 'Models/GLB format/hole.glb' },
      { pack: 'kenney-factory-kit', file: 'Models/GLB format/warning-traffic.glb' },
    ];
    const run = (text: string) => selectModels({ sentences: [{ id: 's', text }], known: new Set(), models }).selected.map((entry: { noun: string; file: string }) => `${entry.noun}=${entry.file.split('/').pop()}`);
    expect(run('a black hole that swallows a city')).toEqual([]);
    expect(run('skateboard down a hill avoiding trash cans')).toEqual([]);
    expect(run('A corgi runs through a park')).toEqual(['corgi=animal-dog.glb']);
    expect(run('A scooter races through traffic')).not.toContain('traffic=warning-traffic.glb');
  });

  it('skips nouns the catalog already carries as an exact tag', () => {
    const result = pick('A knight must collect three keys', ['key']);
    expect(result.selected.map((entry: { noun: string }) => entry.noun)).not.toContain('key');
    expect(result.unmatched.map((entry: { noun: string }) => entry.noun)).toContain('knight');
  });

  it('records which sentences asked for a noun and caps the selection', () => {
    const result = selectModels({
      sentences: [{ id: 'a', text: 'collect bananas' }, { id: 'b', text: 'grab the banana' }],
      known: new Set(),
      models: MODELS,
      max: 1,
    });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].sentences).toEqual(['a', 'b']);
  });
});

describe('selectBroad – by category from the whole cache', () => {
  const BROAD = [
    // Barevné a velikostní varianty téže postavy a téhož zvířete.
    { pack: 'kenney-mini-characters', file: 'Models/GLB format/character-female-a.glb' },
    { pack: 'kenney-mini-characters', file: 'Models/GLB format/character-female-b.glb' },
    { pack: 'kenney-mini-characters', file: 'Models/GLB format/character-female-red.glb' },
    { pack: 'quaternius-farm-animals', file: 'OBJ/Cow.glb' },
    { pack: 'quaternius-farm-animals', file: 'OBJ/Cow_Brown.glb' },
    { pack: 'kenney-nature-kit', file: 'Models/GLB format/rock_largeA.glb' },
    { pack: 'kenney-nature-kit', file: 'Models/GLB format/rock_smallB.glb' },
    // Dílky scén a rozhraní.
    { pack: 'kenney-castle-kit', file: 'Models/GLB format/floor-wood.glb' },
    { pack: 'kenney-castle-kit', file: 'Models/GLB format/wall-corner.glb' },
    { pack: 'kenney-city-kit-suburban', file: 'Models/GLB format/road-straight.glb' },
    { pack: 'kaykit-dungeon-remastered', file: 'Assets/gltf/tile_grass.gltf' },
    { pack: 'kenney-platformer-kit', file: 'Models/GLB format/block-grass-large.glb' },
    { pack: 'kenney-blaster-kit', file: 'Models/GLB format/ui-button.glb' },
    // Kategorie ze složky a balíku, ne jen ze jména.
    { pack: 'quaternius-ultimate-animated-animals', file: 'glTF/Fox.gltf' },
    { pack: 'quaternius-toon-shooter-kit', file: 'Guns/glTF/Pistol.gltf' },
    { pack: 'quaternius-ultimate-monsters', file: 'Blob/glTF/Mushnub.gltf' },
    { pack: 'quaternius-ultimate-food', file: 'OBJ/Pizza.glb' },
    { pack: 'kenney-city-kit-suburban', file: 'Models/GLB format/trash-can.glb' },
    { pack: 'quaternius-cars', file: 'OBJ/Taxi.glb' },
    { pack: 'kenney-furniture-kit', file: 'Models/GLB format/chairCushion.glb' },
    { pack: 'kenney-platformer-kit', file: 'Models/GLB format/coin-gold.glb' },
  ];
  const run = (known: string[] = [], max?: number) => selectBroad({ models: BROAD, known: new Set(known), ...(max ? { max } : {}) });
  const files = (result: { selected: Array<{ file: string }> }) => result.selected.map((entry) => entry.file.split('/').pop());

  it('keeps one representative per shape, not every colour or size variant', () => {
    const result = run();
    expect(files(result).filter((file) => file!.startsWith('character-female'))).toHaveLength(1);
    expect(files(result).filter((file) => file!.startsWith('Cow'))).toEqual(['Cow.glb']);
    expect(files(result).filter((file) => file!.startsWith('rock'))).toHaveLength(1);
  });

  it('drops floors, walls, tiles, roads, blocks and interface pieces', () => {
    const dropped = ['floor-wood.glb', 'wall-corner.glb', 'road-straight.glb', 'tile_grass.gltf', 'block-grass-large.glb', 'ui-button.glb'];
    expect(files(run()).filter((file) => dropped.includes(file!))).toEqual([]);
  });

  it('files every model under a category read from its name, folder or pack', () => {
    const category = Object.fromEntries(run().selected.map((entry: { file: string; category: string }) => [entry.file.split('/').pop(), entry.category]));
    expect(category).toMatchObject({
      'Fox.gltf': 'animal', 'Pistol.gltf': 'weapon', 'Mushnub.gltf': 'monster', 'Pizza.glb': 'food', 'trash-can.glb': 'obstacle',
      'Taxi.glb': 'vehicle', 'chairCushion.glb': 'furniture', 'coin-gold.glb': 'collectible', 'Cow.glb': 'animal', 'character-female-a.glb': 'character',
    });
  });

  it('tags a hyphenated compound so a word-by-word label lookup finds it', () => {
    const entry = run().selected.find((e: { file: string }) => e.file.endsWith('trash-can.glb'));
    expect(entry.tags).toEqual(expect.arrayContaining(['trash can', 'trash-can', 'trash']));
    expect(findByLabel(run().selected, 'a smelly trash can')?.file).toBe('Models/GLB format/trash-can.glb');
  });

  it('leaves a tag to the model the catalog already has', () => {
    const result = run(['cow', 'pizza']);
    expect(files(result)).not.toContain('Cow.glb');
    expect(files(result)).not.toContain('Pizza.glb');
  });

  it('caps the selection', () => {
    expect(run([], 5).selected).toHaveLength(5);
  });
});
