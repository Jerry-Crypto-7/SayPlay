/**
 * Chůze, zásah a výhra riggovaných postav (P54B T5). Chybějící klip tiše spadne
 * na `idle` a postava klouže – na obrázku to vypadá jako klid. Test proto drží:
 * stav těla volí chůzi pod 2,5 m/s a běh nad, výhra slaví; každá z 9 postav
 * KayKit nese chůzi, oslavu i zásah v GLB; chůze a výhra postav P54 dojdou až
 * do scény; řetězce náhrad a Kenney dítě, které klip zásahu nemá, cukne hračkou.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import rigged from '@/assets/rigged.json';
import riggedP54 from '@/assets/rigged-p54.json';
import { ONCE, playedClip, unclippedView } from '@/components/play/arcade/RiggedModel';
import { bodyClassOf } from '@/components/play/arcade/toy/body-class';

import { readGlb } from '../../../../scripts/assets/rigged/build.mjs';
import { ARCADE_HZ, BODY, BODY_STRIDE, FLAG, HEADER, HEADER_SIZE, ROLE, RUN_STATE, UNIT, bodyBase } from '../contract';
import { PROCEDURAL_CLIP, RIGGED_PREFIX, riggedCharacter } from '../models';
import { CLIP_STATES, type ClipState, type MotionView, type Pose, WALK_MAX_MPS, clipOf, poseOf, viewOf } from '../motion';
import { type ToyPose, type ToyView, toyPoseOf } from '../toy-motion';

/** Rychlost v m/s → jednotky za tik. */
const perTick = (metresPerSecond: number): number => Math.round((metresPerSecond * UNIT) / ARCADE_HZ);
const view = (over: Partial<MotionView> = {}): MotionView => ({ vx: 0, vy: 0, vz: 0, grounded: true, alive: true, hit: false, shot: false, ...over });

/** Klip po celém skriptu pohledů (póza nese paměť zásahu a výstřelu). */
function clipAfter(views: readonly MotionView[]): ClipState {
  let pose: Pose | null = null;
  views.forEach((v, tick) => {
    pose = poseOf(v, pose, tick);
  });
  return clipOf(views[views.length - 1]!, pose!, views.length - 1);
}

const has = (...states: ClipState[]) => (state: ClipState): boolean => states.includes(state);
const clipsOf = (id: string) => riggedCharacter(`${RIGGED_PREFIX}${id}`)?.clips;
const hasClipOf = (id: string) => (state: ClipState): boolean => {
  const name = clipsOf(id)?.[state];
  return name !== undefined && name !== PROCEDURAL_CLIP;
};

describe('clipOf – walk below the threshold, run above it, win after the run is won', () => {
  it('knows the walk and win states', () => {
    expect(CLIP_STATES).toEqual(expect.arrayContaining(['walk', 'win']));
    expect(WALK_MAX_MPS).toBe(2.5);
  });

  it('1 m/s walks, 5 m/s runs, along the track and sideways', () => {
    expect(clipAfter([view({ vz: perTick(1) })])).toBe('walk');
    expect(clipAfter([view({ vx: perTick(1) })])).toBe('walk');
    expect(clipAfter([view({ vz: perTick(5) })])).toBe('run');
    expect(clipAfter([view({ vx: -perTick(5) })])).toBe('run');
    // Pod prahem stání tělo stojí.
    expect(clipAfter([view({ vz: perTick(0.2) })])).toBe('idle');
  });

  it('a won run cheers over running, a hit and a shot; death still wins over it', () => {
    expect(clipAfter([view({ won: true, vz: perTick(5) })])).toBe('win');
    expect(clipAfter([view({ won: true, hit: true })])).toBe('win');
    expect(clipAfter([view({ won: true, shot: true })])).toBe('win');
    expect(clipAfter([view({ won: true, alive: false })])).toBe('die');
  });

  it('viewOf reads the won run of the player only from the state', () => {
    const state = new Int32Array(HEADER_SIZE + 4 * BODY_STRIDE);
    state[HEADER.bodyCount] = 2;
    state[bodyBase(0) + BODY.role] = ROLE.player;
    state[bodyBase(0) + BODY.flags] = FLAG.alive | FLAG.gravity | FLAG.grounded;
    state[bodyBase(1) + BODY.role] = ROLE.enemy;
    state[bodyBase(1) + BODY.flags] = FLAG.alive;
    const before = state.slice();
    expect(viewOf(state, state, 0).won).toBe(false);
    state[HEADER.runState] = RUN_STATE.won;
    expect(viewOf(state, state, 0).won).toBe(true);
    expect(viewOf(state, state, 1).won).toBe(false);
    // Pohled jen čte: stav se nezměnil.
    state[HEADER.runState] = before[HEADER.runState]!;
    expect(state).toEqual(before);
  });
});

