/**
 * Determinismus VR (P65 T2): hra hraná 600 tiků ovladači na 72 Hz dá týž hash stavu jako přehrání zaznamenaných
 * vstupů bez XR. Do záznamu jdou jen tlačítka a osa, takže replay a Dare fungují i pro hru z brýlí.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { createArcadeSession } from '@/components/play/arcade/session';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { Stage } from '@/play/compose/stage-registry';
import { readGameSpec } from '@/play/spec';

import { IDLE, type Pad, createXrDriver } from '../input-map';

beforeAll(async () => {
  await loadRapier();
});

const fromFixture = (raw: unknown): ArcadeWorld => {
  const spec = readGameSpec(raw);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
};

function mergeWorld(): ArcadeWorld {
  const cell = liveCells().find((candidate) => candidate.id === 'merge.default');
  if (cell === undefined) throw new Error('merge.default is not a live cell');
  const built = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Skriptovaná ruka: páčka střídá strany, spoušť cvaká – snímek po snímku, bez náhody. */
function scripted(frame: number): Pad {
  const phase = frame % 90;
  return {
    ...IDLE,
    x: phase < 20 ? -1 : phase >= 45 && phase < 65 ? 1 : 0,
    y: phase >= 70 && phase < 75 ? 1 : 0,
    trigger: frame % 30 < 6,
  };
}

const FRAME_MS = 1000 / 72;
const TICKS = 600;

function playInVr(world: ArcadeWorld, input: Stage['input']) {
  const session = createArcadeSession(world);
  const driver = createXrDriver(session, { input, fire: false, attack: false, use: false, abilities: 0 });
  for (let frame = 0; session.snapshot().tick < TICKS && session.snapshot().runState === 'running'; frame += 1) {
    driver.frame(scripted(frame));
    session.advance(FRAME_MS);
  }
  return session;
}

describe('a game played with the controllers replays to the same hash without XR', () => {
  it.each([
    ['runner', () => fromFixture(runnerFixture), 'runner'],
    ['shooter', () => fromFixture(shooterFixture), 'shooter-rig'],
    ['merge', mergeWorld, 'merge'],
  ] as const)('%s', (_name, world, input) => {
    const built = world();
    const session = playInVr(built, input);
    // Ovladače hru opravdu hrály – jinak by shoda hashe nic neříkala.
    expect(session.inputs().length).toBeGreaterThan(10);
    expect(replay(built, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
  });
});
