/**
 * Hrdina rytmu a jezdec načasování odpovídají tělem na trefu a minutí (P45D T11).
 * Hrdina, který skáče do taktu sám od sebe, vypadá živě a lže o tom, co hráč trefil –
 * proto robot jednu notu vynechá (beat bez trefy) a jednou ťukne naprázdno (minutí),
 * a test porovná tiky tref ze stavu se snímky, ve kterých je tělo nad zemí.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu jsou náhrada, `useFrame` se zachytí,
 * scéna se zavolá jako funkce a ze stromu elementů se postaví strom skutečných
 * `Group`, kterým se předají jejich `ref` (vzor `toy-world.test.tsx`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { Group, type Object3D, PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, BUTTON, HEADER, NO_INPUT, UNIT, bodyBase } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { TIMING_SLOTS } from '@/play/arcade/pieces/timing';
import { runBot } from '@/play/arcade/verify';
import { readGameSpec } from '@/play/spec';

import { RhythmScene } from '../rhythm/RhythmScene';
import type { ArcadeSession } from '../session';
import { TimingScene } from '../timing/TimingScene';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
type Frame = (state: unknown, delta: number) => void;
const hooks = vi.hoisted(() => ({ frame: undefined as Frame | undefined }));
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: (frame: Frame) => {
    hooks.frame = frame;
  },
  useThree: (select: (three: { camera: PerspectiveCamera }) => unknown) => select({ camera: new PerspectiveCamera(60, 9 / 16, 0.1, 120) }),
}));
vi.mock('@/play/audio', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/play/audio')>()), playTone: () => undefined }));

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPage(search: string, reduced = false): void {
  vi.stubGlobal('window', { location: { search }, matchMedia: () => ({ matches: reduced }), addEventListener: () => undefined, removeEventListener: () => undefined, performance });
}

function fixtureWorld(name: string): ArcadeWorld {
  const spec = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${name}.json`), 'utf8')));
  if (!spec.ok) throw new Error(`${name}: ${spec.issues.join('; ')}`);
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(`${name}: ${built.issues.join('; ')}`);
  return built.world;
}

type Element = ReactElement<Record<string, unknown> & { ref?: ((node: Object3D) => void) | { current: unknown } }>;

/** Postaví ze stromu elementů strom skupin (jen `group` a `mesh`, se jménem a `userData`) a předá jim `ref`. */
function wire(node: ReactNode, parent: Object3D): void {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) wire(child, parent);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as Element;
  let into = parent;
  if (element.type === 'group' || element.type === 'mesh') {
    into = new Group();
    into.name = (element.props.name as string | undefined) ?? '';
    into.userData = { ...((element.props.userData as object | undefined) ?? {}) };
    parent.add(into);
    const { ref } = element.props;
    if (typeof ref === 'function') ref(into);
    else if (ref !== undefined && ref !== null) ref.current = into;
  }
  wire(element.props.children as ReactNode, into);
}

/** Poloha, natočení a měřítko skupiny pózy; v klidu `[0,0,0, 0,0,0, 1,1,1]`. */
const sampleOf = (group: Object3D): number[] => [...group.position.toArray(), group.rotation.x, group.rotation.y, group.rotation.z, ...group.scale.toArray()];
const REST = [0, 0, 0, 0, 0, 0, 1, 1, 1];
const atRest = (group: Object3D): boolean => group.visible && sampleOf(group).every((value, i) => Math.abs(value - REST[i]!) < 1e-9);

interface Shot {
  readonly tick: number;
  /** Výsledek ťuku v tomhle tiku: 1 trefa, −1 minutí, 0 nic. */
  readonly result: number;
  readonly hop: boolean;
  readonly wobble: boolean;
  readonly rest: boolean;
  readonly others: boolean;
}

