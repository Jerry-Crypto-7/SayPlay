/**
 * Pohyb úkolu a plavby (P45D T12). Dveře otevřené od začátku nebo u špatného
 * cíle vypadají jako splněný úkol – proto „dveře se otevřou právě v tiku, kdy
 * jejich cíl posunul stav“. Plavidlo, které se samo houpe, lže o tom, že jede –
 * proto „plavidlo bez pohybu stojí“ (a rozjeté se pohne, ať test není prázdný).
 *
 * Repo nemá vykreslovač R3F: háčky Reactu jsou náhrada, `useFrame` se zachytí,
 * komponenty se volají jako funkce a skupinám ze stromu se předají skutečné
 * `Group` (vzor `toy-world.test.tsx`).
 */

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D, PerspectiveCamera } from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { color } from '@/brand/tokens';
import { type ArcadeWorld, HEADER, NO_INPUT, targetStateOf } from '@/play/arcade/contract';
import { LOOKS } from '@/play/arcade/look';
import { buildWorld, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { releasePhysics } from '@/play/arcade/physics/step';
import { loadRapier } from '@/play/arcade/physics/world';
import { questStation } from '@/play/arcade/pieces/quest';
import { voyageLand, voyageRace } from '@/play/arcade/pieces/steer';
import { runBot } from '@/play/arcade/verify';

import { targetsOf } from '../arena/TargetsMount';
import { bodiesOf } from '../bodies';
import { bodyFor } from '../look/load';
import { opensOnState, questTargets, TargetStates } from '../quest/TargetStates';
import type { ArcadeSession } from '../session';
import { VoyageHero } from '../steer/VoyageHero';
import { voyageLayoutOf } from '../steer/voyageLayout';
import { fitModel, World } from '../World';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useCallback: (callback: unknown) => callback,
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
    // Hrací obdélník na výšku (`usePlayRectRef`, P64): mimo plátno nezměřený.
    useContext: () => ({ current: null }),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  };
});
type Frame = (state: unknown, delta: number) => void;
const hooks = vi.hoisted(() => ({ frames: [] as Frame[], scene: null as unknown }));
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: (frame: Frame) => {
    hooks.frames.push(frame);
  },
  useThree: (select: (three: Record<string, unknown>) => unknown) =>
    select({ camera: new PerspectiveCamera(60, 9 / 16, 0.1, 120), scene: hooks.scene, gl: { domElement: { dataset: {} } }, size: { width: 412, height: 839 } }),
}));

beforeAll(loadRapier);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Náhrada okna nese i `performance` (Rapier čte hodiny přes `window.performance`); `reduce` = prefers-reduced-motion. */
function stubPage(reduce = false): void {
  vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: reduce }), addEventListener: () => undefined, removeEventListener: () => undefined, performance });
}

