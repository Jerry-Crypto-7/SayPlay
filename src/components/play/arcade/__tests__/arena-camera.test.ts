/**
 * Kamera arény blíž a nepřítel v záběru (P56B T9). Audit 21. 10.: na telefonu
 * hrdina malý a daleko, nepřítel za okrajem obrazu. Test hraje robotem tři věty
 * auditu (souboj a volný pohyb), každý tik postaví kameru scény z `arena-camera.ts`
 * (dojíždění `FOLLOW` jako `useFrame` při 60 snímcích za sekundu) a promítne
 * střed hrdiny a nejbližší hrozby – na šířku (snímek soudu 1280 × 800) i na výšku
 * (telefon 390 × 844), proti pákám ze `72665fdc`.
 *
 * Medián vzdálenosti se porovnává přes všech šest běhů dohromady: 08-gems na výšku
 * má nepřítele 6–16 m do strany po celou hru a ten se do užšího záběru vejde jen
 * s kamerou dál (na `72665fdc` tam byl v obraze v 0 % tiků).
 */

import { writeFileSync } from 'node:fs';
import { Box3, BoxGeometry, Group, Mesh, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';

import { baseControlOf } from '@/play/arcade/addons';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { ARCADE_HZ, type ArcadeWorld, BODY, FLAG, HEADER, NO_INPUT, UNIT, bodyBase } from '@/play/arcade/contract';
import { instantiate, loadProgram, outcomeOf, step } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { runBot } from '@/play/arcade/verify';
import { draftGameSpec } from '@/play/draft/draft';

import { ARENA_FRAMING, type ArenaFraming, type ArenaView, FIGHT_TILT, FOLLOW, LEAD_S, STYLED_TILT, type Spot, arenaDistance, arenaGoal, bandLift, raiseArena, shownBox } from '../arena/arena-camera';
import { drawnOf, partOf } from '../arena/ArenaScene';
import { bodiesOf } from '../bodies';
import { DIORAMA_FRAMING, dropOf } from '../look/framing';

const SENTENCES = [
  ['02-zombie', 'zombies attack my farm at night'],
  ['08-gems', 'match three glowing gems to unlock a treasure chest'],
  ['10-chef', 'a chef flips pancakes for a line of hungry customers'],
] as const;
const ASPECTS = { wide: 1280 / 800, tall: 390 / 844 } as const;
const TICKS = 600;
/** Hrozba blíž než tolik metrů má být v obraze – `THREAT_M` ze `72665fdc`, pevně tady, ať ho změna páky nezúží. */
const NEAR_M = 22;
/** Páky kamery na `72665fdc` (P55 tip). */
const BEFORE: ArenaFraming = { nearest: 16, see: 9, seeTall: 5, heroShare: 0.1, heroShareTall: 0.11, stretch: 1, stretchTall: 1 };
/** Zorný úhel plátna hry (`STAGE_CANVAS`). */
const FOV = 60;

function worldOf(sentence: string): ArcadeWorld {
  const made = arcadeWorldOf(draftGameSpec(sentence, 1), 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return made.world;
}

const seen = (camera: PerspectiveCamera, point: Vector3): boolean => {
  if (point.clone().applyMatrix4(camera.matrixWorldInverse).z >= 0) return false;
  const ndc = point.clone().project(camera);
  return Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
};

interface Frame {
  readonly distance: number;
  readonly hero: boolean;
  /** Hrozba do `NEAR_M`: je její střed v obraze? `null` = žádná blízko. */
  readonly threat: boolean | null;
  /** Sklon osy pohledu pod vodorovnou (°). */
  readonly pitch: number;
}

const pitchOf = (camera: PerspectiveCamera): number => (Math.asin(-camera.getWorldDirection(new Vector3()).y) * 180) / Math.PI;

/** Tiky hry robota „Show me how“ a kamera scény po každém z nich (jako `useFrame` stylové arény). */
function framesOf(world: ArcadeWorld, aspect: number, framing: ArenaFraming): Frame[] {
  const inputs = new Map(runBot(world).inputs.map((input) => [input.tick, input]));
  const state = instantiate(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const tilt = baseControlOf(world.control).id === 'fight' ? FIGHT_TILT : STYLED_TILT;
  const camera = new PerspectiveCamera(FOV, aspect, 0.1, 500);
  const tan = Math.tan((FOV * Math.PI) / 360);
  const k = 1 - Math.exp(-FOLLOW / ARCADE_HZ);
  const speed = ARCADE_HZ / UNIT;
  const session = { world, state: () => state };
  const frames: Frame[] = [];
  let aim: Spot | null = null;
  let distance = 0;
  for (let tick = 0; tick < TICKS && outcomeOf(state) === 'running'; tick += 1) {
    step(state, inputs.get(tick) ?? NO_INPUT, program);
    const views = bodiesOf(session);
    const player = state[HEADER.player] as number;
    const at = (index: number): Vector3 => {
      const base = bodyBase(index);
      return new Vector3(-(state[base + BODY.x] as number) / UNIT, (state[base + BODY.y] as number) / UNIT, (state[base + BODY.z] as number) / UNIT);
    };
    const hero = at(player);
    const heroSize = drawnOf(views[player]!, 'hero');
    const pb = bodyBase(player);
    const lead = { x: hero.x - (state[pb + BODY.vx] as number) * speed * LEAD_S, z: hero.z + (state[pb + BODY.vz] as number) * speed * LEAD_S };
    let threat: ArenaView['threat'] = null;
    let threatCentre: Vector3 | null = null;
    let nearest = Infinity;
    for (const view of views) {
      const part = partOf(view);
      // Jako scéna: na výšku i nepřítel průběhu (P62 T5-R1).
      if (part !== 'chaser' && part !== 'enemy' && (part !== 'foe' || aspect >= 1)) continue;
      if (((state[bodyBase(view.index) + BODY.flags] as number) & FLAG.alive) === 0) continue;
      const other = at(view.index);
      const gap = Math.hypot(other.x - hero.x, other.z - hero.z);
      if (gap >= nearest) continue;
      nearest = gap;
      const size = drawnOf(view, part);
      threat = { at: { x: other.x, z: other.z }, size };
      threatCentre = other.setY(other.y + size.h / 2);
    }
    const view: ArenaView = { hero: { x: hero.x, z: hero.z }, heroSize, lead, threat, tan, aspect, tilt };
    const { goal, framed } = arenaGoal(view, framing);
    aim = aim === null ? goal : { x: aim.x + (goal.x - aim.x) * k, z: aim.z + (goal.z - aim.z) * k };
    const wanted = arenaDistance(view, aim, framed, framing);
    distance = frames.length === 0 ? wanted : distance + (wanted - distance) * k;
    camera.position.set(aim.x, distance * tilt.sin, aim.z - distance * tilt.cos);
    camera.lookAt(aim.x, 0, aim.z);
    // P73D T2: osa pohledu zvednutá k obzoru jako ve scéně – hrdina a hrozba se měří v nové kompozici.
    hero.setY(hero.y + heroSize.h / 2);
    raiseArena(camera, tilt === FIGHT_TILT, hero, threatCentre);
    camera.updateMatrixWorld();
    frames.push({ distance, hero: seen(camera, hero), threat: nearest < NEAR_M ? seen(camera, threatCentre!) : null, pitch: pitchOf(camera) });
  }
  return frames;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Podíl tiků s blízkou hrozbou, kdy je její střed v obraze (bez blízké hrozby 1). */
function threatShare(frames: readonly Frame[]): number {
  const near = frames.filter((frame) => frame.threat !== null);
  return near.length === 0 ? 1 : near.filter((frame) => frame.threat).length / near.length;
}

/**
 * 08-gems na výšku: nepřítel bloudí 6–16 m do strany celou hru a do úzkého obrazu se s hrdinou nad
 * podlahou e2e (8 % výšky) vejde jen v ~70 % tiků (72665fdc: 0 %); zbytek ukáže šipka na okraji.
 */
const FOE_SHARE: Readonly<Record<string, number>> = { '08-gems tall': 0.65 };

const runs = SENTENCES.flatMap(([id, sentence]) => {
  const world = worldOf(sentence);
  return Object.entries(ASPECTS).map(([name, aspect]) => ({ id, name, world, before: framesOf(world, aspect, BEFORE), after: framesOf(world, aspect, ARENA_FRAMING) }));
});

describe('the arena camera sits closer and keeps the nearest foe in frame (P56B T9)', () => {
  // Měření pro README: `ARENA_OUT=<soubor> npx vitest run …arena-camera.test.ts`.
  if (process.env.ARENA_OUT !== undefined) {
    const summary = (frames: readonly Frame[]) => ({ ticks: frames.length, medianDistance: round(median(frames.map((frame) => frame.distance))), maxDistance: round(Math.max(...frames.map((frame) => frame.distance))), threatShare: round(threatShare(frames)) });
    writeFileSync(process.env.ARENA_OUT, JSON.stringify(Object.fromEntries(runs.map((run) => [`${run.id} ${run.name}`, { before: summary(run.before), after: summary(run.after) }])), null, 1));
  }

  it.each(SENTENCES)('%s plays in the styled arena (fight or free movement with a sized hero)', (_, sentence) => {
    const control = baseControlOf(worldOf(sentence).control);
    expect(control.id === 'fight' || (control.id === 'move_free' && control.params.size !== undefined), control.id).toBe(true);
  });

  it.each(runs.map((run) => [`${run.id} ${run.name}`, run] as const))('%s: the hero never leaves the frame and a foe within 22 m is in frame >= 85 % of ticks', (_, run) => {
    expect(run.after.length).toBeGreaterThan(300);
    expect(run.after.filter((frame) => !frame.hero)).toHaveLength(0);
    expect(threatShare(run.after)).toBeGreaterThanOrEqual(FOE_SHARE[`${run.id} ${run.name}`] ?? 0.85);
  });

  // Nejdál s taženou hrozbou (strop × `stretch`) drží hrdina podlahu `HERO_SHARE` z `e2e/p32-arena.spec.ts`
  // (telefon 0,08, desktop 0,07): 2,5× dalo kočce na Pixel 7 přesně 0,16 / 2,5 = 6,4 %.
  it('a framed foe never shrinks the hero under the e2e share floor', () => {
    expect(ARENA_FRAMING.heroShareTall / ARENA_FRAMING.stretchTall).toBeGreaterThanOrEqual(0.08);
    expect(ARENA_FRAMING.heroShare / ARENA_FRAMING.stretch).toBeGreaterThanOrEqual(0.07);
  });

  it('the median camera distance over all six runs drops by at least 20 % against 72665fdc', () => {
    const before = median(runs.flatMap((run) => run.before.map((frame) => frame.distance)));
    const after = median(runs.flatMap((run) => run.after.map((frame) => frame.distance)));
    expect(after).toBeLessThanOrEqual(before * 0.8);
  });

  // P73D: dřív hrozba za zády zdvih zkrátila – 08-gems na šířku až 38°, obzor nad horní hranou (QA 6. 11.: honička a úkol).
  it('free movement keeps the table pitch on every tick, so the horizon stays in frame', () => {
    const free = runs.filter((run) => baseControlOf(run.world.control).id !== 'fight');
    expect(free.length).toBeGreaterThan(0);
    for (const run of free) {
      const off = Math.max(...run.after.map((frame) => Math.abs(frame.pitch - DIORAMA_FRAMING.move_free.pitch)));
      expect(off, `${run.id} ${run.name}`).toBeLessThan(1e-6);
    }
  });
});

describe('a foe behind the hero keeps the arena pitch: the camera slides down its own axis (P73D, raiseArena)', () => {
  /** Kamera arény na šířku 16 m od bodu pohledu `aim` jako `ArenaScene`, po `lookAt` a před zdvihem. */
  function aimedAt(aim: Vector3): PerspectiveCamera {
    const camera = new PerspectiveCamera(FOV, ASPECTS.wide, 0.1, 500);
    camera.position.set(aim.x, 16 * STYLED_TILT.sin, aim.z - 16 * STYLED_TILT.cos);
    camera.lookAt(aim);
    camera.updateMatrixWorld();
    return camera;
  }
  const ndcY = (camera: PerspectiveCamera, point: Vector3): number => point.clone().project(camera).y;
  const depthOf = (camera: PerspectiveCamera, point: Vector3): number => -point.clone().applyMatrix4(camera.matrixWorldInverse).z;

  it('a pursuer 10 m behind: full raise to the table pitch, the pursuer back on the bottom edge, the hero no higher and no smaller', () => {
    const hero = new Vector3(0, 0.65, 0);
    const threat = new Vector3(0.5, 0.5, -10);
    const camera = aimedAt(new Vector3(0, 0, -3));
    const heroBefore = ndcY(camera, hero);
    // Bez posunu by plný zdvih poslal pronásledovatele pod dolní hranu – proto dřív jen 6° zdvihu a sklon 32°.
    const rotated = camera.clone();
    rotated.rotateX(dropOf(DIORAMA_FRAMING.move_free, FOV));
    rotated.updateMatrixWorld();
    expect(ndcY(rotated, threat)).toBeLessThan(-1);

    raiseArena(camera, false, hero, threat);
    camera.updateMatrixWorld();
    expect(pitchOf(camera)).toBeCloseTo(DIORAMA_FRAMING.move_free.pitch, 6);
    expect(ndcY(camera, threat)).toBeCloseTo(-0.9, 6);
    expect(ndcY(camera, hero)).toBeLessThan(heroBefore);
    expect(depthOf(camera, hero)).toBeCloseTo(depthOf(rotated, hero), 6);
  });

  it('the slide never lifts the hero above where the shot had it: a foe on the bottom edge beside the hero may stay low', () => {
    // Oba nízko u dolní hrany (bod pohledu daleko před nimi), nepřítel o kus blíž kameře.
    const hero = new Vector3(-1.5, 0.65, -7.8);
    const threat = new Vector3(1.5, 0.5, -8.7);
    const camera = aimedAt(new Vector3());
    const heroBefore = ndcY(camera, hero);
    expect(heroBefore).toBeGreaterThan(-0.8);
    expect(ndcY(camera, threat)).toBeLessThan(-0.9);
    expect(ndcY(camera, threat)).toBeGreaterThan(-1);
    raiseArena(camera, false, hero, threat);
    camera.updateMatrixWorld();
    expect(pitchOf(camera)).toBeCloseTo(DIORAMA_FRAMING.move_free.pitch, 6);
    expect(ndcY(camera, hero)).toBeCloseTo(heroBefore, 6);
  });

  it('a foe the shot already lost leaves the camera where the raise put it (the edge arrow shows it)', () => {
    const hero = new Vector3(0, 0.65, 0);
    const camera = aimedAt(new Vector3());
    const rotated = camera.clone();
    rotated.rotateX(dropOf(DIORAMA_FRAMING.move_free, FOV));
    raiseArena(camera, false, hero, new Vector3(0, 0.5, -30));
    expect(camera.position.distanceTo(rotated.position)).toBeLessThan(1e-9);
  });
});

describe('on a portrait phone the whole hero box sits under the HUD band (P64, bandLift)', () => {
  // iPhone 15 na výšku: lišta cíle končí v NDC 0,70 (audit `p64-portrait-audit`).
  const TOP = 0.7;
  const DISTANCE = 14;

  /** Kvádr těla 0,8 × `h` × 0,8 m s patou v (`x`, 0, `z`). */
  const body = (x: number, z: number, h = 1.6): Box3 => new Box3(new Vector3(x - 0.4, 0, z - 0.4), new Vector3(x + 0.4, h, z + 0.4));

  /** Kamera arény nad `aim` jako `ArenaScene`, po `bandLift` vyjetá po své ose nahoru. */
  function shot(hero: Box3): { camera: PerspectiveCamera; lift: number } {
    const camera = new PerspectiveCamera(50, 393 / 659, 0.1, 500);
    camera.position.set(0, DISTANCE * STYLED_TILT.sin, -DISTANCE * STYLED_TILT.cos);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const before = camera.quaternion.clone();
    const lift = bandLift(hero, camera.matrixWorldInverse, Math.tan((camera.fov * Math.PI) / 360), TOP);
    camera.position.add(new Vector3(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(lift));
    camera.updateMatrixWorld();
    expect(camera.quaternion.equals(before)).toBe(true);
    return { camera, lift };
  }

  /** Nejvyšší a nejnižší roh kvádru v NDC. */
  function ndcOf(camera: PerspectiveCamera, box: Box3): { top: number; bottom: number } {
    const ys = Array.from({ length: 8 }, (_, i) => new Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera).y);
    return { top: Math.max(...ys), bottom: Math.min(...ys) };
  }

  it('a hero framed above the band comes down until its farthest top corner is on the band edge, no further', () => {
    // Hrdina 8 m za bodem pohledu – hrozba u kamery táhla záběr k sobě (úkol na iPhonu: temeno v NDC 0,81–0,93).
    const hero = body(-1, 8, 1.9);
    const { camera, lift } = shot(hero);
    expect(lift).toBeGreaterThan(0);
    expect(ndcOf(camera, hero).top).toBeCloseTo(TOP, 6);
  });

  it('a hero already inside the band, or not drawn yet, leaves the camera where it was', () => {
    expect(shot(body(0, 0)).lift).toBe(0);
    expect(shot(new Box3()).lift).toBe(0);
  });

  it('the hero box is the drawn meshes, not the body size: a model scaled past its box still counts whole', () => {
    const hero = new Group();
    const model = new Mesh(new BoxGeometry(1, 2, 1));
    model.position.y = 1;
    hero.add(model);
    hero.scale.setScalar(1.5);
    const outline = new Mesh(new BoxGeometry(9, 9, 9));
    outline.userData.ink = true;
    hero.add(outline);
    const hidden = new Mesh(new BoxGeometry(9, 9, 9));
    hidden.visible = false;
    hero.add(hidden);
    const box = shownBox(hero, new Box3());
    expect(box.max.y).toBeCloseTo(3, 6);
    expect(box.max.x).toBeCloseTo(0.75, 6);
  });
});
