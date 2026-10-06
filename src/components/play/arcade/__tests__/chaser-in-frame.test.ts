/**
 * Pronásledovatel z věty je v záběru (P39 T16). Slepý soud P39 T14 prohrál
 * „temple run but you're a banana running from a monkey“: opice byla v jádře
 * správně pronásledovatel, ale běžci běžela 200 m před hrdinou za mlhou a
 * plošinovce 17 m za ním mimo obraz. Test hraje robotem věty z rychlé verze,
 * postaví kameru scény (`track-camera.ts`) a promítne kvádr pronásledovatele
 * tam, kde ho scéna kreslí: celý musí být v obraze a za hrdinou (honí ho, není
 * to překážka před ním) – na tiku 60 i 180 (snímek soudu po 3 s); na šířku
 * celý, na výšku aspoň střed těla.
 */

import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { CHASE, baseControlOf } from '@/play/arcade/addons';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, BODY, HEADER, NO_INPUT, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpec } from '@/play/draft/draft';

import { type Spot, chaserSpot, placePlatform, placeRunner } from '../track-camera';

const GAMES = [
  ['runner', "temple run but you're a banana running from a monkey"],
  ['runner', 'a dog runs through a city chased by a dogcatcher grabbing bones'],
  ['platform', 'run from zombies and jump over cars in a city'],
] as const;

/** Snímek soudu (1280 × 800) a telefon na výšku. */
const ASPECTS = [1280 / 800, 390 / 844];
const TICKS = [60, 180];
/** Dohled kamery = konec mlhy sady (`FarAtFog`); věty hrají ve městě (`city`, mlha do 80 m). */
const VIEW = 80;

function worldOf(sentence: string, seed: number): ArcadeWorld {
  const made = arcadeWorldOf(draftGameSpec(sentence, 1), seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

/** Poloha těla ve scéně (m), x zrcadlené jako ve `World`. */
const spotOf = (state: Int32Array, index: number): Spot => {
  const base = bodyBase(index);
  return { x: -(state[base + BODY.x] as number) / UNIT, y: (state[base + BODY.y] as number) / UNIT, z: (state[base + BODY.z] as number) / UNIT };
};

/** Stav po `ticks` tikách hry robota „Show me how“ (`runBot`, stejné vstupy jako ukázka). */
function playedTo(world: ArcadeWorld, ticks: number): Int32Array {
  const inputs = new Map(runBot(world).inputs.map((input) => [input.tick, input]));
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  for (let tick = 0; tick < ticks && outcomeOf(state) === 'running'; tick += 1) step(state, inputs.get(tick) ?? NO_INPUT, program);
  return state;
}

const seen = (camera: PerspectiveCamera, point: Vector3): boolean => {
  if (point.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) return false;
  const ndc = point.clone().project(camera);
  return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && Math.abs(ndc.z) <= 1;
};

/** Rohy kvádru pronásledovatele, které kamera nevidí (mimo obraz nebo za ní). */
function outOfFrame(camera: PerspectiveCamera, at: Spot): number {
  const [w, h, d] = [CHASE.w / UNIT, CHASE.h / UNIT, CHASE.d / UNIT];
  let out = 0;
  for (let i = 0; i < 8; i += 1) {
    if (!seen(camera, new Vector3(at.x + (i & 1 ? w / 2 : -w / 2), at.y + (i & 2 ? h : 0), at.z + (i & 4 ? d / 2 : -d / 2)))) out += 1;
  }
  return out;
}

describe('a chaser named by the sentence is in the camera frame (P39 T16)', () => {
  it.each(GAMES)('%s: %s', (control, sentence) => {
    const world = worldOf(sentence, 1);
    expect(baseControlOf(world.control).id).toBe(control);
    const state0 = instantiate(world);
    const chaser = Array.from({ length: state0[HEADER.bodyCount] as number }, (_, i) => i).find((i) => state0[bodyBase(i) + BODY.role] === ROLE.chaser);
    expect(chaser, 'the sentence casts a chaser').toBeDefined();
    for (const ticks of TICKS) {
      const state = playedTo(world, ticks);
      expect(outcomeOf(state), `tick ${ticks}`).toBe('running');
      const hero = spotOf(state, state[HEADER.player] as number);
      for (const aspect of ASPECTS) {
        const camera = new PerspectiveCamera(60, aspect, 0.1, VIEW);
        const look = new Vector3();
        const { spot } = chaserSpot(control, hero, spotOf(state, chaser as number), VIEW, aspect);
        if (control === 'runner') placeRunner(camera, look, hero.x, hero.z);
        else placePlatform(camera, look, hero.z, hero.y);
        camera.updateMatrixWorld();
        const where = `tick ${ticks}, aspect ${aspect.toFixed(2)}: hero ${JSON.stringify(hero)}, chaser drawn at ${JSON.stringify(spot)}`;
        // Na šířku celý; úzký obraz telefonu na výšku ho smí useknout, střed těla ale musí být vidět.
        if (aspect >= 1) expect(outOfFrame(camera, spot), where).toBe(0);
        else expect(seen(camera, new Vector3(spot.x, spot.y + CHASE.h / UNIT / 2, spot.z)), where).toBe(true);
        // Honí ho: je za hrdinou, ne překážka na trati před ním.
        expect(spot.z, where).toBeLessThan(hero.z);
      }
    }
  });
});
