/**
 * Střelba ve volném pohybu (P52 T7b). Chytání (`arena_catch`) akci střelby nebralo: kořist je role nepřítele a střela
 * ji zabila, takže robot prohrál vždy, a jiný cíl tam nebyl („A puppy catches soap bubbles … and spits water at the
 * bees“, dev P52 d10). Teď stojí na cestě ke kořisti včely, které hrdinu vrátí na start, střela kořist nesebere
 * (`spare`) a robot na ni nestřílí.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { generatorTakes } from '../../compose/compile';
import { draftGameSpecWithMeta } from '../../draft';
import type { GameSpecV1 } from '../../spec';
import { abilityStep } from '../abilities/bot';
import type { AbilityBot } from '../abilities/state';
import { baseBotOf } from '../addons';
import { arcadeWorldOf } from '../compile';
import { AXIS_MAX, type ArcadeWorld, BODY, BUTTON, FLAG, HEADER, type PieceRef, ROLE, UNIT, bodyBase, underlyingRule } from '../contract';
import { modelOf as sceneModel } from '@/components/play/arcade/arena/ArenaScene';

import { ARCADE_LIBRARY } from '../library';
import { enemyModel, preyModel } from '../models';
import { loadRapier } from '../physics/world';
import { arenaCatchContact } from '../pieces/arena-catch';
import { shotHit } from '../pieces/shots';
import { type BotProfile, runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);
const D10 = 'A puppy catches soap bubbles in the backyard and spits water at the bees.';

beforeAll(async () => {
  await loadRapier();
});

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Semínka brány P41 (1–20): na deseti vyjde rozdíl na hraně 0,1. */
const GATE_SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);

const wins = (spec: GameSpecV1, profile: BotProfile): number =>
  GATE_SEEDS.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / GATE_SEEDS.length;

/** Parametry robota akcí pod obaly hry. */
const abilityBotOf = (bot: PieceRef): AbilityBot => {
  const params = bot.params as { readonly base?: PieceRef; readonly abilities?: AbilityBot };
  return bot.id === 'addon_bot' && params.abilities !== undefined ? params.abilities : abilityBotOf(params.base as PieceRef);
};

const bodiesOf = (state: Int32Array): number[] => Array.from({ length: state[HEADER.bodyCount] as number }, (_v, index) => index);
const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

