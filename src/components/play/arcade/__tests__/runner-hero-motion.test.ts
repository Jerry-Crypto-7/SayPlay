/**
 * Pohyb hrdiny běžce (P32A T5, P45D T8): co oko na snímku nepozná. Náklon do
 * úhybu přijde do 150 ms na správnou stranu a zase povolí – u každé třídy těla
 * stejně, krok k němu kolébání nepřidá (živý krok by změnu pruhu přebil);
 * čtyřnohý hrdina se v běhu kolébá předklonem tam a zpět; skok je hračkový skok
 * třídy, jízda jede bez kroků a pohyb do hry nesáhne – replay má s ním i bez něj
 * tentýž hash. Na kresleném hrdinovi (`World` + `HeroPose`) póza hrdiny tu, kterou
 * mu dal `World`, nahradí – nesečte se s ní.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu jsou náhrada, `useFrame` se zachytí a
 * komponenty se volají jako funkce (vzor `toy-world.test.tsx`).
 */

import { Fragment, type ReactElement, type ReactNode, isValidElement } from 'react';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type Object3D, PerspectiveCamera, Scene } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import fixture from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, BUTTON, HEADER, type InputEvent, NO_INPUT, UNIT, bodyBase } from '@/play/arcade/contract';
import { LOOKS } from '@/play/arcade/look';
import { hashArcade, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { BODY_CLASSES, type BodyClass, type ToyPose, toyPoseOf, toyViewOf } from '@/play/arcade/toy-motion';
import { runBot } from '@/play/arcade/verify';
import { readGameSpec } from '@/play/spec';

import { HeroActionBody } from '../hero-action/HeroActionBody';
import { type Ride, blinksOnHit, createHeroMotion, HERO_MOTION, rideOf } from '../runner/heroMotion';
import { RunnerWorld } from '../runner/RunnerWorld';
import { type ArcadeSession, createArcadeSession } from '../session';
import { applyToy } from '../toy/applyToy';
import { bodyClassOf } from '../toy/body-class';
import { FittedModel, fitModel, World } from '../World';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
    useMemo: (make: () => unknown) => make(),
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
    select({ camera: new PerspectiveCamera(60, 9 / 16, 0.1, 120), size: { width: 412, height: 839 }, scene: hooks.scene, get: () => undefined }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function worldOf(): ArcadeWorld {
  const spec = readGameSpec(fixture);
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const world = worldOf();
const DEG = 180 / Math.PI;
/** 150 ms v tikách jádra. */
const LEAN_DEADLINE_TICKS = Math.floor((150 * ARCADE_HZ) / 1000);

/** Kolikrát posloupnost změní znaménko (hodnoty blízko nuly se nepočítají). */
function signFlips(values: readonly number[], above: number): number {
  const signs = values.filter((value) => Math.abs(value) > above).map(Math.sign);
  return signs.filter((sign, index) => index > 0 && sign !== signs[index - 1]).length;
}

/** Hráč „ručně“ zahraje záznam tik po tiku (postup z `effects.test.ts`); `each` běží po každém tiku. */
function playByHand(session: ArcadeSession, inputs: readonly InputEvent[], each: () => void = () => undefined): void {
  let next = 0;
  for (let tick = 0; tick < 90 * 60 && session.snapshot().runState === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    if (event !== undefined && event.tick === tick) {
      session.hold(event.axis);
      session.press(event.buttons);
    } else session.hold(0);
    session.stepOnce();
    each();
  }
}

/** Relace po `ticks` tikách běhu bez vstupu, s pohybem, který se čte každý tik; `clock.alpha` je podíl rozběhnutého tiku. */
function running(ticks: number, ride: Ride = null, body: BodyClass = 'biped') {
  const session = createArcadeSession(world);
  const clock = { alpha: 0 };
  const motion = createHeroMotion({ state: () => session.state(), prev: () => session.prev(), alpha: () => clock.alpha, endedFor: () => 0 }, ride, body);
  for (let i = 0; i < ticks; i += 1) {
    session.stepOnce();
    motion.sample();
  }
  return { session, motion, clock };
}

describe('runner hero motion (P32A T5, P45D T8)', () => {
  it('leans into a dodge within 150 ms, towards the side it moves, then straightens', () => {
    for (const [button, sign] of [
      [BUTTON.RIGHT, 1],
      [BUTTON.LEFT, -1],
    ] as const) {
      const { session, motion } = running(5);
      expect(motion.sample().roll).toBe(0);
      session.press(button);
      let leaned: number | null = null;
      let most = 0;
      for (let tick = 1; tick <= 40; tick += 1) {
        session.stepOnce();
        const roll = motion.sample().roll * DEG;
        most = Math.max(most, Math.abs(roll));
        if (leaned === null && Math.abs(roll) > 5) {
          leaned = tick;
          // Náklon jde tam, kam hráč uhýbá: „RIGHT“ je na obrazovce vpravo, to je scéna −x a hlava k −x = + roll.
          expect(Math.sign(roll), `strana náklonu pro tlačítko ${button}`).toBe(sign);
        }
      }
      expect(leaned, 'tik, ve kterém náklon přešel 5°').not.toBeNull();
      expect(leaned!).toBeLessThanOrEqual(LEAN_DEADLINE_TICKS);
      expect(most).toBeLessThanOrEqual(HERO_MOTION.leanMax * DEG + 1e-9);
      expect(most, 'plný náklon je znát').toBeGreaterThan(10);
      // Pruh je hotový za 8 tiků; o 32 tiků později tělo stojí rovně.
      expect(Math.abs(motion.sample().roll * DEG)).toBeLessThan(0.5);
    }
  });

  it('still leans when the whole lane change happens between two frames', () => {
    // Zaseknutý snímek (načítání modelu, telefon): relace dotiká 9 tiků najednou a změna pruhu (8 tiků) je hotová.
    const { session, motion } = running(5);
    session.press(BUTTON.RIGHT);
    for (let tick = 0; tick < 9; tick += 1) session.stepOnce();
    expect(motion.sample().roll * DEG).toBeGreaterThan(5);
  });

  it('keeps the lane lean of every body class – the toy step adds no roll that would blur it', () => {
    const leanOf = (body: BodyClass) => {
      const { session, motion, clock } = running(5, null, body);
      const player = session.state()[HEADER.player] as number;
      const rolls: number[] = [];
      let raw: ToyPose | null = null;
      let rawRoll = 0;
      session.press(BUTTON.RIGHT);
      for (let tick = 0; tick < 40; tick += 1) {
        if (tick === 20) session.press(BUTTON.LEFT);
        session.stepOnce();
        for (const part of [0, 0.5]) {
          clock.alpha = part;
          const sample = motion.sample();
          rolls.push(sample.roll);
          expect(sample.toy.roll, `${body}: kolébání kroku`).toBe(0);
          raw = toyPoseOf(toyViewOf(session.state(), session.prev(), player), body, raw, (session.state()[HEADER.tick] as number) + part, false);
          rawRoll = Math.max(rawRoll, Math.abs(raw.roll));
        }
      }
      return { rolls, rawRoll };
    };
    const biped = leanOf('biped');
    // Hračkový krok dvounohého hrdiny sám kolébá kolem směru běhu – bez téhle úpravy by se přičetl k úhybu.
    expect(biped.rawRoll).toBeGreaterThan(0.05);
    expect(Math.max(...biped.rolls) * DEG, 'úhyb doprava').toBeGreaterThan(10);
    expect(Math.min(...biped.rolls) * DEG, 'úhyb doleva').toBeLessThan(-10);
    for (const body of BODY_CLASSES) expect(leanOf(body).rolls, body).toEqual(biped.rolls);
  });

  it('rocks a quadruped runner hero: its pitch alternates sign while it runs', () => {
    const { session, motion, clock } = running(5, null, 'quadruped');
    const pitches: number[] = [];
    for (let tick = 0; tick < 60; tick += 1) {
      session.stepOnce();
      for (const part of [0, 0.5]) {
        clock.alpha = part;
        pitches.push(motion.sample().toy.pitch);
      }
    }
    expect(Math.max(...pitches)).toBeGreaterThan(0.05);
    expect(Math.min(...pitches)).toBeLessThan(-0.05);
    expect(signFlips(pitches, 0.02)).toBeGreaterThanOrEqual(4);
  });

  it('jumps the toy way: stretched in the air, squashed on landing, never stretched on the ground', () => {
    const { session, motion } = running(5);
    const height = (): number => 1 - motion.sample().toy.squash;
    expect(height(), 'běh po rovině').toBe(1);
    session.press(BUTTON.TAP);
    const curve: { scale: number; grounded: boolean }[] = [];
    for (let tick = 0; tick < 60; tick += 1) {
      session.stepOnce();
      curve.push({ scale: height(), grounded: motion.sample().toy.grounded });
    }
    const air = curve.findIndex((sample) => !sample.grounded);
    const land = curve.findIndex((sample, index) => index > air && sample.grounded);
    expect(air, 'odraz hned v tiku stisku').toBe(0);
    expect(land, 'dopad').toBeGreaterThan(air);
    expect(Math.max(...curve.slice(air, air + 10).map((sample) => sample.scale)), 'výskok natažený').toBeGreaterThan(1.1);
    expect(curve[land]!.scale, 'dopad zmáčknutý').toBeLessThan(0.9);
    expect(curve.at(-1)!.scale).toBe(1);
    // Na zemi se tělo nikdy nenatáhne: po dopadu jen povoluje zmáčknutí.
    expect(curve.filter((sample) => sample.grounded).every((sample) => sample.scale <= 1)).toBe(true);
  });

  it('picks the ride pose for a bird hero, a riding sentence (theme.motion) or a riding model', () => {
    // Tučňák z věty P32 (`genre/runner.ts` → hrdina `penguin`) a ptáci katalogu jedou na břiše – i když věta klouže.
    for (const hero of ['penguin', 'bird', 'gen3d-bald-eagle', 'cc0-chicken']) expect(rideOf(hero), hero).toBe('lie');
    expect(rideOf('penguin', true)).toBe('lie');
    // Věta, která klouže nebo lyžuje (`genre/runner.ts` → `theme.motion: 'ride'` → `sceneLook`), dá předklon každému hrdinovi.
    for (const hero of ['rigged:girl-a', 'explorer', 'fox']) expect(rideOf(hero, true), hero).toBe('board');
    for (const hero of ['cc0-sled', 'gen3d-skateboard']) expect(rideOf(hero), hero).toBe('board');
    // Běžec, dítě a zvíře bez jízdy ve větě běží.
    for (const hero of ['explorer', 'rigged:boy-a', 'rigged:knight', 'fox', 'robot']) expect(rideOf(hero), hero).toBeNull();

    // Vleže musí být předklon i s během přes 60° – kolem 45° z kamery běžce vypadá jako stání.
    const lie = running(5, 'lie', 'flyer').motion.sample();
    const board = running(5, 'board').motion.sample();
    const run = running(5).motion.sample();
    expect(lie.pitch * DEG).toBeGreaterThan(55);
    expect(board.pitch * DEG).toBeGreaterThan(20);
    expect(board.pitch).toBeLessThan(lie.pitch);
    expect(run.pitch).toBe(0);
  });

  it('rides without steps: no hop and no stride, while a bird on its belly still flaps', () => {
    const steps = (ride: Ride, body: BodyClass) => {
      const { session, motion } = running(5, ride, body);
      const poses: ToyPose[] = [];
      for (let tick = 0; tick < 60; tick += 1) {
        session.stepOnce();
        poses.push(motion.sample().toy);
      }
      return poses;
    };
    expect(steps(null, 'biped').some((pose) => pose.hop > 0.02), 'běžec poskakuje').toBe(true);
    for (const pose of [...steps('board', 'biped'), ...steps('lie', 'flyer')]) expect([pose.hop, pose.stride]).toEqual([0, 0]);
    expect(steps('lie', 'flyer').some((pose) => Math.abs(pose.flap) > 0.5), 'pták mává').toBe(true);
  });

  it('blinks on a hit only for a rigged hero whose manifest has no hit clip', () => {
    expect(blinksOnHit('rigged:boy-a')).toBe(true);
    expect(blinksOnHit('rigged:knight')).toBe(false);
    // Statický model bliká přes hračkovou pózu ve `World`; druhé bliknutí by se s ní pralo.
    expect(blinksOnHit('penguin')).toBe(false);
  });

  it('motion on and off give the same replay hash and never touch the state', () => {
    const watched = createArcadeSession(world);
    const plain = createArcadeSession(world);
    const inputs = watched.botInputs();
    const motion = createHeroMotion(watched, 'lie', 'flyer');
    let leaned = 0;
    let flapped = 0;
    let wrote = false;
    // Porovnání po prvcích: hluboké `toEqual` každý tik trvalo ~16 s a pod zátěží přetékalo 30 s.
    const same = (a: Int32Array, b: Int32Array): boolean => a.length === b.length && a.every((value, slot) => value === b[slot]);
    playByHand(watched, inputs, () => {
      const state = Int32Array.from(watched.state());
      const prev = Int32Array.from(watched.prev());
      const sample = motion.sample();
      if (Math.abs(sample.roll) > 0.05) leaned += 1;
      if (Math.abs(sample.toy.flap) > 0.05) flapped += 1;
      wrote ||= !same(watched.state(), state) || !same(watched.prev(), prev);
    });
    playByHand(plain, inputs);

    expect(wrote, 'pohyb zapsal do stavu').toBe(false);
    expect(watched.snapshot().runState).toBe('won');
    // Robot uhýbá a běží – pohyb se opravdu počítal.
    expect(leaned).toBeGreaterThan(0);
    expect(flapped).toBeGreaterThan(0);
    expect(hashArcade(watched.state())).toBe(hashArcade(plain.state()));
    expect(watched.inputs()).toEqual(plain.inputs());
  });
});

type Element = ReactElement<Record<string, unknown> & { ref?: ((node: Group) => void) | { current: unknown } }>;

/** Póza skupiny: poloha, natočení, měřítko (−0 jako 0). */
type Sample = readonly number[];
const sampleOf = (group: Object3D): Sample => [...group.position.toArray(), group.rotation.x, group.rotation.y, group.rotation.z, ...group.scale.toArray()].map((value) => value + 0);

/** Náhrada okna nese i `performance` (vzor `toy-world.test.tsx`). */
function stubPage(): void {
  vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, performance });
}

/** Model, jak ho `FittedModel` role, která se hýbe, po načtení vloží do vnitřní skupiny pózy. */
function loaded({ id, w, h, d, character }: Record<string, unknown>): Object3D {
  const model = new Group().add(new Mesh(new BoxGeometry(0.4, 1, 0.6), new MeshStandardMaterial({ color: '#a16207' })));
  return fitModel(model, { id: id as string, w: w as number, h: h as number, d: d as number, character: character === true, posed: true });
}

/** Ze stromu elementů postaví skutečné skupiny pod `parent`: `<group>` se svým `userData` a `ref`, model role, která se hýbe, jako načtený. */
function build(node: ReactNode, parent: Object3D): void {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) build(child, parent);
    return;
  }
  if (!isValidElement(node)) return;
  const { type, props } = node as Element;
  if (type === 'group') {
    const group = new Group();
    Object.assign(group.userData, props.userData);
    if (typeof props.ref === 'function') props.ref(group);
    parent.add(group);
    build(props.children as ReactNode, group);
  } else if (type === FittedModel) {
    if (props.posed === true) parent.add(loaded(props));
  } else if (type === Fragment || type === HeroActionBody) build(props.children as ReactNode, parent);
}