/**
 * Robot hraje `world` (vstupy upraví `edit`); po každém tiku dva snímky scény (podíl 0 a 0,5).
 * `poseOf` vybere ze stromu skupinu pózy, `othersOf` skupiny, které mají zůstat v klidu.
 * Každý snímek ověří, že scéna do stavu nic nezapsala.
 */
function play(
  world: ArcadeWorld,
  scene: (session: ArcadeSession) => ReactNode,
  poseOf: (root: Object3D, state: Int32Array) => Object3D,
  edit: (inputs: { tick: number; buttons: number; axis: number }[]) => void = () => undefined,
  othersOf: (root: Object3D, state: Int32Array) => Object3D[] = () => [],
): Shot[] {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const inputs = runBot(world).inputs.map((event) => ({ tick: event.tick, buttons: event.buttons, axis: event.axis }));
  edit(inputs);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  const state = instantiate(world);
  const prev = state.slice();
  let alpha = 0;
  const session = { world, state: () => state, prev: () => prev, advance: () => alpha, alpha: () => alpha } as unknown as ArcadeSession;
  hooks.frame = undefined;
  const root = new Group();
  wire(scene(session), root);
  const frame = hooks.frame as Frame | undefined;
  if (frame === undefined) throw new Error('the scene registered no frame');
  const frames: Shot[] = [];
  const p = bodyBase(state[HEADER.player] as number);
  for (let tick = 0; outcomeOf(state) === 'running'; tick += 1) {
    prev.set(state);
    step(state, byTick.get(tick) ?? NO_INPUT, program);
    const result = Math.sign(state[p + BODY.aux0] as number);
    for (const part of [0, 0.5]) {
      alpha = part;
      const before = state.slice();
      frame(undefined, 1 / 120);
      if (state.some((value, slot) => value !== before[slot])) throw new Error(`the scene wrote into the state at tick ${tick}`);
      const pose = poseOf(root, state);
      frames.push({
        tick,
        result,
        hop: pose.position.y > 1e-9,
        wobble: Math.abs(pose.rotation.z) > 1e-9,
        rest: atRest(pose),
        others: othersOf(root, state).every(atRest),
      });
    }
  }
  return frames;
}

/** Poskok trvá 0,24 s = 14,4 tiku; noty jsou od sebe nejméně dvě okna a tik (18 tiků). */
const HOP_TICKS = 15;
/** Nejdelší odpověď (poskok s dopadem, zásah) dozní do půl sekundy. */
const SETTLE_TICKS = 30;

/** Snímky tiku `tick` a dalšího – „do dvou snímků od trefy“ při 60 snímcích za sekundu. */
const firstTwo = (frames: readonly Shot[], tick: number): Shot[] => frames.filter((frame) => frame.tick === tick).slice(0, 2);

function expectHopsOnlyOnHits(frames: readonly Shot[], label: string): void {
  const hits = frames.filter((frame) => frame.result > 0).map((frame) => frame.tick);
  expect(hits.length, `${label}: the robot hit nothing`).toBeGreaterThan(3);
  for (const tick of new Set(hits)) expect(firstTwo(frames, tick).some((frame) => frame.hop), `${label}: no hop within two frames of the hit at tick ${tick}`).toBe(true);
  for (const frame of frames) {
    if (!frame.hop) continue;
    const after = hits.filter((tick) => tick <= frame.tick).at(-1);
    expect(after !== undefined && frame.tick - after <= HOP_TICKS, `${label}: hop at tick ${frame.tick} without a hit (last hit ${after})`).toBe(true);
  }
}