describe('P52 T7b: shoot in arena catch', () => {
  it('d10: the sentence keeps shoot, verification proves it and the intermediate bot uses it', () => {
    const spec = draftGameSpecWithMeta(D10, 1).spec;
    expect(spec.control).toBe('move_free');
    expect(spec.controlParams?.generator).toBe('arena_catch');
    expect(spec.abilities).toEqual(['shoot']);
    let used = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(verifyArcade(world, ARCADE_LIBRARY).failures, `${seed}`).toEqual([]);
      const run = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      const shot = run.firstFired[world.rules.findIndex((ref) => underlyingRule(ref).id === shotHit.id)]!;
      if (shot >= 0 && run.inputs.some((event) => (event.buttons & BUTTON.ACTION_A) !== 0)) used += 1;
    }
    expect(used / SEEDS.length).toBeGreaterThanOrEqual(0.9);
  }, 600_000);

  it('d10: novice and intermediate win as often as without the action', () => {
    const spec = draftGameSpecWithMeta(D10, 1).spec;
    const { abilities, ...plain } = spec;
    // Akci, která hru zkazí, kompozice zahodí – srovnání by pak bylo hry se sebou samou.
    expect(abilities).toEqual(['shoot']);
    for (const profile of ['novice', 'intermediate'] as const) expect(Math.abs(wins(spec, profile) - wins(plain, profile)), profile).toBeLessThanOrEqual(0.1);
  }, 600_000);

  it('the shot spares the prey and takes a bee; a bee sends the hero back to the start', () => {
    const world = worldOf(draftGameSpecWithMeta(D10, 1).spec, 1);
    const rules = world.rules.map(underlyingRule);
    const contact = arenaCatchContact.params.parse(rules.find((rule) => rule.id === arenaCatchContact.id)!.params);
    const hit = shotHit.params.parse(rules.find((rule) => rule.id === shotHit.id)!.params);
    const state = Int32Array.from(world.initial);
    const bees = bodiesOf(state).filter((i) => i !== contact.prey && alive(state, i) && state[bodyBase(i) + BODY.role] === ROLE.enemy);
    expect(bees.length).toBeGreaterThanOrEqual(1);
    const shot = (other: number): string[] => shotHit.fire({ state, player: 0, other } as unknown as Parameters<typeof shotHit.fire>[0], hit).map((effect) => effect.kind);
    expect(shot(contact.prey)).toEqual([]);
    expect(shot(bees[0]!)).toContain('despawn');
    // Hrdina na včele daleko od startu.
    const bee = bodyBase(bees[0]!), p = bodyBase(0);
    Object.assign(state, { [p + BODY.x]: state[bee + BODY.x], [p + BODY.z]: state[bee + BODY.z] });
    const sting = (): string[] => arenaCatchContact.fire({ state, player: 0, other: bees[0]! } as unknown as Parameters<typeof arenaCatchContact.fire>[0], contact).map((effect) => effect.kind);
    expect(sting()).toEqual(['respawn']);
    state[bee + BODY.flags] = (state[bee + BODY.flags] as number) & ~FLAG.alive;
    expect(sting()).toEqual([]);
  });

  it('the bot shoots a bee ahead but never the prey', () => {
    const world = worldOf(draftGameSpecWithMeta(D10, 1).spec, 1);
    const params = abilityBotOf(world.bot);
    const state = Int32Array.from(world.initial);
    const prey = arenaCatchContact.params.parse(world.rules.map(underlyingRule).find((rule) => rule.id === arenaCatchContact.id)!.params).prey;
    const bees = bodiesOf(state).filter((i) => i !== prey && alive(state, i) && state[bodyBase(i) + BODY.role] === ROLE.enemy);
    // Hrdina jede doprava, kořist 5 m před ním, včely pryč.
    for (const bee of bees) state[bodyBase(bee) + BODY.flags] = (state[bodyBase(bee) + BODY.flags] as number) & ~FLAG.alive;
    Object.assign(state, { [bodyBase(0) + BODY.x]: 0, [bodyBase(0) + BODY.z]: 0, [bodyBase(0) + BODY.vx]: 150, [bodyBase(0) + BODY.vz]: 0, [bodyBase(prey) + BODY.x]: 5 * UNIT, [bodyBase(prey) + BODY.z]: 0 });
    const presses = (): boolean => (abilityStep({ state, player: 0, tick: 0, recent: [] }, { axis: AXIS_MAX, buttons: 0 }, baseBotOf(world.bot), params).buttons & BUTTON.ACTION_A) !== 0;
    expect(presses()).toBe(false);
    // Včela na místě kořisti: tu robot sestřelí.
    const bee = bodyBase(bees[0]!);
    Object.assign(state, { [bee + BODY.flags]: (state[bee + BODY.flags] as number) | FLAG.alive, [bee + BODY.x]: 5 * UNIT, [bee + BODY.z]: 0, [bodyBase(prey) + BODY.z]: 10 * UNIT });
    expect(presses()).toBe(true);
  });

  it('among free-movement generators only arena catch takes shoot, and catch takes nothing else', () => {
    const ids = ['shoot', 'strike', 'dash', 'shield', 'grab'] as const;
    expect(ids.filter((id) => generatorTakes('arena_catch', id))).toEqual(['shoot']);
    for (const generator of ['arena_escape', 'arena_collect']) expect(ids.filter((id) => generatorTakes(generator, id)), generator).toEqual(['strike', 'dash', 'shield', 'grab']);
    for (const generator of ['fight', 'quest_spatial']) expect(generatorTakes(generator, 'shoot'), generator).toBe(false);
  });

  it('catch games without the action build the same worlds as before', () => {
    const plain = { ...draftGameSpecWithMeta(D10, 1).spec, abilities: undefined };
    // Otisky změřené před T7b.
    expect(SEEDS.slice(0, 3).map((seed) => canonicalHash(worldOf(plain, seed)))).toEqual(['aaae4c22', '6b864419', '36eee058']);
  });

  // T7b-R1: včely (tělo druhu `enemy`) kreslil model nepřítele, který v chytání vracel kořist – dvě velikosti mýdlových bublin.
  it('bees never draw the prey model; the prey keeps its own, catch without the action draws as before', () => {
    const spec = draftGameSpecWithMeta(D10, 1).spec;
    const plain = { ...spec, abilities: undefined };
    // Model kořisti a nepřítele chytání před T7b-R1 (popisek „soap bubble“).
    expect([preyModel(spec), preyModel(plain), enemyModel(plain)]).toEqual(['cell', 'cell', 'cell']);
    expect(enemyModel(spec)).not.toBe('cell');
    const cast = { player: 'hero', enemy: enemyModel(spec), chaser: 'chaser', props: {}, prey: preyModel(spec)! };
    expect([sceneModel('enemy', cast, 'enemy'), sceneModel('enemy', cast, 'prey')]).toEqual([enemyModel(spec), 'cell']);
    const { prey: _prey, ...bare } = cast;
    expect(sceneModel('enemy', bare, 'prey')).toBe(enemyModel(spec));
  });
});
