/**
 * P73A: co věta jmenuje, to hra ukáže v té roli. Sonda 6. 11. (věty soupeřů, `main` 0dc32f8e): „an underwater race
 * between a turtle and a shark“ závodila auty, „a tower of pancakes“ skládala kvádry, sopku hrál hranatý robot.
 * Hra s cizí postavou pořád vypadá hratelně – oko to nehlídá, proto pin. Pět vět soupeřů (P1–P5) a parafráze.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { lookOf } from '@/play/arcade/look';
import { heroModel, propModels } from '@/play/arcade/models';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { plural, singular } from '@/play/draft/lexicon';

interface Case {
  readonly sentence: string;
  /** Věta soupeře ze sondy (ostatní jsou parafráze). */
  readonly source?: 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
  /** Přípustná hlava popisku hrdiny. */
  readonly hero?: readonly string[];
  /** Hrdina z věty je i model, který scéna kreslí (závod: tvor, ne auto). */
  readonly heroDrawn?: true;
  /** Soupeř závodu: popisek, model a jméno v cíli. */
  readonly rival?: string;
  /** Nepřítel nebo nástraha, kterou věta jmenuje (hlava popisku role mimo hráče). */
  readonly foe?: string;
  /** Stohovaný předmět: popisek dílu, jeho model a „Stack N <předmětů>“ v cíli. */
  readonly piece?: string;
  readonly look?: string;
  /** Modely, které hrdina dostat nesmí. */
  readonly notModel?: readonly string[];
}

const CASES: readonly Case[] = [
  { sentence: 'A cat delivering pizzas across rooftops while avoiding seagulls', source: 'P1', hero: ['cat'], heroDrawn: true, foe: 'seagull', look: 'city' },
  { sentence: 'a cat delivers pizzas across the rooftops and avoids the seagulls', hero: ['cat'], heroDrawn: true, foe: 'seagull', look: 'city' },
  { sentence: 'deliver pizza over the rooftops as a cat while dodging seagulls', hero: ['cat'], heroDrawn: true, foe: 'seagull', look: 'city' },

  { sentence: 'A haunted library where books fly at you and you must find the exit', source: 'P2', look: 'graveyard' },
  { sentence: 'escape a haunted library while books fly at you', look: 'graveyard' },
  { sentence: 'find the exit of the haunted library', look: 'graveyard' },

  { sentence: 'An underwater race between a turtle and a shark', source: 'P3', hero: ['turtle'], heroDrawn: true, rival: 'shark', look: 'underwater' },
  { sentence: 'a turtle races a shark under the sea', hero: ['turtle'], heroDrawn: true, rival: 'shark' },
  { sentence: 'a turtle vs shark race', hero: ['turtle'], heroDrawn: true, rival: 'shark' },
  { sentence: 'a dog races a cat to the finish', hero: ['dog'], heroDrawn: true, rival: 'cat' },
  { sentence: 'a penguin races a seal on the ice', hero: ['penguin'], heroDrawn: true, rival: 'seal' },

  { sentence: 'Balance a tower of pancakes on a windy day', source: 'P4', piece: 'pancake' },
  { sentence: 'stack pancakes as high as you can in the wind', piece: 'pancake' },
  { sentence: 'stack books into a tower', piece: 'book' },

  { sentence: 'Escape a volcano before the lava reaches you', source: 'P5', hero: ['explorer', 'kid'], notModel: ['rigged:blocky-robot'], look: 'volcano' },
  { sentence: 'run from the volcano before the lava gets you', hero: ['explorer', 'kid'], notModel: ['rigged:blocky-robot'], look: 'volcano' },
  { sentence: 'escape the erupting volcano', hero: ['explorer', 'kid'], notModel: ['rigged:blocky-robot'], look: 'volcano' },
];

const head = (label: string): string => singular(label.toLowerCase()).split(' ').at(-1) ?? label;

