/**
 * Determinismus VR (P65 T2): hra hraná 600 tiků ovladači na 72 Hz dá týž hash stavu jako přehrání zaznamenaných
 * vstupů bez XR. Do záznamu jdou jen tlačítka a osa, takže replay a Dare fungují i pro hru z brýlí.
 *
 * Svět kolem hráče (P67 T6): aréna páčkou, obrana paprskem a chytání polohou ruky. U chytání se hra z ruky navíc
 * porovná s hrou prstem bez XR: ruka nad pruhem musí dát přesně tytéž `hold(osa)` jako prst tažený po témž pruhu.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { createArcadeSession } from '@/components/play/arcade/session';
import runnerFixture from '@/play/arcade/__fixtures__/runner.json';
import shooterFixture from '@/play/arcade/__fixtures__/shooter.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { hashArcade, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { axisOfLane, laneOfX } from '@/play/arcade/pieces/lanes';
import { loadRapier } from '@/play/arcade/physics/world';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import type { Stage } from '@/play/compose/stage-registry';
import { readGameSpec } from '@/play/spec';

import { IDLE, type Pad, type XrControl, type XrMotion, createXrDriver } from '../input-map';

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

function cellWorld(id: string): ArcadeWorld {
  const cell = liveCells().find((candidate) => candidate.id === id);
  if (cell === undefined) throw new Error(`${id} is not a live cell`);
  const built = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}
const mergeWorld = (): ArcadeWorld => cellWorld('merge.default');

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

/** Ruka chytání: pomalu sem a tam přes všech pět pruhů (jednotky jádra, ±4,5 m), bez náhody. */
const handX = (frame: number): number => 4500 * Math.sin(frame / 45);
/** Paprsek obrany: každou sekundu na další pruh (osa pruhu, jakou dá `aimOfPoint`). */
const rayAim = (frame: number): number => axisOfLane(Math.floor(frame / 72) % 5);

/** Pohyb ruky snímku `frame`, jak ho XR vrstva předá vstupu; `null` = jen páčka a spoušť. */
type Motion = (frame: number) => XrMotion | null;
const NO_MOTION: Motion = () => null;

function playInVr(world: ArcadeWorld, input: Stage['input'], motion: Motion = NO_MOTION, extra: Partial<XrControl> = {}, pad: (frame: number) => Pad = scripted) {
  const session = createArcadeSession(world);
  const driver = createXrDriver(session, { input, fire: false, attack: false, use: false, abilities: 0, ...extra });
  for (let frame = 0; session.snapshot().tick < TICKS && session.snapshot().runState === 'running'; frame += 1) {
    driver.frame(pad(frame), motion(frame));
    session.advance(FRAME_MS);
  }
  return session;
}

describe('a game played with the controllers replays to the same hash without XR', () => {
  it.each([
    ['runner', () => fromFixture(runnerFixture), 'runner', NO_MOTION, {}],
    ['shooter', () => fromFixture(shooterFixture), 'shooter-rig', NO_MOTION, {}],
    ['merge', mergeWorld, 'merge', NO_MOTION, {}],
    // P67 T6 – svět kolem hráče.
    ['arena (room)', () => cellWorld('arena.escape'), 'arena', NO_MOTION, {}],
    ['defense (room)', () => cellWorld('defense.default'), 'lanes', (frame: number) => ({ aim: rayAim(frame), velocity: null, laneAxis: null }), {}],
    ['catch (room)', () => cellWorld('catch.default'), 'lanes', (frame: number) => ({ aim: null, velocity: null, laneAxis: null, handX: handX(frame) }), { handLane: true }],
  ] as const)('%s', (_name, world, input, motion: Motion, extra: Partial<XrControl>) => {
    const built = world();
    const session = playInVr(built, input, motion, extra);
    // Ovladače hru opravdu hrály – jinak by shoda hashe nic neříkala.
    expect(session.inputs().length).toBeGreaterThan(10);
    expect(replay(built, session.inputs(), ARCADE_LIBRARY, session.snapshot().tick).hash).toBe(hashArcade(session.state()));
  });
});

describe('catch in the room: the hand over a lane is the finger on that lane', () => {
  /** Bez XR: prst tažený po pruhu pod rukou drží jeho osu (`lanes-input.ts`: `hold` jen při změně). */
  function playByFinger(world: ArcadeWorld) {
    const session = createArcadeSession(world);
    let held = 0;
    for (let frame = 0; session.snapshot().tick < TICKS && session.snapshot().runState === 'running'; frame += 1) {
      const axis = axisOfLane(laneOfX(handX(frame)));
      if (axis !== held) {
        held = axis;
        session.hold(axis);
      }
      session.advance(FRAME_MS);
    }
    return session;
  }

  it('same inputs and the same hash as the finger', () => {
    const world = cellWorld('catch.default');
    const hand = playInVr(world, 'lanes', (frame) => ({ aim: null, velocity: null, laneAxis: null, handX: handX(frame) }), { handLane: true }, () => IDLE);
    const finger = playByFinger(world);
    // Ruka prošla všemi pěti pruhy – jinak by shoda nic neříkala.
    expect(new Set(hand.inputs().map((event) => event.axis)).size).toBeGreaterThanOrEqual(5);
    expect(hand.inputs()).toEqual(finger.inputs());
    expect(hashArcade(hand.state())).toBe(hashArcade(finger.state()));
  });
});
