/**
 * P54B T2: vzhled scény do hry nevstupuje. Celý P54B (postavy, výplň, světlo, nálada) staví
 * na tom, že `theme` – sada, nálada, počasí, denní doba – je jen obraz: stejný spec s jiným
 * `theme` postaví týž svět, týž počáteční stav a robot ho odehraje se stejným hashem.
 * Kdyby `theme` do hashe vstupoval, každá změna vzhledu by přepsala otisk uložených her.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/ir/worlddoc';
import { type LookId, lookOf } from '@/play/arcade/look';
import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpec } from '@/play/draft';
import type { GameSpecV1 } from '@/play/spec';

import { arcadeWorldOf } from '../compile';
import { type ArcadeWorld, NO_INPUT } from '../contract';
import { hashArcade, instantiate, loadProgram, step, worldHasPhysics } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { runBot } from '../verify';

/** Věta na žánr (sada `evals/play/p46g/genres.json`), šest různých scén. */
const SENTENCES = [
  'A fox runs through a forest away from a bear',
  'A squirrel jumps over logs in a forest',
  'Collect ten acorns in a forest while avoiding a fox',
  'A ranger shoots zombies in a forest',
  'throw acorns at targets in a forest',
  'A jeep races through the jungle',
] as const;

const TICKS = 600;

function worldOf(spec: GameSpecV1): ArcadeWorld {
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Týž spec v jiném světle: jiná sada, nálada, počasí i denní doba. */
function restyled(spec: GameSpecV1): GameSpecV1 {
  const look: LookId = lookOf(spec.theme) === 'graveyard' ? 'beach' : 'graveyard';
  return { ...spec, theme: { ...spec.theme, look, mood: 'spooky stormy night', weather: 'rain', timeOfDay: 'night' } };
}

/** Hash stavu po `TICKS` tikách záznamu robota (nebo dřív, když hra skončí – na obou stranách stejně). */
function hashAfter(world: ArcadeWorld, inputs: ReturnType<typeof runBot>['inputs']): string {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  for (let tick = 0; tick < TICKS; tick += 1) step(state, byTick.get(tick) ?? NO_INPUT, program);
  return hashArcade(state);
}

const cases = SENTENCES.map((text) => {
  const spec = draftGameSpec(text, 1);
  return { text, spec, other: restyled(spec) };
});

describe('P54B: the scene look is not part of the game hash', () => {
  beforeAll(async () => {
    if (cases.some(({ spec }) => worldHasPhysics(worldOf(spec)))) await loadRapier();
  });

  it('covers six different genres', () => {
    expect(new Set(cases.map(({ spec }) => spec.genre?.id ?? spec.control)).size).toBe(6);
  });

  it.each(cases.map((entry) => [entry.text, entry] as const))('%s', (_, { spec, other }) => {
    expect(other.theme).not.toEqual(spec.theme);
    const world = worldOf(spec);
    const styled = worldOf(other);
    expect(canonicalHash(styled), 'world hash').toBe(canonicalHash(world));
    expect(hashArcade(instantiate(styled)), 'initial state hash').toBe(hashArcade(instantiate(world)));
    const bot = runBot(world);
    expect(hashAfter(styled, bot.inputs), `bot replay hash at tick ${TICKS}`).toBe(hashAfter(world, bot.inputs));
  });
});
