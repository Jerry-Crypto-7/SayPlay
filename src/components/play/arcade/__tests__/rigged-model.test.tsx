/**
 * Riggovaná postava doplní stavy bez klipu hračkovým pohybem (P45D T13).
 * Poskok navrch klipu běhu vypadá živě – postava ale „dvojitě skáče“ a sada
 * by zůstala zelená; zvířátko bez klipu smrti, které po smrti stojí, vypadá
 * jako postava v klidu. Proto test drží obojí: klip má přednost, chybějící
 * stav dohraje hračka.
 *
 * Repo nemá vykreslovač R3F: háčky Reactu jsou náhrada, `useFrame` se zachytí,
 * `RiggedModel` se zavolá jako funkce s hned načteným modelem a jeho skupině
 * se přes `ref` předá skutečná `Group`.
 */

import type { ReactElement, RefObject } from 'react';
import { type AnimationAction, AnimationClip, AnimationMixer, Group } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ARCADE_HZ, UNIT } from '@/play/arcade/contract';
import type { RiggedCharacter } from '@/play/arcade/models';
import type { ClipState } from '@/play/arcade/motion';
import type { ToyView } from '@/play/arcade/toy-motion';

import { FALL_S } from '../characterMotion';
import { RiggedModel, type ToyFrame } from '../RiggedModel';

type Frame = (state: unknown, delta: number) => void;
const hooks = vi.hoisted(() => ({ gltf: undefined as unknown, frame: undefined as Frame | undefined }));

vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>();
  return {
    ...react,
    // Model je už načtený: jediný stav komponenty (`gltf`) začíná hotovým modelem.
    useState: () => [hooks.gltf, () => undefined],
    useMemo: (make: () => unknown) => make(),
    useRef: (current: unknown) => ({ current }),
    useEffect: () => undefined,
  };
});
vi.mock('@react-three/fiber', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@react-three/fiber')>()),
  useFrame: (frame: Frame) => {
    hooks.frame = frame;
  },
}));

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' }, matchMedia: () => ({ matches: false }), performance });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Kenney rytíř: klip na každý stav. */
const KNIGHT: Partial<Record<ClipState, string>> = { idle: 'Idle', run: 'Running_A', jump: 'Jump_Idle', shoot: 'Chop', hit: 'Hit_A', die: 'Death_A' };
/** Zvířátko P32: jen klid a běh, zbytek `procedural`. */
const PET: Partial<Record<ClipState, string>> = { idle: 'idle', run: 'run', jump: 'procedural', hit: 'procedural', die: 'procedural' };

const STILL: ToyView = { vx: 0, vy: 0, vz: 0, grounded: true, alive: true, hit: false, shot: false, won: false, carrying: false, attack: false, turn: 0, opened: false };
/** 3 m/s dopředu – chůze naplno. */
const RUNNING: ToyView = { ...STILL, vz: (3 * UNIT) / ARCADE_HZ };

interface Shot {
  readonly y: number;
  readonly z: number;
  readonly pitch: number;
  readonly roll: number;
  readonly scaleY: number;
}

/**
 * Postava `id` s klipy `clips` hraje `ticks` tiků po dvou snímcích (podíl 0 a 0,5);
 * pohled těla v tiku dává `views`, stav klipu `clipOf`, posunutý začátek úderu `attackAt`
 * (jako aréna). Vrací pózu skupiny po každém snímku.
 */
function play(
  id: string,
  clips: Partial<Record<ClipState, string>>,
  views: (tick: number) => ToyView,
  ticks: number,
  clipOf: (tick: number) => ClipState = () => 'idle',
  attackAt: (tick: number) => number | undefined = () => undefined,
): Shot[] {
  hooks.gltf = { scene: new Group(), animations: Object.values(clips).filter((name) => name !== 'procedural').map((name) => new AnimationClip(name, 1, [])) };
  let tick = 0;
  const character: RiggedCharacter = { id, path: `/models/${id}.glb`, tags: [], clips };
  const toy = (): ToyFrame => {
    const start = attackAt(Math.floor(tick));
    return start === undefined ? { view: views(Math.floor(tick)), tick } : { view: views(Math.floor(tick)), tick, attackAt: start };
  };
  const element = RiggedModel({ character, h: 1.8, clip: () => clipOf(Math.floor(tick)), fallback: '#94a3b8', toy }) as ReactElement<{ ref: RefObject<Group | null> }>;
  const holder = new Group();
  element.props.ref.current = holder;
  const shots: Shot[] = [];
  for (let at = 0; at < ticks; at += 1) {
    for (const alpha of [0, 0.5]) {
      tick = at + alpha;
      hooks.frame!({}, 1 / (2 * ARCADE_HZ));
      shots.push({ y: holder.position.y, z: holder.position.z, pitch: holder.rotation.x, roll: holder.rotation.z, scaleY: holder.scale.y });
    }
  }
  return shots;
}

const most = (shots: readonly Shot[], key: keyof Shot): number => Math.max(...shots.map((shot) => shot[key]));
const least = (shots: readonly Shot[], key: keyof Shot): number => Math.min(...shots.map((shot) => shot[key]));