interface Drawn {
  /** Náklon obalu hrdiny (úhyb). */
  readonly roll: number;
  /** Póza vnitřní skupiny, jak ji scéna nakreslila. */
  readonly inner: Sample;
  /** Jedna aplikace hrdinovy hračkové pózy na čistou skupinu. */
  readonly once: Sample;
}

/** Robot hraje běžce s hrdinou `player`; po každém tiku dva snímky (podíl 0 a 0,5). Bez `heroPose` kreslí jen `World`. */
function drawn(player: string, heroPose: boolean, ticks = 240): Drawn[] {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const byTick = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
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
  const scene = new Scene();
  hooks.frames = [];
  hooks.scene = scene;
  const cast = { player, enemy: '', chaser: '', props: {} };
  const top = RunnerWorld({ session, cast, surface: { current: null }, scene: LOOKS.meadow, enabled: true, heroAction: 'none' }) as Element;
  const parts = top.props.children as Element[];
  // `World` se přihlásí ke snímku první, `HeroPose` po něm – jako sourozenci v R3F.
  build((World as (props: unknown) => ReactNode)(parts.find((part) => part.type === World)!.props), scene);
  if (heroPose) {
    const pose = parts.find((part) => typeof part.type === 'function' && part.type.name === 'HeroPose')!;
    const shadow = (pose.type as (props: unknown) => Element)(pose.props);
    (shadow.props.ref as { current: unknown }).current = new Mesh();
  }
  const outer = scene.children.find((node) => node.userData.frame === 'hero')!;
  const inner = outer.children[0]!;
  const expected = createHeroMotion(session, null, bodyClassOf(player));
  const h = (state[bodyBase(state[HEADER.player] as number) + BODY.h] as number) / UNIT;
  const samples: Drawn[] = [];
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) {
    prev.set(state);
    step(state, byTick.get(tick) ?? NO_INPUT, program);
    for (const part of [0, 0.5]) {
      alpha = part;
      for (const frame of hooks.frames) frame(undefined, 1 / 120);
      const once = new Group();
      applyToy({ group: once }, expected.sample().toy, h);
      samples.push({ roll: outer.rotation.z, inner: sampleOf(inner), once: sampleOf(once) });
    }
  }
  return samples;
}

describe('the runner hero as drawn (World + HeroPose, P45D T8)', () => {
  it('replaces the toy pose World gave the hero instead of adding to it, so the lane lean reads alone', () => {
    stubPage();
    const frames = drawn('explorer', true);
    expect(frames.some((frame) => Math.abs(frame.roll) * DEG > 5), 'robot mění pruh').toBe(true);
    // Vnitřní skupina nese přesně jednu hrdinovu pózu: žádný dvojí poskok, žádné kolébání kroku navíc k úhybu.
    for (const frame of frames) expect(frame.inner).toEqual(frame.once);
    // Bez `HeroPose` by dvounohý hrdina kolébal kolem směru běhu (póza `World`).
    expect(drawn('explorer', false).some((frame) => Math.abs(frame.inner[5]!) > 0.05)).toBe(true);
  });

  it('a dog hero drawn by the runner rocks: its pitch alternates sign', () => {
    stubPage();
    const pitches = drawn('dog', true, 120).map((frame) => frame.inner[3]!);
    expect(Math.max(...pitches)).toBeGreaterThan(0.05);
    expect(Math.min(...pitches)).toBeLessThan(-0.05);
    expect(signFlips(pitches, 0.02)).toBeGreaterThanOrEqual(4);
  });
});
