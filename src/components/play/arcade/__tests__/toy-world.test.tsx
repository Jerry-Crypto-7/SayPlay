/**
 * Hračkový pohyb ve scénách sdíleného `World` (P45D T7). Póza čte relaci na
 * replay cestě v devíti řízeních naráz: zápis do stavu nebo hodiny místo tiku
 * by přehrání rozbily a obraz by přitom vypadal živě – proto hash a „stejné
 * tiky = stejná póza“ při jiných hodinách.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu jsou náhrada, `useFrame` se zachytí,
 * `World` se zavolá jako funkce a skupinám ze stromu se předají skutečné
 * `Group` přes jejich `ref` (vzor `ghost-slot.test.tsx`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { baseControlOf } from '@/play/arcade/addons';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, HEADER, NO_INPUT } from '@/play/arcade/contract';
import { hashArcade, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { releasePhysics } from '@/play/arcade/physics/step';
import { loadRapier } from '@/play/arcade/physics/world';
import { toyViewOf } from '@/play/arcade/toy-motion';
import { runBot } from '@/play/arcade/verify';
import { assemblyOfCell, liveCells } from '@/play/compose/allowed';
import { compileRecipe } from '@/play/compose/compile';
import { readGameSpec } from '@/play/spec';

import { RiggedModel } from '../RiggedModel';
import type { ArcadeSession } from '../session';
import { fitModel, toyTargetOf, World } from '../World';

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
  useThree: (select: (three: { camera: PerspectiveCamera; size: { width: number; height: number } }) => unknown) =>
    select({ camera: new PerspectiveCamera(60, 9 / 16, 0.1, 120), size: { width: 412, height: 839 } }),
}));

beforeAll(loadRapier);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Náhrada okna nese i `performance`: Rapier v kroku míče čte hodiny přes `window.performance` a bez nich spadne na „unreachable“. */
function stubPage(search: string): void {
  vi.stubGlobal('window', { location: { search }, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, performance });
}

