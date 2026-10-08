/**
 * Hračkový pohyb bojovníků souboje s modelem (P45D T10). Úder bez výpadu k soupeři
 * vypadá jako pohyb a neříká „zasáhl jsem“ – a soupeř hledí opačně, takže jeho výpad
 * musí jít po −z, ne za hrdinou po +z. Panák z primitiv si nechává dnešní přikrčení,
 * náklon a ruku.
 *
 * Vzor `toy-world.test.tsx`: háčky Reactu jsou náhrada, `useFrame` se zachytí, scéna se
 * zavolá jako funkce a skupinám ze stromu se předají skutečné `Group` přes jejich `ref`.
 */

import { type ReactElement, type ReactNode, createElement, isValidElement } from 'react';
import { Group, MeshStandardMaterial, PerspectiveCamera } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

import flapFixture from '@/play/arcade/__fixtures__/flap.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, HEADER, NO_INPUT, UNIT, bodyBase } from '@/play/arcade/contract';
import { hashArcade, instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { DUEL, DUEL_FOE, DUEL_PHASE } from '@/play/arcade/pieces/duel';
import { runBot } from '@/play/arcade/verify';
import type { GameSpecV1 } from '@/play/spec';

import { DuelScene } from '../duel/DuelScene';
import type { ArcadeSession } from '../session';

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
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

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPage(search: string): void {
  vi.stubGlobal('window', { location: { search }, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, performance });
}

/** Souboj na šabloně poletování (jako `duel.test.ts`) – kompilátor čte jen `control` a parametry. */
function duelWorld(): ArcadeWorld {
  const made = arcadeWorldOf({ ...(flapFixture as GameSpecV1), control: 'duel', controlParams: { difficulty: 'normal' } }, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Skupiny bojovníka: první skupina s `ref` pod záběrem je tělo (skupina pózy), druhá ruka. */
interface Rig {
  body?: Group;
  arm?: Group;
}
type Element = ReactElement<Record<string, unknown> & { ref?: { current: unknown } }>;
/** Komponenty scény, které test zavolá; ostatní (akce hrdiny `none`, duch, obrys, kulisy) projde jen do dětí. */
const CALLED = new Set(['Figure', 'ModelFigure', 'Arm']);

function wire(node: ReactNode, rigs: Record<string, Rig>, frame?: string): void {
  if (Array.isArray(node)) {
    for (const child of node as ReactNode[]) wire(child, rigs, frame);
    return;
  }
  if (!isValidElement(node)) return;
  const { type, props } = node as Element;
  if (typeof type === 'function') {
    wire(CALLED.has(type.name) ? (type as (props: unknown) => ReactNode)(props) : (props.children as ReactNode), rigs, frame);
    return;
  }
  const at = (props.userData as { frame?: string } | undefined)?.frame ?? frame;
  const ref = props.ref;
  if (type === 'group' && ref !== undefined && ref !== null && at !== undefined) {
    const group = new Group();
    ref.current = group;
    const rig = (rigs[at] ??= {});
    if (rig.body === undefined) rig.body = group;
    else rig.arm = group;
  }
  if (type === 'meshStandardMaterial' && ref !== undefined && ref !== null) ref.current = new MeshStandardMaterial();
  wire(props.children as ReactNode, rigs, at);
}

/** Póza skupiny po snímku: poloha, natočení, měřítko. */
const poseOf = (group: Group) => ({ position: group.position.toArray(), rotation: [group.rotation.x, group.rotation.y, group.rotation.z], scale: group.scale.toArray() });

interface Sample {
  readonly tick: number;
  /** Úder hráče v mezeře v tomhle tiku. */
  readonly struck: boolean;
  readonly phase: number;
  readonly prevPhase: number;
  readonly left: number;
  readonly playerH: number;
  readonly timer: number;
  readonly hero: ReturnType<typeof poseOf>;
  readonly rival: ReturnType<typeof poseOf>;
  readonly heroArm?: number;
  readonly rivalArm?: number;
}

/** Robot hraje souboj do konce; po každém tiku dva snímky scény (podíl 0 a 0,5), každý ověří, že scéna nic nezapsala. */
function play(world: ArcadeWorld, models: boolean): { readonly samples: Sample[]; readonly rigs: Record<string, Rig>; readonly hash: string } {
  const program = loadProgram(world, ARCADE_LIBRARY);
  const byTick = new Map(runBot(world).inputs.map((event) => [event.tick, event]));
  const state = instantiate(world);
  const prev = state.slice();
  let alpha = 0;
  const session = { world, state: () => state, prev: () => prev, advance: () => alpha, alpha: () => alpha, endedFor: () => 0 } as unknown as ArcadeSession;
  const model = () => createElement('mesh');
  hooks.frame = undefined;
  const rigs: Record<string, Rig> = {};
  wire(DuelScene({ session, look: { ground: '#78716c' } as never, heroModel: models ? model : undefined, rivalModel: models ? model : undefined, heroAction: 'none' }), rigs);
  const { hero, target } = rigs;
  // Scéna `useFrame` zachytila až při volání – kontrola toku by po `= undefined` výš viděla `never`.
  const frame = hooks.frame as Frame | undefined;
  if (hero?.body === undefined || target?.body === undefined || frame === undefined) throw new Error('no fighter groups or frame');
  const samples: Sample[] = [];
  const f = bodyBase(DUEL_FOE);
  for (let tick = 0; tick < 3000 && outcomeOf(state) === 'running'; tick += 1) {
    prev.set(state);
    step(state, byTick.get(tick) ?? NO_INPUT, program);
    const p = bodyBase(state[HEADER.player] as number);
    for (const part of [0, 0.5]) {
      alpha = part;
      const before = state.slice();
      frame(undefined, 1 / 120);
      if (state.some((value, slot) => value !== before[slot])) throw new Error(`the scene wrote into the state at tick ${tick}`);
      samples.push({
        tick: state[HEADER.tick] as number,
        struck: (state[p + BODY.aux0] as number) > 0,
        phase: state[f + BODY.aux0] as number,
        prevPhase: prev[f + BODY.aux0] as number,
        left: state[f + BODY.aux1] as number,
        playerH: state[p + BODY.h] as number,
        timer: state[p + BODY.aux1] as number,
        hero: poseOf(hero.body),
        rival: poseOf(target.body),
        heroArm: hero.arm?.rotation.x,
        rivalArm: target.arm?.rotation.x,
      });
    }
  }
  return { samples, rigs, hash: hashArcade(state) };
}

const HERO_H = DUEL.playerH / UNIT;
/** Celý útok hračkového pohybu (nápřah – výpad – dojezd, 0,36 s) v tikách. */
const ATTACK_TICKS = 22;

/** Posun skupiny po z během útoku od tiku `from`; `null`, když běh skončil dřív, než útok doběhl. */
function lungeAfter(samples: readonly Sample[], from: number, fighter: 'hero' | 'rival'): number[] | null {
  const span = samples.filter((sample) => sample.tick >= from && sample.tick < from + ATTACK_TICKS);
  return span.length < 2 * ATTACK_TICKS ? null : span.map((sample) => sample[fighter].position[2]! + 0);
}

const indexOfExtreme = (values: readonly number[], pick: (a: number, b: number) => boolean): number => values.reduce((best, value, index) => (pick(value, values[best]!) ? index : best), 0);

describe('toy motion for duel fighters with a model (P45D T10)', () => {
  it('a strike lunges at the opponent: the hero along +z, the rival (turned to face it) along −z', () => {
    stubPage('');
    const world = duelWorld();
    const { samples, rigs, hash } = play(world, true);
    // Hrdina s modelem nemá ruku z primitiv, soupeř ano – nese barvu fáze.
    expect(rigs.hero?.arm).toBeUndefined();
    expect(rigs.target?.arm).toBeDefined();

    const strikes = [...new Set(samples.filter((sample) => sample.struck).map((sample) => sample.tick))];
    const blows = [...new Set(samples.filter((sample) => sample.phase === DUEL_PHASE.open && sample.prevPhase === DUEL_PHASE.windup).map((sample) => sample.tick))];
    let checked = 0;
    for (const from of strikes) {
      const z = lungeAfter(samples, from, 'hero');
      if (z === null) continue;
      checked += 1;
      // Nápřah dozadu, pak výpad k soupeři: nejdál k soupeři je až po nejhlubším nápřahu.
      expect(Math.max(...z), `hero strike at ${from}`).toBeGreaterThan(0.2 * HERO_H);
      expect(indexOfExtreme(z, (a, b) => a > b), `hero strike at ${from}`).toBeGreaterThan(indexOfExtreme(z, (a, b) => a < b));
    }
    for (const from of blows) {
      const z = lungeAfter(samples, from, 'rival');
      if (z === null) continue;
      checked += 1;
      expect(Math.min(...z), `rival blow at ${from}`).toBeLessThan(-0.2 * HERO_H);
      expect(indexOfExtreme(z, (a, b) => a < b), `rival blow at ${from}`).toBeGreaterThan(indexOfExtreme(z, (a, b) => a > b));
    }
    expect(checked).toBeGreaterThanOrEqual(4);
    for (const sample of samples) {
      expect(sample.hero.position[0]).toBeCloseTo(0, 9);
      expect(sample.rival.position[0]).toBeCloseTo(0, 9);
    }
    // Úhyb s modelem = přikrčení na výšku jádra (zmáčknutí), nikdy jen natažení.
    expect(samples.some((sample) => sample.playerH === DUEL.crouchH && sample.hero.scale[1]! < 0.6)).toBe(true);
    expect(hash).toBe(play(world, false).hash);
  });

  it('a figure without a model keeps the kernel crouch, the stagger lean and the hand-made arm, and never lunges', () => {
    stubPage('');
    const { samples } = play(duelWorld(), false);
    let lastStrike = -10;
    for (const sample of samples) {
      if (sample.struck) lastStrike = sample.tick;
      const at = `tick ${sample.tick}`;
      expect(sample.hero.position, at).toEqual([0, 0, 0]);
      expect(sample.rival.position, at).toEqual([0, 0, 0]);
      expect(sample.hero.scale, at).toEqual([1, sample.playerH / UNIT / HERO_H, 1]);
      expect(sample.hero.rotation[0], at).toBe(sample.timer < -DUEL.cooldown ? 0.25 : 0);
      expect(sample.heroArm, at).toBe(sample.tick - lastStrike < 10 ? -Math.PI / 2 : -0.2);
      expect(sample.rival.rotation[0], at).toBe(sample.phase === DUEL_PHASE.open ? -0.2 : sample.phase === DUEL_PHASE.windup ? 0.12 : 0);
      expect(sample.rivalArm, at).toBe(sample.phase === DUEL_PHASE.windup ? (sample.left <= 4 ? Math.PI / 2 : -Math.PI * 0.8) : sample.phase === DUEL_PHASE.open ? 0.1 : 0);
    }
    expect(samples.some((sample) => sample.hero.scale[1]! < 1)).toBe(true);
    expect(samples.some((sample) => sample.heroArm === -Math.PI / 2)).toBe(true);
  });
});