describe('RiggedModel fallback chains', () => {
  it('walk → run → idle, run → walk → idle, win → idle; win plays once', () => {
    expect(playedClip('walk', has('idle', 'walk', 'run'))).toBe('walk');
    expect(playedClip('walk', has('idle', 'run'))).toBe('run');
    expect(playedClip('walk', has('idle'))).toBe('idle');
    expect(playedClip('run', has('idle', 'walk'))).toBe('walk');
    expect(playedClip('win', has('idle', 'win'))).toBe('win');
    expect(playedClip('win', has('idle', 'run'))).toBe('idle');
    expect(ONCE.has('win')).toBe(true);
  });

  it('a clip of walk or win stops the toy from doubling it; without one the toy walks and cheers', () => {
    const toy: ToyView = { ...view({ vz: perTick(1) }), won: true, carrying: false, attack: false, turn: 0, opened: false };
    const clipped = unclippedView(toy, has('idle', 'walk', 'win'));
    expect([clipped.vz, clipped.won]).toEqual([0, false]);
    const bare = unclippedView(toy, has('idle'));
    expect([bare.vz, bare.won]).toEqual([toy.vz, true]);
  });
});

describe('clips of the characters', () => {
  const kaykit = rigged.characters.filter((character) => character.pack.startsWith('KayKit'));

  it('all 9 KayKit characters carry walk, win and hit, in the manifest, the scene and the GLB', () => {
    expect(kaykit.map((character) => character.id)).toHaveLength(9);
    for (const character of kaykit) {
      const clips = character.clips as Partial<Record<ClipState, string>>;
      expect([clips.walk, clips.win, clips.hit], character.id).toEqual(['Walking_A', 'Cheer', 'Hit_A']);
      expect(clipsOf(character.id), character.id).toMatchObject({ walk: 'Walking_A', win: 'Cheer', hit: 'Hit_A' });
      const { doc } = readGlb(readFileSync(join(process.cwd(), 'public', character.path)));
      const names = new Set((doc.animations as { name: string }[]).map((animation) => animation.name));
      for (const name of ['Walking_A', 'Cheer', 'Hit_A']) expect(names.has(name), `${character.id}: ${name}`).toBe(true);
    }
  });

  it('every P54 character with a recorded walk or win plays it in the scene', () => {
    const walking = riggedP54.characters.filter((character) => 'walk' in character.clips);
    const winning = riggedP54.characters.filter((character) => 'win' in character.clips);
    expect(walking.length).toBeGreaterThanOrEqual(100);
    expect(winning.length).toBeGreaterThanOrEqual(100);
    for (const character of walking) expect(clipsOf(character.id)?.walk, character.id).toBe((character.clips as Record<string, string>).walk);
    for (const character of winning) expect(clipsOf(character.id)?.win, character.id).toBe((character.clips as Record<string, string>).win);
  });

  it('a Kenney kid has no hit clip and jolts with the toy recoil instead', () => {
    for (const id of ['boy-a', 'girl-a']) {
      expect(hasClipOf(id)('hit'), id).toBe(false);
      const still: ToyView = { ...view(), won: false, carrying: false, attack: false, turn: 0, opened: false };
      let pose: ToyPose | null = null;
      let recoil = 0;
      for (let tick = 0; tick < 12; tick += 1) {
        pose = toyPoseOf(unclippedView({ ...still, hit: tick === 0 }, hasClipOf(id)), bodyClassOf(`${RIGGED_PREFIX}${id}`), pose, tick, false);
        recoil = Math.max(recoil, Math.abs(pose.recoil));
      }
      expect(recoil, id).toBeGreaterThan(0.01);
    }
    // KayKit zásah hraje klipem: hračka ho nezdvojí.
    expect(unclippedView({ ...view({ hit: true }), won: false, carrying: false, attack: false, turn: 0, opened: false }, hasClipOf('knight')).hit).toBe(false);
  });
});
