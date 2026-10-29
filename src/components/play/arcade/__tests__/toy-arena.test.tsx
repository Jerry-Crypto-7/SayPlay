/**
 * Hračkový pohyb bojovníků a pronásledovatelů v aréně (P45D T9). Co by vypadalo
 * živě a přitom bylo špatně: nepřítel, který v tiku zásahu hrdiny ucukne OD něj
 * (hračkový úder začíná nápřahem dozadu) – čte se jako útok, ale obráceně. A
 * hit-stop, který zastaví polohu, ale póza běží dál.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu jsou náhrada, `useFrame` se zachytí,
 * scéna se zavolá jako funkce a skupinám ze stromu se předají skutečné `Group`
 * zapojené pod sebe (vzor `toy-world.test.tsx`), ať jde změřit posun ve světě.
 */

import { type ReactElement, type ReactNode, isValidElement } from 'react';
import { Group, PerspectiveCamera, Vector3 } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, type ModeParts, NO_INPUT, ROLE, bodyBase, bodyHp } from '@/play/arcade/contract';
import { buildWorld, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { LOOKS, LOOK_IDS } from '@/play/arcade/look';
import { arenaEscape } from '@/play/arcade/pieces/arena';
import { fightArena } from '@/play/arcade/pieces/fight';

import { ArenaWorld } from '../arena/ArenaScene';
import { HIT_STOP_MS } from '../arena/FightFx';
import { bodiesOf, bodiesStale } from '../bodies';
import type { ArcadeSession } from '../session';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useContext: (context: { _currentValue: unknown }) => context._currentValue,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPage(): void {
  vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, performance });
}