/** Co v rychlé verzi věty nesedí s tím, co věta jmenuje; prázdné = sedí. */
function rolesMiss(test: Case): string[] {
  const { spec } = draftGameSpecWithMeta(test.sentence, 1);
  const player = spec.roles.find((role) => role.kind === 'player')?.label ?? '';
  const others = spec.roles.filter((role) => role.kind !== 'player');
  const props = propModels(spec);
  const model = heroModel(spec);
  const goal = spec.tutorial.goalLine;
  const wrong: string[] = [];
  if (test.hero !== undefined && !test.hero.includes(head(player))) wrong.push(`hero ${player}`);
  if (test.heroDrawn === true && !model.includes(head(player))) wrong.push(`hero model ${model}`);
  if (test.notModel?.includes(model) === true) wrong.push(`hero model ${model}`);
  if (test.rival !== undefined) {
    const rival = spec.roles.find((role) => role.id === 'rival')?.label ?? '';
    if (head(rival) !== test.rival) wrong.push(`rival ${rival}`);
    if (props.rival?.includes(test.rival) !== true) wrong.push(`rival model ${String(props.rival)}`);
    if (!goal.toLowerCase().includes(test.rival)) wrong.push(`goal "${goal}"`);
  }
  if (test.foe !== undefined && !others.some((role) => head(role.label) === test.foe)) wrong.push(`no ${test.foe}`);
  if (test.piece !== undefined) {
    const block = spec.roles.find((role) => role.id === 'block')?.label ?? '';
    if (head(block) !== test.piece) wrong.push(`piece ${block}`);
    if (props.block?.includes(test.piece) !== true) wrong.push(`piece model ${String(props.block)}`);
    if (!new RegExp(`^Stack \\d+ ${plural(test.piece, 2)}\\.`).test(goal)) wrong.push(`goal "${goal}"`);
  }
  if (test.look !== undefined && lookOf(spec.theme) !== test.look) wrong.push(`look ${lookOf(spec.theme)}`);
  return wrong;
}

beforeAll(() => loadRapier());

describe('a sentence keeps the roles it names (P73A)', () => {
  it('has the five competitor sentences, each with at least two paraphrases', () => {
    expect(CASES.filter((test) => test.source !== undefined)).toHaveLength(5);
    expect(CASES.length).toBeGreaterThanOrEqual(15);
  });

  it.each(CASES)('$sentence', (test) => {
    expect(rolesMiss(test)).toEqual([]);
  }, 120_000);
});

describe('a stacked thing changes the look, never the game (P73A T3)', () => {
  it.each(CASES.filter((test) => test.piece !== undefined).map((test) => test.sentence))('%s plays exactly like the block tower', (sentence) => {
    const { spec } = draftGameSpecWithMeta(sentence, 1);
    const blocks = { ...spec, roles: spec.roles.map((role) => (role.id === 'block' ? { ...role, label: 'block' } : role)) };
    const named = arcadeWorldOf(spec, 1);
    const plain = arcadeWorldOf(blocks, 1);
    if (!named.ok || !plain.ok) throw new Error('timing world did not compile');
    const bot = runBot(named.world);
    expect(bot.outcome).toBe('won');
    expect(replay(named.world, bot.inputs, ARCADE_LIBRARY).hash).toBe(replay(plain.world, bot.inputs, ARCADE_LIBRARY).hash);
    expect(replay(named.world, [], ARCADE_LIBRARY).hash).toBe(replay(plain.world, [], ARCADE_LIBRARY).hash);
  }, 120_000);

  it('a sentence that names no piece still stacks blocks', () => {
    const { spec } = draftGameSpecWithMeta('stack the tower as high as you can', 1);
    expect(spec.roles.find((role) => role.id === 'block')?.label).toBe('block');
    expect(spec.tutorial.goalLine).toMatch(/^Stack \d+ blocks\./);
  }, 120_000);
});

describe('a race of named creatures stays a race (P73A T2)', () => {
  it.each(CASES.filter((test) => test.rival !== undefined).map((test) => test.sentence))('%s: the bot wins, an idle player does not', (sentence) => {
    const made = arcadeWorldOf(draftGameSpecWithMeta(sentence, 1).spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(runBot(made.world).outcome).toBe('won');
    expect(replay(made.world, [], ARCADE_LIBRARY).outcome).not.toBe('won');
  }, 120_000);

  it('a race between two of the same races that creature, and "other cars" stay plural', () => {
    const two = draftGameSpecWithMeta('a race between two cats', 1).spec;
    expect(two.roles.find((role) => role.id === 'rival')?.label).toBe('cat');
    expect(draftGameSpecWithMeta('race against the other cars', 1).spec.tutorial.goalLine).toBe('Beat the other cars to the finish.');
    expect(draftGameSpecWithMeta('a car races', 1).spec.tutorial.goalLine).toBe('Beat the rival vehicles to the finish.');
  }, 120_000);
});
