import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalHash } from '@/ir/worlddoc';
import { createStreams, nextInt } from '@/sim/rng';
import { decodeInputs } from '../../../../evals/play/p41/golden/freeze';
import { readGameSpec } from '../../spec';
import { arcadeWorldOf } from '../compile';
import type { ArcadeObservation, ArcadeWorld } from '../contract';
import { replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { BOT_PROFILES, runBot, type BotProfile } from '../verify';

const frozen = JSON.parse(readFileSync('evals/play/p41/golden/genres.json', 'utf8')) as { variants: { id: string; spec: unknown }[] };
const records = JSON.parse(readFileSync('evals/play/p41/golden/replays.json', 'utf8')) as { replays: Record<string, { inputs: string; hash: string; outcome: string; tick: number }> };
const raw = frozen.variants.find(variant => variant.id === 'runner.default/base')!.spec;
function worldOf(seed: number): ArcadeWorld {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const made = arcadeWorldOf(spec.value, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

describe('optional human bot profiles', () => {
  it.each([1, 2, 3])('keeps the default bot inputs and hash frozen at seed %i', seed => {
    const frozen = records.replays[`runner.default/base#${seed}`]!;
    const actual = runBot(worldOf(seed));
    expect(actual.inputs).toEqual(decodeInputs(frozen.inputs));
    expect(actual).toMatchObject({ hash: frozen.hash, outcome: frozen.outcome, tick: frozen.tick });
  });

  it.each(['novice', 'intermediate'] as BotProfile[])('%s has deterministic real errors, increased observation delay and replay', profile => {
    const world = worldOf(1), before = canonicalHash(world);
    const ordinary = runBot(world);
    const piece = ARCADE_LIBRARY.bots[world.bot.id]!;
    const observed: number[] = [];
    const library = { ...ARCADE_LIBRARY, bots: { ...ARCADE_LIBRARY.bots, [world.bot.id]: {
      ...piece,
      decide(observation: ArcadeObservation, params: unknown) { observed.push(observation.recent.length); return piece.decide(observation, params); },
    } } };
    const first = runBot(world, library, { profile });
    expect(Math.max(...observed)).toBe(piece.reactionTicks + BOT_PROFILES[profile].extraReactionTicks);
    expect(first.inputs).not.toEqual(ordinary.inputs);
    const unrelated = createStreams(world.seed);
    for (let index = 0; index < 500; index++) { nextInt(unrelated.layout, 0, 999); nextInt(unrelated.ai, 0, 999); }
    const second = runBot(world, undefined, { profile });
    expect(second.inputs).toEqual(first.inputs);
    expect(second.hash).toBe(first.hash);
    expect(replay(world, first.inputs, ARCADE_LIBRARY).hash).toBe(first.hash);
    expect(canonicalHash(world)).toBe(before);
    expect(runBot(world).inputs).toEqual(ordinary.inputs);
  });

  it('uses a stronger impairment for novice, rather than renaming the same profile', () => {
    expect(BOT_PROFILES.novice.extraReactionTicks).toBeGreaterThan(BOT_PROFILES.intermediate.extraReactionTicks);
    expect(BOT_PROFILES.novice.errorPerThousand * BOT_PROFILES.novice.errorTicks).toBeGreaterThan(BOT_PROFILES.intermediate.errorPerThousand * BOT_PROFILES.intermediate.errorTicks);
    const world = worldOf(2);
    expect(runBot(world, undefined, { profile: 'novice' }).inputs).not.toEqual(runBot(world, undefined, { profile: 'intermediate' }).inputs);
  });
});