function fixtureWorld(name: string): ArcadeWorld {
  const spec = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${name}.json`), 'utf8')));
  if (!spec.ok) throw new Error(`${name}: ${spec.issues.join('; ')}`);
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(`${name}: ${built.issues.join('; ')}`);
  return built.world;
}

/** První živá buňka skladby, jejíž svět hraje řízení `control` (pro poletování, chůzi a míč fixtura není). */
function cellWorld(control: string): ArcadeWorld {
  for (const cell of liveCells()) {
    const built = arcadeWorldOf(compileRecipe(assemblyOfCell(cell)), 1);
    if (built.ok && baseControlOf(built.world.control).id === control) return built.world;
  }
  throw new Error(`no live cell plays ${control}`);
}

const WORLDS: Readonly<Record<string, () => ArcadeWorld>> = {
  flap: () => fixtureWorld('flap'),
  glide: () => cellWorld('glide'),
  walker: () => cellWorld('walker'),
  ball: () => cellWorld('ball'),
  steer: () => fixtureWorld('steer'),
  shooter: () => fixtureWorld('shooter'),
  throw: () => fixtureWorld('throw'),
  platform: () => fixtureWorld('platform'),
  runner: () => fixtureWorld('runner'),
};

type Element = ReactElement<Record<string, unknown> & { ref?: (node: Group) => void }>;

/** Projde strom elementů bez volání komponent; každé `<group ref>` dostane skutečnou skupinu. Vrací vnitřní skupinu hrdiny. */
function wire(node: ReactNode, inHero = false): Group | undefined {
  if (Array.isArray(node)) return node.reduce<Group | undefined>((found, child: ReactNode) => wire(child, inHero) ?? found, undefined);
  if (!isValidElement(node)) return undefined;
  const element = node as Element;
  const hero = inHero || (element.props.userData as { frame?: string } | undefined)?.frame === 'hero';
  let found: Group | undefined;
  if (element.type === 'group' && typeof element.props.ref === 'function') {
    const group = new Group();
    element.props.ref(group);
    // Vnitřní skupina pózy je jediná skupina s ref pod skupinou hrdiny.
    if (inHero) found = group;
  }
  return wire(element.props.children as ReactNode, hero) ?? found;
}

/** Stav po každém snímku: póza vnitřní skupiny hrdiny (poloha, natočení, měřítko). */
type Sample = readonly number[];
const sampleOf = (group: Group): Sample => [...group.position.toArray(), group.rotation.x, group.rotation.y, group.rotation.z, ...group.scale.toArray()].map((value) => value + 0);

/**
 * Hra robota `ticks` tiků; s `mount` běží po každém tiku dva snímky scény (podíl 0 a 0,5).
 * Každý snímek ověří, že scéna do stavu nic nezapsala.
 */
function play(world: ArcadeWorld, { mount, ticks = 120 }: { readonly mount: boolean; readonly ticks?: number }): { readonly samples: Sample[]; readonly hash: string } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const bot = runBot(world);
  const byTick = new Map(bot.inputs.map((event) => [event.tick, event]));
  const state = instantiate(world);
  const prev = state.slice();
  let alpha = 0;
  const session = {
    world,
    state: () => state,
    prev: () => prev,
    advance: () => alpha,
    alpha: () => alpha, endedFor: () => 0,
    snapshot: () => ({ tick: 0, runState: 'running' }),
    subscribe: () => () => undefined,
    onEvents: () => () => undefined,
    paused: () => false,
  } as unknown as ArcadeSession;
  const control = baseControlOf(world.control).id;
  hooks.frame = undefined;
  const hero = mount ? wire(World({ session, control, cast: { player: '', enemy: '', chaser: '', props: {} }, surface: { current: null }, scene: { block: undefined } as never, enabled: true, heroAction: 'none' })) : undefined;
  if (mount && (hero === undefined || hooks.frame === undefined)) throw new Error(`${control}: no hero pose group or frame`);
  const samples: Sample[] = [];
  try {
    for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) {
      prev.set(state);
      step(state, byTick.get(tick) ?? NO_INPUT, program);
      if (!mount) continue;
      for (const part of [0, 0.5]) {
        alpha = part;
        const before = state.slice();
        hooks.frame!(undefined, 1 / 120);
        if (state.some((value, slot) => value !== before[slot])) throw new Error(`${control}: the scene wrote into the state at tick ${tick}`);
        samples.push(sampleOf(hero!));
      }
    }
    return { samples, hash: hashArcade(state) };
  } finally {
    releasePhysics(state);
  }
}

const REST: Sample = [0, 0, 0, 0, 0, 0, 1, 1, 1];
const atRest = (sample: Sample, heading = sample[4]!): boolean => sample.every((value, i) => Math.abs(value - (i === 4 ? heading : REST[i]!)) < 1e-9);

describe('toy motion in every scene drawn by the shared world (P45D T7)', () => {
  it.each(Object.keys(WORLDS))('%s: the hero moves off rest and the run hashes the same with the scene mounted', (control) => {
    stubPage('');
    const world = WORLDS[control]!();
    const mounted = play(world, { mount: true });
    expect(mounted.samples.some((sample) => !atRest(sample)), `${control}: hero never left rest`).toBe(true);
    expect(mounted.hash).toBe(play(world, { mount: false }).hash);
  });

  it.each(Object.keys(WORLDS))('%s: the same ticks give the same pose whatever the wall clock says', (control) => {
    stubPage('');
    const world = WORLDS[control]!();
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const early = play(world, { mount: true }).samples;
    vi.spyOn(performance, 'now').mockReturnValue(987_654);
    expect(play(world, { mount: true }).samples).toEqual(early);
  });

  it.each(Object.keys(WORLDS))('%s: ?toy=off leaves the hero at rest, only turned where it walks', (control) => {
    stubPage('?toy=off');
    for (const sample of play(WORLDS[control]!(), { mount: true }).samples) expect(atRest(sample), `${control}: ${sample.join(', ')}`).toBe(true);
  });
});

/** Prvky stromu bez volání komponent. */
function elementsOf(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elementsOf(child));
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elementsOf(element.props.children as ReactNode)];
}

describe('rigged bodies in the shared world (P45D T13)', () => {
  it('the rigged hero gets the toy frame of its own body after the tick', () => {
    stubPage('');
    const world = WORLDS.runner!();
    const state = instantiate(world);
    try {
      const session = { world, state: () => state, prev: () => state, advance: () => 0, alpha: () => 0.5, endedFor: () => 0, snapshot: () => ({ tick: 0, runState: 'running' }), subscribe: () => () => undefined, onEvents: () => () => undefined, paused: () => false } as unknown as ArcadeSession;
      const tree = World({ session, control: 'runner', cast: { player: 'rigged:boy-a', enemy: 'rigged:knight', chaser: '', props: {} }, surface: { current: null }, scene: { block: undefined } as never, enabled: true, heroAction: 'none' });
      const rigged = elementsOf(tree).filter((element) => element.type === RiggedModel);
      expect(rigged.length).toBeGreaterThan(0);
      // Jediná riggovaná postava běžce je hrdina (`boy-a`); překážky jsou modely katalogu.
      expect(rigged.map((element) => (element.props.character as { id: string }).id)).toEqual(['boy-a']);
      const frame = (rigged[0]!.props.toy as (() => { view: unknown; tick: number }) | undefined)?.();
      expect(frame).toEqual({ view: toyViewOf(state, state, state[HEADER.player] as number), tick: (state[HEADER.tick] as number) + 0.5 });
    } finally {
      releasePhysics(state);
    }
  });
});

describe('fitModel for a body that moves', () => {
  function dogLike(): Group {
    const model = new Group();
    const trunk = new Mesh(new BoxGeometry(0.4, 0.4, 0.8), new MeshStandardMaterial({ color: '#a16207' }));
    trunk.position.set(0, 0.5, 0);
    const tail = new Mesh(new BoxGeometry(0.05, 0.05, 0.3), new MeshStandardMaterial({ color: '#a16207' }));
    tail.name = 'tail';
    tail.position.set(0, 0.62, -0.42);
    model.add(trunk, tail);
    return model;
  }

  it('hands the pose loop its parts with live pivots and its deformation; a still body gets neither', () => {
    const posed = fitModel(dogLike(), { id: 'dog', w: 1, h: 1, d: 1, character: true, posed: true });
    const inner = new Group().add(posed);
    const target = toyTargetOf(inner);
    expect(target.group).toBe(inner);
    expect(target.deform?.toyStride.value).toBe(0);
    expect(target.parts).toEqual([]);
    // Model z `mergePosed` nese díl pod pivotem – pivot si nechá živou matici, zbytek je zmrazený.
    const pivot = new Group();
    pivot.userData.toyPart = { role: 'tail', side: 1 };
    pivot.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial()));
    const merged = fitModel(new Group().add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()), pivot), { id: 'dog', w: 1, h: 1, d: 1, posed: true });
    const [part] = toyTargetOf(new Group().add(merged)).parts!;
    expect(part).toMatchObject({ role: 'tail', side: 1 });
    expect(part!.pivot.matrixAutoUpdate).toBe(true);
    expect(merged.matrixAutoUpdate).toBe(false);

    const still = fitModel(dogLike(), { id: 'dog', w: 1, h: 1, d: 1 });
    expect(toyTargetOf(new Group().add(still))).toEqual({ group: expect.any(Group) });
  });
});