function worldOf(seed: number, parts: ModeParts, health?: number): ArcadeWorld {
  const built = buildWorld({ seed, control: parts.control, rules: parts.rules, bot: parts.bot, level: parts.level, ...(health === undefined ? {} : { health }) }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Souboj (hit-stop, úder soupeře) a útěk se životy (chycení = zásah, pronásledovatel bez úderu). */
const WORLDS: Readonly<Record<string, () => ArcadeWorld>> = {
  fight: () => worldOf(1, fightArena.parts(1, fightArena.params.parse({}), undefined)),
  escape: () => worldOf(1, arenaEscape.parts(1, arenaEscape.params.parse({ chasers: 1 }), 3), 3),
};

/** Modely bez riggu: tělo kreslí `FittedModel` ve vnitřní skupině pózy. */
const CAST = { player: '', enemy: '', chaser: '', props: {} };
/** Snímek scény: 1/120 s, dva na tik. */
const FRAME_S = 1 / 120;

/** Kreslené tělo: vnější skupina (poloha) a vnitřní skupina pózy (vnější → otočení → náklon → póza). */
interface Drawn {
  readonly body: Group;
  readonly pose?: Group;
}

type Element = ReactElement<Record<string, unknown> & { ref?: (node: Group) => void }>;

/** Projde strom bez volání komponent; každá `<group ref>` dostane skutečnou skupinu pod nejbližší vyšší. */
function wire(node: ReactNode, parent: Group, found: Map<number, Drawn>, at?: { readonly index: number; readonly depth: number }): void {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) wire(child, parent, found, at);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as Element;
  let into = parent;
  let here = at;
  if (element.type === 'group' && typeof element.props.ref === 'function') {
    into = new Group();
    parent.add(into);
    element.props.ref(into);
    if (here === undefined && (element.props.userData as { frame?: string } | undefined)?.frame !== undefined) {
      here = { index: Number(element.key), depth: 0 };
      found.set(here.index, { body: into });
    } else if (here !== undefined) {
      here = { index: here.index, depth: here.depth + 1 };
      if (here.depth === 3) found.set(here.index, { ...found.get(here.index)!, pose: into });
    }
  }
  wire(element.props.children as ReactNode, into, found, here);
}

/** Aréna nad ručně tikaným jádrem; scéna se postaví znovu, když přibude tělo (probuzený pronásledovatel). */
function mount(world: ArcadeWorld) {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const prev = state.slice();
  let alpha = 0;
  const session = {
    world,
    state: () => state,
    prev: () => prev,
    advance: () => alpha,
    alpha: () => alpha, endedFor: () => 0,
    paused: () => false,
    humanRun: () => true,
    snapshot: () => ({ tick: 0, runState: 'running' }),
    subscribe: () => () => undefined,
    onEvents: () => () => undefined,
  } as unknown as ArcadeSession;
  const root = new Group();
  let drawn = new Map<number, Drawn>();
  let views = bodiesOf(session);
  const render = (): void => {
    hooks.frame = undefined;
    root.clear();
    const props = { session, half: 20_000, surface: { current: null }, look: LOOKS[LOOK_IDS[0]!]!, cast: CAST, heroAction: 'none' } as const;
    const styled = ArenaWorld(props) as ReactElement<typeof props>;
    drawn = new Map();
    wire((styled.type as (scene: typeof props) => ReactNode)(styled.props), root, drawn);
    views = bodiesOf(session);
    if (hooks.frame === undefined) throw new Error('the arena registered no frame');
  };
  render();
  return {
    state,
    prev,
    drawn: (index: number): Drawn | undefined => drawn.get(index),
    tick: (): void => {
      prev.set(state);
      step(state, NO_INPUT, program);
      if (bodiesStale(views, session)) render();
    },
    /** Jeden snímek s podílem `part`; scéna do stavu nesmí nic zapsat. */
    frame: (part: number): void => {
      alpha = part;
      const before = state.slice();
      hooks.frame!(undefined, FRAME_S);
      expect(state.some((value, slot) => value !== before[slot]), 'the scene wrote into the state').toBe(false);
      root.updateMatrixWorld(true);
    },
  };
}

type Run = ReturnType<typeof mount>;

/** Hrdina v posledním tiku přišel o HP (souboj) nebo o život (útěk). */
function hurt(run: Run): boolean {
  const player = run.state[HEADER.player] as number;
  const lives = HEADER.counters + COUNTER.health;
  return bodyHp(run.state, player) < bodyHp(run.prev, player) || (run.state[lives] as number) < (run.prev[lives] as number);
}

/** Hrdina stojí, hrozba přijde a udeří; vrátí běh ve chvíli po tiku zásahu (snímky ještě neběžely). */
function untilHurt(world: ArcadeWorld): Run {
  const run = mount(world);
  for (let tick = 0; tick < 3000 && outcomeOf(run.state) === 'running'; tick += 1) {
    run.tick();
    if (hurt(run)) return run;
    run.frame(0);
    run.frame(0.5);
  }
  throw new Error('the threat never hurt the standing hero');
}

/** Nejbližší viditelná hrozba (nepřítel, pronásledovatel) u hrdiny. */
function nearestThreat(run: Run): number {
  const player = run.state[HEADER.player] as number;
  const hero = run.drawn(player)!.body.position;
  let best = -1;
  let gap = Infinity;
  for (let index = 0; index < (run.state[HEADER.bodyCount] as number); index += 1) {
    const base = bodyBase(index);
    const role = run.state[base + BODY.role] as number;
    if ((role !== ROLE.enemy && role !== ROLE.chaser) || ((run.state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const body = run.drawn(index)?.body;
    if (body === undefined || !body.visible) continue;
    const distance = Math.hypot(body.position.x - hero.x, body.position.z - hero.z);
    if (distance < gap) {
      gap = distance;
      best = index;
    }
  }
  return best;
}

/** Posun vnitřní skupiny pózy ve světě vůči skupině nad ní (výpad), jen vodorovně. */
function lungeOf(pose: Group): Vector3 {
  const at = pose.getWorldPosition(new Vector3());
  const from = pose.parent!.getWorldPosition(new Vector3());
  return at.sub(from).setY(0);
}

const sampleOf = (pose: Group): readonly number[] => [...pose.position.toArray(), pose.rotation.x, pose.rotation.y, pose.rotation.z, ...pose.scale.toArray(), pose.visible ? 1 : 0];

describe('toy motion for arena fighters and chasers (P45D T9)', () => {
  it.each(Object.keys(WORLDS))('%s: the threat that hurts the hero lunges toward him on that tick, not away', (name) => {
    stubPage();
    const run = untilHurt(WORLDS[name]!());
    run.frame(0);
    const threat = nearestThreat(run);
    expect(threat, `${name}: no threat next to the hero`).toBeGreaterThanOrEqual(0);
    const { body, pose } = run.drawn(threat)!;
    expect(pose, `${name}: the threat has no pose group`).toBeDefined();
    // Výpad po lokálním +z otočené skupiny = `lunge` > 0.
    expect(pose!.position.z).toBeGreaterThan(0);
    const hero = run.drawn(run.state[HEADER.player] as number)!.body.position;
    const toward = new Vector3(hero.x - body.position.x, 0, hero.z - body.position.z).normalize();
    const lunge = lungeOf(pose!);
    expect(lunge.length()).toBeGreaterThan(0.05);
    expect(lunge.normalize().dot(toward), `${name}: lunge points away from the hero`).toBeGreaterThan(0.5);
  });

  it('fight: the hit-stop keeps every fighter in the pose of the hit, then lets the pose run on', () => {
    stubPage();
    const run = untilHurt(WORLDS.fight!());
    const fighters = [run.state[HEADER.player] as number, nearestThreat(run)].map((index) => run.drawn(index)!.pose!);
    // Snímek, který zásah zachytil, pózu ještě spočítá (výpad v tiku zásahu); dál stojí, dokud hit-stop drží naplno.
    run.frame(0);
    const hit = fighters.map(sampleOf);
    const held = Math.ceil(HIT_STOP_MS / (FRAME_S * 1000)) - 1;
    const after: (readonly number[])[][] = [];
    for (let frame = 1; frame <= held + 16; frame += 1) {
      if (frame % 2 === 0) run.tick();
      run.frame(frame % 2 === 0 ? 0 : 0.5);
      after.push(fighters.map(sampleOf));
    }
    // Tiky mezitím běží (jádro hit-stop nezná) – bez držení by se výpad a zásah posunuly.
    for (const [k, sample] of after.slice(0, held).entries()) expect(sample, `frame ${k + 1} of the hit-stop`).toEqual(hit);
    expect(after.slice(held).some((sample) => JSON.stringify(sample) !== JSON.stringify(hit)), 'the pose never moved on after the hit-stop').toBe(true);
  });
});