describe('rhythm hero answers hits and misses with its body (P45D T11)', () => {
  const world = fixtureWorld('rhythm');
  const scene = (session: ArcadeSession) =>
    RhythmScene({ session, look: { ground: '#000000' } as never, heroModel: () => <mesh name="hero-model" />, heroAction: 'none' });
  const heroPose = (root: Object3D): Object3D => root.getObjectByName('hero-model')!.parent!;
  // Ťuk naprázdno v náběhu (minutí) a vynechaná třetí nota (beat bez trefy, minutí až po přejetí).
  const EMPTY_TAP = 60;
  const skipThird = (inputs: { tick: number; buttons: number; axis: number }[]): void => {
    inputs.splice(2, 1);
    inputs.unshift({ tick: EMPTY_TAP, buttons: BUTTON.TAP, axis: 0 });
  };

  it('hops within two frames of every hit and never without one, even on a skipped beat', () => {
    stubPage('');
    const frames = play(world, scene, heroPose, skipThird);
    expect(frames.filter((frame) => frame.result < 0).length, 'the empty tap and the skipped note are both misses').toBeGreaterThanOrEqual(2);
    expectHopsOnlyOnHits(frames, 'rhythm');
  });

  it('a miss wobbles without a hop, and with no event the hero stands still', () => {
    stubPage('');
    const frames = play(world, scene, heroPose, skipThird);
    const events = frames.filter((frame) => frame.result !== 0).map((frame) => frame.tick);
    expect(frames.filter((frame) => frame.tick < EMPTY_TAP).every((frame) => frame.rest), 'the hero moved before anything happened').toBe(true);
    const miss = frames.filter((frame) => frame.tick >= EMPTY_TAP && frame.tick < EMPTY_TAP + 10);
    expect(miss.some((frame) => frame.wobble), 'the miss did not wobble').toBe(true);
    expect(miss.some((frame) => frame.hop), 'the miss hopped').toBe(false);
    for (const frame of frames) {
      const last = events.filter((tick) => tick <= frame.tick).at(-1);
      if (last === undefined || frame.tick - last > SETTLE_TICKS) expect(frame.rest, `the hero moves at tick ${frame.tick} with no event since ${last}`).toBe(true);
    }
  });

  it('under prefers-reduced-motion a hit never moves the hero', () => {
    stubPage('', true);
    expect(play(world, scene, heroPose).some((frame) => frame.hop || frame.wobble)).toBe(false);
  });
});

describe('timing slider and the newest block answer hits with their bodies (P45D T11)', () => {
  const world = fixtureWorld('timing');
  const scene = (session: ArcadeSession) => TimingScene({ session, look: { ground: '#000000' } as never, heroAction: 'none' });
  /** Jezdec (hrdina sondy záběru) → jeho vnitřní skupina pózy. */
  const sliderPose = (root: Object3D): Object3D => root.children.find((node) => node.userData.frame === 'hero')!.children[0]!;
  /** Skupina pózy položeného dílu kola `round`: díl → posun o půl výšky → póza. */
  const placedPose = (root: Object3D, round: number): Object3D | undefined =>
    root.children.filter((node) => 'item' in node.userData && node.userData.frame === undefined)[round]?.children[0]?.children[0];
  const roundsOf = (state: Int32Array): number => Math.floor((state[bodyBase(state[HEADER.player] as number) + BODY.z] as number) / UNIT);
  const marks = (state: Int32Array): number => (state[HEADER.bodyCount] as number) - TIMING_SLOTS.marks;

  it('the slider hops within two frames of every hit and never without one', () => {
    stubPage('');
    expectHopsOnlyOnHits(play(world, scene, sliderPose), 'timing slider');
  });

  it('the block just placed hops with the hit; the blocks under it stand still', () => {
    stubPage('');
    const newest = (root: Object3D, state: Int32Array): Object3D => placedPose(root, Math.max(0, roundsOf(state) - 1))!;
    const older = (root: Object3D, state: Int32Array): Object3D[] =>
      Array.from({ length: marks(state) }, (_, round) => round).filter((round) => round !== roundsOf(state) - 1).map((round) => placedPose(root, round)!);
    const frames = play(world, scene, newest, undefined, older);
    expectHopsOnlyOnHits(frames.filter((frame) => frame.tick >= frames.find((first) => first.result > 0)!.tick), 'timing block');
    expect(frames.every((frame) => frame.others), 'a block under the newest one moved').toBe(true);
  });
});
