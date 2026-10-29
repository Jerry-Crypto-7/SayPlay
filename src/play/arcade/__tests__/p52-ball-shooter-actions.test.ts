/**
 * Štít v míči, krádež a štít ve střílečce (P52 T7). Hrdina míče i střelnice stojí na místě a nic k němu nedoletělo,
 * takže věty „shields itself from the fireballs“, „grabs the fuel cells“ a „blocks the lasers with its shield“ akci
 * ztratily (dev P52 d07, d08, d19–d22, P47B v53, v55). Teď k hrdinovi zepředu přiletí střela soupeře (štít) nebo
 * kořist (krádež), jen dokud hra jistě běží.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';

import { generatorTakes } from '../../compose/compile';
import { draftGameSpecWithMeta } from '../../draft';
import type { GameSpecV1 } from '../../spec';
import { arcadeWorldOf } from '../compile';
import { type AbilityId, type ArcadeWorld, underlyingRule } from '../contract';
import { ARCADE_LIBRARY } from '../library';
import { loadRapier } from '../physics/world';
import { type BotProfile, runBot, verifyArcade } from '../verify';

const SEEDS = Array.from({ length: 10 }, (_, index) => index + 1);

beforeAll(async () => {
  await loadRapier();
});

function worldOf(spec: GameSpecV1, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Věty mezer T7, ovládání a akce hrdiny. Střelba střílečky je její vlastní mechanika, akci nedostane. */
const SENTENCES: readonly (readonly [string, string, string, readonly AbilityId[]])[] = [
  ['d07', 'a robot plays tennis against a dragon and shields itself from the fireballs', 'ball', ['shield']],
  ['d08', 'A goat plays volleyball with a bear and blocks the hard spikes with a shield.', 'ball', ['shield']],
  ['d19', 'a space pilot shoots the asteroids and grabs the fuel cells they leave', 'shooter', ['grab']],
  ['d20', 'A starfighter shoots the alien drones and snatches the glowing energy orbs.', 'shooter', ['grab']],
  ['d21', 'a space fighter blocks the lasers with its shield and shoots down the alien ships', 'shooter', ['shield']],
  ['d22', 'A turret gunner raises a force field and shoots down the incoming drones.', 'shooter', ['shield']],
  ['v53', 'an archer shoots the orcs and snatches their loot bags', 'shooter', ['grab']],
  ['v55', 'a space ranger blocks meteors with a force field and blasts the alien ships', 'shooter', ['shield']],
];

const textOf = (id: string): string => SENTENCES.find(([key]) => key === id)![1];

const wins = (spec: GameSpecV1, profile: BotProfile): number => SEEDS.filter((seed) => runBot(worldOf(spec, seed), ARCADE_LIBRARY, { profile }).outcome === 'won').length / SEEDS.length;

describe('P52 T7: shield in ball games, grab and shield in shooters', () => {
  it.each(SENTENCES)('%s: the sentence keeps its action, verification proves it and the intermediate bot uses it', (_id, text, control, wants) => {
    const spec = draftGameSpecWithMeta(text, 1).spec;
    expect(spec.control).toBe(control);
    expect(spec.abilities).toEqual(wants);
    let used = 0;
    for (const seed of SEEDS) {
      const world = worldOf(spec, seed);
      expect(verifyArcade(world, ARCADE_LIBRARY).failures, `${seed}`).toEqual([]);
      const run = runBot(world, ARCADE_LIBRARY, { profile: 'intermediate' });
      if (run.firstFired[world.rules.findIndex((ref) => underlyingRule(ref).id === `ability_${wants[0]!}`)]! >= 0) used += 1;
    }
    expect(used / SEEDS.length).toBeGreaterThanOrEqual(0.9);
  }, 600_000);

  it.each(['d07', 'd08', 'd19', 'd21'])('%s: novice and intermediate win as often as without the action', (id) => {
    const spec = draftGameSpecWithMeta(textOf(id), 1).spec;
    const { abilities, ...plain } = spec;
    // Akci, která hru zkazí, kompozice zahodí – srovnání by pak bylo hry se sebou samou.
    expect(abilities).toEqual(SENTENCES.find(([key]) => key === id)![3]);
    for (const profile of ['novice', 'intermediate'] as const) expect(Math.abs(wins(spec, profile) - wins(plain, profile)), profile).toBeLessThanOrEqual(0.1);
  }, 600_000);

  it('an unblocked shot of the opponent costs the hero, so the shield is worth pressing', () => {
    const world = worldOf(draftGameSpecWithMeta(textOf('d21'), 1).spec, 1);
    const rules = world.rules.map(underlyingRule);
    expect(rules.some((rule) => rule.id === 'hit' && rule.params.role === 'hazard')).toBe(true);
    expect(rules.find((rule) => rule.id === 'ability_shield')?.params.roles).toContain('hazard');
  });

  it('a ball game takes the shield and nothing else', () => {
    expect((['grab', 'strike', 'dash', 'shield', 'shoot'] as const).filter((id) => generatorTakes('ball_pitch', id))).toEqual(['shield']);
  });

  it('ball and shooter games without the new actions build the same worlds as before', () => {
    const plain = (id: string): GameSpecV1 => ({ ...draftGameSpecWithMeta(textOf(id), 1).spec, abilities: undefined });
    // Otisky změřené před T7; střelnice přeotisknuty v P66 T10 (`genre.v6`: kola s výběrem vylepšení mezi vlnami).
    expect(['d07', 'd08', 'd19', 'd21'].map((id) => canonicalHash(worldOf(plain(id), 1)))).toEqual(['3240ac8e', '4f42804d', '84c1b3bc', '78c547ac']);
  });
});