function worldOf(parts: unknown): ArcadeWorld {
  const { control, rules, bot, level, health } = parts as Parameters<typeof buildWorld>[0];
  const built = buildWorld({ seed: 1, control, rules, bot, level, ...(health === undefined ? {} : { health }) }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Relace nad stavem, který test sám krokuje; podíl tiku nastavuje `alpha`. */
function sessionOf(world: ArcadeWorld, state: Int32Array, prev: Int32Array, alpha: { value: number }): ArcadeSession {
  return {
    world,
    state: () => state,
    prev: () => prev,
    advance: () => alpha.value,
    alpha: () => alpha.value, endedFor: () => 0,
    snapshot: () => ({ tick: 0, runState: 'running' }),
    subscribe: () => () => undefined,
    onEvents: () => () => undefined,
    paused: () => false,
  } as unknown as ArcadeSession;
}

type Element = ReactElement<Record<string, unknown> & { ref?: ((node: Group) => void) | { current: unknown } }>;

/**
 * Projde strom elementů bez volání komponent a postaví z `<group>` skutečný strom skupin pod `parent`
 * (s `userData`, ať je scéna najde jako za běhu); každý `ref` dostane svou skupinu.
 * Komponenty se jmény z `call` zavolá a projde, co vrátí.
 */
function wire(node: ReactNode, parent: Group, call: ReadonlySet<string> = new Set()): void {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) wire(child, parent, call);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as Element;
  if (typeof element.type === 'function' && call.has(element.type.name)) {
    wire((element.type as (props: unknown) => ReactNode)(element.props), parent, call);
    return;
  }
  let into = parent;
  if (element.type === 'group') {
    into = new Group();
    into.userData = { ...(element.props.userData as object | undefined) };
    parent.add(into);
    const ref = element.props.ref;
    if (typeof ref === 'function') ref(into);
    else if (ref !== undefined && ref !== null) ref.current = into;
  }
  wire(element.props.children as ReactNode, into, call);
}

/** Poloha, natočení a měřítko skupiny; −0 jako 0. */
const sampleOf = (group: Object3D): number[] => [...group.position.toArray(), group.rotation.x, group.rotation.y, group.rotation.z, ...group.scale.toArray()].map((value) => value + 0);
const REST = [0, 0, 0, 0, 0, 0, 1, 1, 1];

function findGroup(root: Object3D, match: (node: Object3D) => boolean): Group {
  let found: Object3D | undefined;
  root.traverse((node) => {
    if (found === undefined && match(node)) found = node;
  });
  if (found === undefined) throw new Error('group not found');
  return found as Group;
}

// ---------------------------------------------------------------------------
// Dveře cíle úkolu

/** GLB dveří katalogu: rám a křídlo v uzlu `door-leaf` (díl `panel-door:leaf` v `catalog-motion.json`). */
function panelDoor(): Group {
  const frame = new Mesh(new BoxGeometry(1, 2, 0.1), new MeshStandardMaterial({ color: color.cream }));
  frame.position.set(0, 1, 0);
  const leaf = new Mesh(new BoxGeometry(0.9, 1.9, 0.05), new MeshStandardMaterial({ color: color.sky }));
  leaf.name = 'door-leaf';
  leaf.position.set(0, 0.95, 0.06);
  return new Group().add(frame, leaf);
}

interface DoorRun {
  /** Po snímcích: tik, stav každého cíle a úhel jeho dveří (rad, kolem svislé osy pivotu). */
  readonly frames: { readonly tick: number; readonly states: readonly number[]; readonly angles: readonly number[]; readonly still: boolean }[];
}

/** Stanoviště se dvěma cíli kreslenými dveřmi; robot hraje, po každém tiku dva snímky (podíl 0 a 0,5). */
function playDoors(reduce = false): DoorRun {
  stubPage(reduce);
  const world = worldOf(questStation.parts(1, questStation.params.parse({ verb: 'flip', states: 3 }), undefined));
  const program = loadProgram(world, ARCADE_LIBRARY);
  const byTick = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
  const state = instantiate(world);
  const prev = state.slice();
  const alpha = { value: 0 };
  const session = sessionOf(world, state, prev, alpha);
  const views = bodiesOf(session);
  const layer = questTargets(world, { session, look: { block: undefined } as never, heroAction: 'none' }, 'panel-door')!;
  const mounted = layer(targetsOf(views, state)) as ReactElement<Parameters<typeof TargetStates>[0]>;
  // Vrstva cílů dostane relaci scény – bez ní by dveře neměly z čeho číst tik otevření.
  expect(mounted.props.session).toBe(session);
  const tree = TargetStates(mounted.props);
  hooks.frames = [];
  const root = new Group();
  wire(tree, root, new Set(['OpeningModel']));
  const doors = hooks.frames;
  const targets = targetsOf(views, state);
  expect(targets).toHaveLength(2);
  expect(doors).toHaveLength(2);
  // Model se načte až za běhu: vnitřní skupina dostane, co by vrátil `loadBodyModel(…, { posed: true })`.
  const holders: Group[] = [];
  root.traverse((node) => {
    if (node.userData.frame === 'target') holders.push(node.children[0] as Group);
  });
  expect(holders).toHaveLength(2);
  const pivots = holders.map((inner, i) => {
    const target = targets[i]!;
    inner.add(fitModel(bodyFor(panelDoor(), 'panel-door', true), { id: 'panel-door', w: target.w, h: target.h, d: target.d, posed: true }));
    return findGroup(inner, (node) => node.userData.toyPart !== undefined);
  });
  const frames: DoorRun['frames'][number][] = [];
  try {
    for (let tick = 0; tick < 400 && outcomeOf(state) === 'running'; tick += 1) {
      prev.set(state);
      step(state, byTick.get(tick) ?? NO_INPUT, program);
      for (const part of [0, 0.5]) {
        alpha.value = part;
        for (const door of doors) door(undefined, 1 / 120);
        const still = holders.every((inner) => sampleOf(inner).every((value, i) => Math.abs(value - REST[i]!) < 1e-9));
        frames.push({ tick: state[HEADER.tick] as number, states: targets.map((target) => targetStateOf(state, target.index)), angles: pivots.map((pivot) => pivot.rotation.y), still });
      }
    }
  } finally {
    releasePhysics(state);
  }
  return { frames };
}

describe('quest targets with a door open when their state moves (P45D T12)', () => {
  it('knows the catalog models whose part opens', () => {
    for (const id of ['panel-door', 'iron-gate', 'storage-cabinet', 'framed-window']) expect(opensOnState(id), id).toBe(true);
    for (const id of ['oak-tree', 'dog', 'hanging-lantern', 'no-such-model']) expect(opensOnState(id), id).toBe(false);
  });

  it('a door opens exactly in the tick its own target steps forward – not at start, not with the other target', () => {
    const { frames } = playDoors();
    for (const door of [0, 1]) {
      const changed = frames.find((frame) => frame.states[door]! > 0);
      expect(changed, `target ${door} never stepped forward`).toBeDefined();
      // Dokud cíl stojí v prvním stavu, jeho dveře jsou zavřené – i když se vedle otevírají druhé.
      for (const frame of frames.filter((each) => each.states[door] === 0)) expect(frame.angles[door], `door ${door} at tick ${frame.tick}`).toBe(0);
      // První pootevření padne do tiku posunu (snímek s podílem), ne později.
      const opening = frames.find((frame) => frame.angles[door] !== 0)!;
      expect(opening.tick).toBe(changed!.tick);
      // Za `duration-celebrate` (420 ms ≈ 26 tiků) je otevřeno celé a zůstane tak.
      const late = frames.filter((frame) => frame.tick >= changed!.tick + 26);
      expect(late.length).toBeGreaterThan(0);
      for (const frame of late) expect(Math.abs(frame.angles[door]!)).toBeGreaterThan(1.3);
    }
    // Druhý cíl postoupí později než první: jeho dveře se v té chvíli ještě neotevřely.
    const first = frames.find((frame) => frame.states[0]! > 0)!;
    expect(first.states[1]).toBe(0);
    // Cíl stojí – otevírá se jen díl, tělo cíle se nehne.
    expect(frames.every((frame) => frame.still)).toBe(true);
  });

  it('under reduced motion the door is open at once in the tick of the change, without a tween', () => {
    const { frames } = playDoors(true);
    const changed = frames.find((frame) => frame.states[0]! > 0)!;
    const at = frames.filter((frame) => frame.tick === changed.tick);
    for (const frame of at) expect(Math.abs(frame.angles[0]!)).toBeGreaterThan(1.3);
    for (const frame of frames.filter((each) => each.tick < changed.tick)) expect(frame.angles[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Plavidlo plavby

const CRAFTS = [
  { name: 'boat (vehicle)', model: 'rowing-boat', world: () => worldOf(voyageRace.parts(1, voyageRace.params.parse({ terrain: 'islands' }), undefined)) },
  { name: 'shark (swimmer)', model: 'cc0-shark', world: () => worldOf(voyageRace.parts(1, voyageRace.params.parse({ terrain: 'islands' }), undefined)) },
  { name: 'lander (flyer)', model: 'gen3d-moon-lander', world: () => worldOf(voyageLand.parts(1, voyageLand.params.parse({}), undefined)) },
] as const;

/**
 * Plavba: `World` kreslí tělo plavidla (vnitřní skupina dostává hračkovou pózu třídy), `VoyageHero` po něm
 * přičte houpání a natočení k vnější skupině. `moving` = robot hraje; jinak stav stojí a běží jen tiky.
 * Hladina je rovná – vlnu kreslí moře, ne plavidlo.
 */
function playCraft(craft: (typeof CRAFTS)[number], moving: boolean, reduce = false): number[][] {
  stubPage(reduce);
  const world = craft.world();
  const layout = voyageLayoutOf(world);
  expect(layout).not.toBeNull();
  const program = loadProgram(world, ARCADE_LIBRARY);
  const byTick = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
  const state = instantiate(world);
  const prev = state.slice();
  const alpha = { value: 0 };
  const session = sessionOf(world, state, prev, alpha);
  const scene = new Group();
  hooks.scene = scene;
  hooks.frames = [];
  wire(World({ session, control: 'steer', cast: { player: craft.model, enemy: '', chaser: '', props: {} }, surface: { current: null }, scene: LOOKS.meadow, enabled: true, heroAction: 'none' }), scene);
  const drawWorld = hooks.frames.at(-1)!;
  // Plavba se připojí po `World` a její snímek běží po něm, jako za běhu.
  wire(VoyageHero({ session, layout: layout!, look: { water: color.sky } as never, waveAt: () => 0 }), scene);
  const drawCraft = hooks.frames.at(-1)!;
  expect(drawCraft).not.toBe(drawWorld);
  const hero = findGroup(scene, (node) => node.userData.frame === 'hero');
  const inner = findGroup(hero, (node) => node !== hero && node instanceof Group);
  const samples: number[][] = [];
  try {
    for (let tick = 0; tick < 150 && outcomeOf(state) === 'running'; tick += 1) {
      prev.set(state);
      if (moving) step(state, byTick.get(tick) ?? NO_INPUT, program);
      else state[HEADER.tick] = tick + 1;
      for (const part of [0, 0.5]) {
        alpha.value = part;
        drawWorld(undefined, 1 / 120);
        drawCraft(undefined, 1 / 120);
        samples.push([...sampleOf(hero), ...sampleOf(inner)]);
      }
    }
  } finally {
    releasePhysics(state);
  }
  return samples;
}

describe('the voyage craft moves by its body class and stands when it does not move (P45D T12)', () => {
  // P54B T6: mimo reduced-motion stojící letec dýchá vrstvou nečinnosti (výjimka brandu T1, `toy-motion.ts`);
  // přesné stání platí pod reduced-motion, kde je vrstva vypnutá.
  it.each(CRAFTS.map((craft) => [craft.name, craft] as const))('%s: a craft that does not move stands still on a calm sea under reduced motion', (_, craft) => {
    const samples = playCraft(craft, false, true);
    for (const sample of samples) expect(sample).toEqual(samples[0]);
  });

  it.each(CRAFTS.map((craft) => [craft.name, craft] as const))('%s: a craft that does not move only idles in place – no drift, no turn (P54B T6)', (_, craft) => {
    const samples = playCraft(craft, false);
    // Vnější skupina celá a vnitřní poloha x/z – nečinná vrstva smí jen vznášet, dýchat a vlnit tělo na místě.
    const fixed = (sample: readonly number[]): number[] => [...sample.slice(0, 9), sample[9]!, sample[11]!];
    for (const sample of samples) expect(fixed(sample)).toEqual(fixed(samples[0]!));
  });

  it.each(CRAFTS.map((craft) => [craft.name, craft] as const))('%s: a craft under way bobs or tilts', (_, craft) => {
    const samples = playCraft(craft, true);
    const [first] = samples;
    // Natočení a měřítko vnější i vnitřní skupiny (bez polohy – ta je hra, ne pohyb těla).
    const pose = (sample: readonly number[]): number[] => [...sample.slice(3, 9), ...sample.slice(9 + 3, 18)];
    expect(samples.some((sample) => pose(sample).some((value, i) => Math.abs(value - pose(first!)[i]!) > 1e-6))).toBe(true);
  });
});