describe('a rigged character borrows toy motion for the states it has no clip for (P45D T13)', () => {
  it('a character with a run clip does not hop on top of it; without one the toy walk rocks it', () => {
    for (const [id, clips] of [['knight', KNIGHT], ['pet-cat', PET]] as const) {
      const shots = play(id, clips, () => RUNNING, 90, () => 'run');
      // Žádný poskok, kolébání ani zmáčknutí navrch klipu běhu.
      expect(shots.every((shot) => shot.y === 0 && shot.pitch === 0 && shot.roll === 0 && shot.scaleY === 1), id).toBe(true);
    }
    // Manifest dává běhu `procedural`: chůzi dohraje hračka – kočka poskakuje a kolébá se dopředu i dozadu.
    const procedural = play('pet-cat', { ...PET, run: 'procedural' }, () => RUNNING, 90, () => 'run');
    expect(most(procedural, 'y')).toBeGreaterThan(0.05);
    expect(most(procedural, 'pitch')).toBeGreaterThan(0.05);
    expect(least(procedural, 'pitch')).toBeLessThan(-0.05);
  });

  it('an animal without a die clip topples over; a die clip plays the fall alone', () => {
    const dead = (tick: number): ToyView => (tick < 10 ? STILL : { ...STILL, alive: false, hit: tick === 10 });
    const ticks = 10 + Math.ceil((FALL_S + 0.2) * ARCADE_HZ);
    const pet = play('pet-cat', PET, dead, ticks, (tick) => (tick < 10 ? 'idle' : 'die'));
    expect(pet.at(-1)!.pitch).toBeCloseTo(-Math.PI / 2);
    const knight = play('knight', KNIGHT, dead, ticks, (tick) => (tick < 10 ? 'idle' : 'die'));
    expect(knight.every((shot) => shot.pitch === 0 && shot.roll === 0)).toBe(true);
  });

  it('a strike lunges, a win cheers and carrying leans back; a shot with its own clip does not lunge', () => {
    const at = (event: Partial<ToyView>) => (tick: number): ToyView => (tick === 5 ? { ...STILL, ...event } : STILL);
    // Nepřítel udeří hráče: na úder klip není (`shoot` hraje jen výstřel hráče), výpad dohraje hračka.
    expect(most(play('pet-cat', PET, at({ attack: true }), 40), 'z')).toBeGreaterThan(0.2);
    expect(most(play('knight', KNIGHT, at({ attack: true }), 40), 'z')).toBeGreaterThan(0.2);
    // Výstřel hráče: rytíř má klip, zvířátko ne.
    expect(most(play('knight', KNIGHT, at({ attack: true, shot: true }), 40, (tick) => (tick >= 5 ? 'shoot' : 'idle')), 'z')).toBe(0);
    expect(most(play('pet-cat', PET, at({ attack: true, shot: true }), 40), 'z')).toBeGreaterThan(0.2);
    // Výhru bez klipu oslaví hračka, s klipem (P54B T5) ji hraje klip sám; nesení klip nemá nikdy.
    expect(most(play('knight', KNIGHT, () => ({ ...STILL, won: true }), 40), 'y')).toBeGreaterThan(0.2);
    expect(most(play('knight', { ...KNIGHT, win: 'Cheer' }, () => ({ ...STILL, won: true }), 40, () => 'win'), 'y')).toBe(0);
    expect(play('knight', KNIGHT, () => ({ ...STILL, carrying: true }), 5).at(-1)!.pitch).toBeLessThan(-0.1);
  });

  it('a monster that runs with its walk clip keeps playing it when the body switches between walk and run (P54B T5)', () => {
    // Příšera P54 bez běhu: manifest dává chůzi i běhu týž klip, mixer z něj má jedinou akci.
    const spy = vi.spyOn(AnimationMixer.prototype, 'clipAction');
    play('q-monster', { idle: 'Idle', walk: 'Walk', run: 'Walk', jump: 'procedural', hit: 'procedural', die: 'procedural' }, () => RUNNING, 60, (tick) => (tick < 20 ? 'walk' : 'run'));
    const walk = spy.mock.results.map((result) => result.value as AnimationAction).find((action) => action.getClip().name === 'Walk')!;
    spy.mockRestore();
    expect(walk.enabled).toBe(true);
    expect(walk.getEffectiveWeight()).toBeCloseTo(1);
  });

  it('an arena strike shifted back peaks toward the hero in the hit tick instead of winding up away (P45D T23)', () => {
    // Aréna: rána dopadne v tiku 20, začátek úderu posune o 16 tiků zpět a pohled nese `attack: false`.
    const HIT = 20;
    const hitShot = HIT * 2;
    for (const [id, clips] of [['pet-cat', PET], ['knight', KNIGHT]] as const) {
      const shifted = play(id, clips, () => STILL, HIT + 30, () => 'idle', (tick) => (tick === HIT ? HIT - 16 : undefined));
      // Před zásahem stojí; v tiku zásahu je výpad k hrdinovi skoro na vrcholu.
      expect(shifted.slice(0, hitShot).every((shot) => shot.z === 0), id).toBe(true);
      expect(shifted[hitShot]!.z, id).toBeGreaterThan(0.4);
      expect(shifted[hitShot]!.z, id).toBeGreaterThan(0.9 * most(shifted, 'z'));
    }
    // Bez posunu by úder v tiku zásahu teprve začal nápřahem – tělo by od hrdiny ucuklo.
    const unshifted = play('pet-cat', PET, (tick) => (tick === HIT ? { ...STILL, attack: true } : STILL), HIT + 30);
    expect(least(unshifted.slice(hitShot, hitShot + 12), 'z')).toBeLessThan(-0.2);
  });
});
