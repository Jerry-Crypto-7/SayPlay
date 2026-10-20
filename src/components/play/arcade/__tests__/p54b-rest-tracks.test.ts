/**
 * Klipy bez klidových stop (P54B T15c): zahodit se smí jen stopa, která drží kost celou dobu
 * v klidu. Kdyby odešla i konstantní stopa mimo klid (pokrčená ruka po celý klip), postava by
 * na obrazovce stála jen v trochu jiné póze – a vypadala by pořád jako postava.
 */

import { AnimationClip, AnimationMixer, Bone, Group, type Object3D, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { describe, expect, it } from 'vitest';

import { dropRestTracks } from '../look/load';

/** Kostra boky → ruka, klidové natočení ruky není jednotkové. */
function rig(): Group {
  const root = new Group();
  const hips = new Bone();
  hips.name = 'hips';
  hips.position.set(0, 1, 0);
  const hand = new Bone();
  hand.name = 'hand';
  hand.position.set(0.6, 0.3, 0);
  hand.quaternion.set(0, 0, Math.sin(0.3), Math.cos(0.3));
  hips.add(hand);
  root.add(hips);
  return root;
}

const TIMES = [0, 0.5, 1];
const flat = (value: readonly number[]): number[] => TIMES.flatMap(() => [...value]);

/** Mávnutí rukou, k tomu klidové stopy obou kostí, jedna jako −q, a pokrčené boky mimo klid. */
function clips(): AnimationClip[] {
  const rest = rig();
  const hand = rest.getObjectByName('hand')!;
  const q = hand.quaternion.toArray();
  const wave = new AnimationClip('wave', 1, [
    new QuaternionKeyframeTrack('hand.quaternion', TIMES, [...q, 0, 0, Math.sin(0.9), Math.cos(0.9), ...q]),
    new VectorKeyframeTrack('hand.position', TIMES, flat([0.6, 0.3, 0])),
    new VectorKeyframeTrack('hand.scale', TIMES, flat([1, 1, 1])),
    new VectorKeyframeTrack('hips.position', TIMES, flat([0, 1, 0])),
    new QuaternionKeyframeTrack('hips.quaternion', TIMES, flat([0, 0, 0, 1])),
  ]);
  const crouch = new AnimationClip('crouch', 1, [
    new VectorKeyframeTrack('hips.position', TIMES, flat([0, 0.7, 0])),
    new QuaternionKeyframeTrack('hand.quaternion', TIMES, flat(q.map((value) => -value))),
    new VectorKeyframeTrack('hand.scale', TIMES, flat([1, 1, 1.0000004])),
  ]);
  return [wave, crouch];
}

/**
 * Póza obou kostí jako jejich matice (q a −q je totéž natočení): mávnutí, po 0,3 s prolnutí
 * do přikrčení, vzorek každých 0,1 s.
 */
function poses(root: Object3D, [wave, crouch]: readonly AnimationClip[]): number[][] {
  const mixer = new AnimationMixer(root);
  const waving = mixer.clipAction(wave!).play();
  const out: number[][] = [];
  for (let step = 0; step < 12; step += 1) {
    if (step === 3) {
      mixer.clipAction(crouch!).reset().fadeIn(0.4).play();
      waving.fadeOut(0.4);
    }
    mixer.update(0.1);
    out.push(
      ['hips', 'hand'].flatMap((name) => {
        const bone = root.getObjectByName(name)!;
        bone.updateMatrix();
        return [...bone.matrix.elements];
      }),
    );
  }
  return out;
}

describe('dropRestTracks', () => {
  it('drops only tracks that hold a bone at rest the whole clip', () => {
    const trimmed = clips();
    dropRestTracks(trimmed, rig());
    expect(trimmed.map((clip) => clip.tracks.map((track) => track.name))).toEqual([['hand.quaternion'], ['hips.position']]);
  });

  it('leaves every pose of a crossfade unchanged', () => {
    const trimmed = clips();
    dropRestTracks(trimmed, rig());
    const full = poses(cloneSkinned(rig()), clips());
    const lean = poses(cloneSkinned(rig()), trimmed);
    // Póza se opravdu hýbe: mávnutí i přikrčení posunou kosti.
    expect(Math.max(...full.flatMap((pose) => pose.map((value, j) => Math.abs(value - full[0]![j]!))))).toBeGreaterThan(0.1);
    for (const [i, pose] of lean.entries()) for (const [j, value] of pose.entries()) expect(value).toBeCloseTo(full[i]![j]!, 5);
  });
});
