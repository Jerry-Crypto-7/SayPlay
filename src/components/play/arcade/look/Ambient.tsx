'use client';

/**
 * Život v pozadí sady (P54B T10): hejno ptáků krouží nad orientačním bodem, motýli a prach ve
 * světle se vznášejí před ním, ryby kolem něj plavou nebo vyskakují z moře, netopýři poletují,
 * nad sopkou stoupají jiskry a nad vesmírnou stanicí padají hvězdy. Druhy nese sada (`look.ambient`).
 *
 * Kde: kolem orientačního bodu (`Landmark.tsx`), který T8 staví podle kamery žánru do záběru za
 * hrou, mimo hrací plochu a mimo kruh hrdiny. Celý rozkmit života (dráha i tělo) zůstane v patě
 * bodu (`footOf`), takže ty záruky platí i pro něj; výška se drží v obraze herní kamery (`restCamera`).
 * Bod, který jede s kamerou, veze i život. Scéna bez bodu (laboratoř terénu) život nemá.
 *
 * Jak: jeden druh = jedna `InstancedMesh` z jednoduchých tvarů, jedno kreslicí volání; stín
 * nevrhá. Pohyb počítá vertex shader z uniformy času kresby (součet `delta` z `useFrame`), takže
 * CPU nepřepisuje ani jednu matici. Rozptyl kusů dává `pure-rand` s vlastní solí, nic z běhu.
 * `prefers-reduced-motion` i `?toy=off` (`toyMotionOn`) čas zastaví: život stojí. Úroveň `low`
 * kreslí polovinu kusů.
 *
 * Jen vzhled: jádro o životě neví a hash se nemění.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { uniformFloat64 } from 'pure-rand/distribution/uniformFloat64';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { useEffect, useMemo, useRef } from 'react';
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  type Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  type Object3D,
  OctahedronGeometry,
  PerspectiveCamera,
  Sphere,
  Vector3,
} from 'three';

import { AMBIENT_COLOURS, AMBIENT_KINDS, type AmbientKind, type Look, modelHeight, type SceneryModel } from '@/play/arcade/look';

import { toyMotionOn } from '../toy/applyToy';
import { restCamera } from './intro';
import { footOf } from './landmark-places';
import type { QualityTier } from './rig/quality';

type Motion = 'circle' | 'flutter' | 'leap' | 'rise' | 'drift' | 'fall';

export interface LifeSpec {
  /** Kusů na `high` a `medium`; `low` kreslí polovinu. */
  readonly count: number;
  /** Tělo v jednotkách: polovina rozpětí (délky) je 1, dopředu +z. */
  readonly shape: () => BufferGeometry;
  readonly motion: Motion;
  /** Pásmo výšky kotvy nad patou bodu: podíl jeho výšky [dole, nahoře] … */
  readonly band: readonly [number, number];
  /** … a metry navíc. */
  readonly add: readonly [number, number];
  /** Drží se poloviny paty u kamery: nízký život létá před bodem, ne schovaný v něm. */
  readonly front: boolean;
  /** Poloměr dráhy jako podíl volného místa v patě. */
  readonly path: number;
  /** Svislý rozkmit (m): houpání, výška skoku, výstup jiskry, pád hvězdy. */
  readonly lift: number;
  /** Polovina rozpětí těla (m). */
  readonly body: number;
  /** Rychlost: rad/s kroužení a vznášení, cykly/s skoku, jiskry a pádu. */
  readonly speed: readonly [number, number];
  /** Mávání křídel: rychlost (rad/s), střední úhel a rozkmit (rad). */
  readonly flap?: readonly [rate: number, base: number, swing: number];
  /** Vlnění ocasu ryby (rad/s). */
  readonly wiggle?: number;
  /** Podíl cyklu, kdy je kus vidět (skok ryby, padající hvězda). */
  readonly shown?: number;
  readonly colours: readonly string[];
  /** Násobek barvy nad 1: září v bloomu (jiskry, hvězdy, prach ve světle). */
  readonly glow?: number;
}

/** Trojúhelníky (x, y, z po trojicích) jako geometrie bez indexů. */
function triangles(points: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(points, 3));
  return geometry;
}

/** Křídlo vpravo (+x) a jeho zrcadlo vlevo. */
const pair = (wing: readonly number[]): number[] => [...wing, ...wing.map((value, index) => (index % 3 === 0 ? -value : value))];

/** Svislý kosočtverec trupu od zobáku (+z) k ocasu. */
const trunk = (nose: number, tail: number, half: number): number[] => [0, 0, nose, 0, half, 0, 0, 0, -tail, 0, 0, nose, 0, 0, -tail, 0, -half, 0];

const bird = (): BufferGeometry => triangles([...trunk(0.45, 0.4, 0.07), ...pair([0.06, 0, 0.16, 1, 0, -0.1, 0.06, 0, -0.16]), 0, 0, -0.3, -0.16, 0, -0.55, 0.16, 0, -0.55]);
// Vějíř z kořene křídla; zářez na zadní hraně dělá netopýří křídlo.
const bat = (): BufferGeometry =>
  triangles([...trunk(0.3, 0.3, 0.06), ...pair([0.05, 0, 0.12, 1, 0.05, 0.05, 0.8, 0, -0.2, 0.05, 0, 0.12, 0.8, 0, -0.2, 0.6, 0, -0.08, 0.05, 0, 0.12, 0.6, 0, -0.08, 0.35, 0, -0.28, 0.05, 0, 0.12, 0.35, 0, -0.28, 0.05, 0, -0.18])]);
const butterfly = (): BufferGeometry => triangles([...trunk(0.35, 0.45, 0.04), ...pair([0.04, 0, 0.05, 1, 0, 0.5, 0.85, 0, -0.1, 0.04, 0, -0.02, 0.75, 0, -0.2, 0.3, 0, -0.65])]);
// Bok (y) a hřbet (x): z boku i shora je to ryba, ne čára.
const fish = (): BufferGeometry =>
  triangles([0, 0, 1, 0, 0.3, 0.15, 0, 0, -0.55, 0, 0, 1, 0, 0, -0.55, 0, -0.26, 0.15, 0, 0, -0.45, 0, 0.32, -1, 0, -0.32, -1, 0, 0, 1, -0.16, 0, 0.1, 0, 0, -0.55, 0, 0, 1, 0, 0, -0.55, 0.16, 0, 0.1]);
// List: dvě poloviny čepele kolem žilky (+z), mávání je ohne jako list ve větru.
const leaf = (): BufferGeometry => triangles(pair([0, 0, 0.9, 0.55, 0, 0.1, 0, 0, -0.9]));
const mote = (): BufferGeometry => new OctahedronGeometry(1, 0);
const streak = (): BufferGeometry => new OctahedronGeometry(1, 0).scale(0.07, 0.07, 1);

/** Druhy života; barvy z palety `AMBIENT_COLOURS`, světlé září. */
export const LIFE: Readonly<Record<AmbientKind, LifeSpec>> = {
  birds: { count: 10, shape: bird, motion: 'circle', band: [0.9, 1.25], add: [0.5, 2.5], front: false, path: 0.85, lift: 0.35, body: 0.55, speed: [0.3, 0.55], flap: [7, 0.15, 0.45], colours: AMBIENT_COLOURS.birds },
  butterflies: { count: 8, shape: butterfly, motion: 'flutter', band: [0.1, 0.55], add: [0.4, 0.6], front: true, path: 0.8, lift: 0.3, body: 0.22, speed: [0.6, 1], flap: [17, 0.35, 0.9], colours: AMBIENT_COLOURS.butterflies },
  fish: { count: 12, shape: fish, motion: 'circle', band: [0.15, 0.85], add: [0.3, 0.5], front: true, path: 0.85, lift: 0.2, body: 0.35, speed: [0.35, 0.6], wiggle: 9, colours: AMBIENT_COLOURS.fish },
  'jumping-fish': { count: 4, shape: fish, motion: 'leap', band: [0, 0], add: [0, 0], front: true, path: 0.85, lift: 1.2, body: 0.32, speed: [0.2, 0.3], wiggle: 12, shown: 0.18, colours: AMBIENT_COLOURS['jumping-fish'] },
  bats: { count: 10, shape: bat, motion: 'circle', band: [0.5, 1.1], add: [0.5, 1.5], front: false, path: 0.85, lift: 0.5, body: 0.38, speed: [0.8, 1.2], flap: [15, 0, 0.7], colours: AMBIENT_COLOURS.bats },
  sparks: { count: 24, shape: mote, motion: 'rise', band: [0.8, 0.95], add: [0, 0], front: false, path: 0.6, lift: 5, body: 0.12, speed: [0.25, 0.45], colours: AMBIENT_COLOURS.sparks, glow: 3 },
  dust: { count: 40, shape: mote, motion: 'drift', band: [0.1, 0.9], add: [0.3, 0.5], front: true, path: 0.85, lift: 0.6, body: 0.09, speed: [0.5, 0.9], colours: AMBIENT_COLOURS.dust, glow: 1.6 },
  meteors: { count: 4, shape: streak, motion: 'fall', band: [1.3, 2], add: [3, 8], front: false, path: 0.9, lift: 6, body: 1.2, speed: [0.08, 0.14], shown: 0.12, colours: AMBIENT_COLOURS.meteors, glow: 3 },
  // P81: listí ve slunci před orientačním bodem (předloha s4) – pomalé, pomalu se převrací.
  leaves: { count: 14, shape: leaf, motion: 'flutter', band: [0.15, 0.8], add: [0.3, 0.8], front: true, path: 0.9, lift: 0.6, body: 0.16, speed: [0.3, 0.55], flap: [4, 0.2, 0.6], colours: AMBIENT_COLOURS.leaves },
};

/** Kusů na úrovni kvality: `low` polovinu. */
export const lifeCount = (kind: AmbientKind, tier: QualityTier): number => (tier === 'low' ? LIFE[kind].count / 2 : LIFE[kind].count);

/** Čas kresby po snímku: s omezeným pohybem stojí. */
export const tickLife = (time: number, delta: number): number => (toyMotionOn() ? time + delta : time);

/** Ryba pod hladinou před skokem a po něm (m). */
const DIVE = 0.5;
/** Tělo s mávnutím či vlněním sahá kousek za svou jednotku. */
const BODY_PAD = 1.05;
/** Kotva a celý svislý rozkmit zůstanou uvnitř tohohle výřezu obrazu (NDC). */
const EDGE = 0.9;
/**
 * Nízký život krouží kolem středu posunutého o polovinu poloměru paty ke kameře v kruhu poloviční
 * šířky: každá kotva leží v půlce paty u kamery, před bodem, ne za ním nebo v něm.
 */
const FRONT = 0.5;
/** Pokusů o místo kusu, než se vezme to nejblíž obrazu. */
const ATTEMPTS = 6;
/** Sůl – stream života je jiný než každý stream jádra, výzdoby i orientačního bodu. */
const SALT = 0x5b3e17c9;

/** Kus života: kotva vůči patě bodu (m) a parametry pohybu ve shaderu. */
export interface Life {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly phase: number;
  readonly speed: number;
  /** Poloměr dráhy (m). */
  readonly path: number;
  readonly lift: number;
  /** Polovina rozpětí těla (m). */
  readonly size: number;
  /** Nejdál, kam od kotvy po zemi sáhne kterýkoli vrchol (m). */
  readonly reach: number;
  /** Nejvýš a nejníž od kotvy (m). */
  readonly up: number;
  readonly down: number;
}

export interface LifeInput {
  /** Herní kamera (`restCamera`) s aktuálními maticemi. */
  readonly camera: PerspectiveCamera;
  /** Pata orientačního bodu ve scéně. */
  readonly foot: { readonly x: number; readonly y: number; readonly z: number };
  readonly id: SceneryModel;
  readonly scale: number;
  readonly kind: AmbientKind;
}

/** Svislý rozkmit pohybu: [dolů, nahoru] bez těla. */
function swing(motion: Motion, lift: number): readonly [number, number] {
  if (motion === 'leap') return [DIVE, lift];
  if (motion === 'rise') return [0, lift];
  if (motion === 'fall') return [lift / 2, lift / 2];
  return [lift, lift];
}

/**
 * Výška (m) bodu na svislici (x, z), který kamera promítne na řádek obrazu `ndcY`. Svislice, která
 * ten řádek před kamerou nepotká (kamera kouká strmě dolů a spodní kraj obrazu míří pod ni), vrátí ±∞.
 */
function rowHeight(camera: PerspectiveCamera, x: number, z: number, ndcY: number): number {
  const e = camera.matrixWorld.elements;
  const p = camera.projectionMatrix.elements;
  const dx = x - e[12]!;
  const dz = z - e[14]!;
  // Řádek obrazu: p5·y_kamery + (p9 + ndcY)·z_kamery = 0; nahoru e4–e6, dozadu e8–e10.
  const k = p[9]! + ndcY;
  const slope = p[5]! * e[5]! + k * e[9]!;
  const y = e[13]! - (p[5]! * (e[4]! * dx + e[6]! * dz) + k * (e[8]! * dx + e[10]! * dz)) / slope;
  const ahead = e[8]! * dx + e[9]! * (y - e[13]!) + e[10]! * dz < 0;
  return Number.isFinite(y) && ahead ? y : ndcY > 0 ? Infinity : -Infinity;
}

const probe = new Vector3();

/**
 * Jak daleko je bod za výřezem obrazu `EDGE` (0 = uvnitř) nebo za vzdálenou rovinou, kterou
 * `FarAtFog` staví na konec mlhy (`pad` = rozkmit kusu); za kamerou nekonečno.
 */
function outside(camera: PerspectiveCamera, x: number, y: number, z: number, pad: number): number {
  const depth = -probe.set(x, y, z).applyMatrix4(camera.matrixWorldInverse).z;
  if (depth <= camera.near) return Infinity;
  probe.set(x, y, z).project(camera);
  return Math.max(0, Math.abs(probe.x) - EDGE, Math.abs(probe.y) - EDGE, (depth + pad - camera.far) / camera.far);
}

/**
 * Kusy jednoho druhu kolem paty bodu: každý celým rozkmitem uvnitř paty (nízký v její polovině
 * u kamery), výškou v pásmu druhu sevřeném do obrazu. Kus, který se do obrazu nevejde ani
 * na `ATTEMPTS` pokusů, stojí tam, kde z něj chybí nejméně.
 */
export function placeLife({ camera, foot, id, scale, kind }: LifeInput): Life[] {
  const spec = LIFE[kind];
  const height = modelHeight(id) * scale;
  const column = footOf({ id, scale });
  const away = Math.max(1e-6, Math.hypot(camera.position.x - foot.x, camera.position.z - foot.z));
  const shift = spec.front ? column * FRONT : 0;
  const centre = { x: ((camera.position.x - foot.x) / away) * shift, z: ((camera.position.z - foot.z) / away) * shift };
  const free = column - shift;
  const rng = xoroshiro128plus((SALT ^ Math.imul(AMBIENT_KINDS.indexOf(kind) + 1, 0x9e3779b1)) | 0);
  const next = (): number => uniformFloat64(rng);
  // První výstupy xoroshiro z blízkých semínek jsou skoro stejné: dva se zahodí.
  next();
  next();
  const lives: Life[] = [];
  for (let i = 0; i < spec.count; i += 1) {
    const size = Math.min(spec.body * (0.8 + 0.4 * next()), free / (2 * BODY_PAD));
    const path = (free - size * BODY_PAD) * spec.path * (0.5 + 0.5 * next());
    const speed = spec.speed[0] + (spec.speed[1] - spec.speed[0]) * next();
    const phase = next();
    const reach = path + size * BODY_PAD;
    const [sink, rise] = swing(spec.motion, spec.lift);
    const [down, up] = [sink + size, rise + size];
    const slack = Math.max(0, free - reach);
    let best: Life | null = null;
    let miss = Infinity;
    for (let attempt = 0; attempt < ATTEMPTS && miss > 0; attempt += 1) {
      const angle = next() * 2 * Math.PI;
      const distance = Math.sqrt(next()) * slack;
      const level = next();
      const x = centre.x + Math.cos(angle) * distance;
      const z = centre.z + Math.sin(angle) * distance;
      // Pásmo druhu sevřené tak, aby kus i s rozkmitem zůstal v obraze; nevejde-li se, co nejblíž.
      // Pod patu bodu nesahá nic kromě ryby, která skáče z hladiny a zase pod ni.
      const floor = spec.motion === 'leap' ? -Infinity : down;
      const top = rowHeight(camera, foot.x + x, foot.z + z, EDGE) - foot.y - up;
      const bottom = Math.max(floor, rowHeight(camera, foot.x + x, foot.z + z, -EDGE) - foot.y + down);
      const [bandLo, bandHi] = [spec.band[0] * height + spec.add[0], spec.band[1] * height + spec.add[1]];
      const [lo, hi] = [Math.max(bandLo, bottom), Math.min(bandHi, top)];
      const y = lo <= hi ? lo + level * (hi - lo) : Math.max(Math.min((bandLo + bandHi) / 2, top), bottom);
      const off = outside(camera, foot.x + x, foot.y + y, foot.z + z, reach + up);
      if (off < miss) {
        miss = off;
        best = { x, y, z, phase, speed, path, lift: spec.lift, size, reach, up, down };
      }
    }
    lives.push(best!);
  }
  return lives;
}

const MOTION_DEFINE: Readonly<Record<Motion, string>> = { circle: 'LIFE_CIRCLE', flutter: 'LIFE_FLUTTER', leap: 'LIFE_LEAP', rise: 'LIFE_RISE', drift: 'LIFE_DRIFT', fall: 'LIFE_FALL' };

const LIFE_HEAD = /* glsl */ `
uniform float lifeTime;
attribute vec4 lifePath;
attribute float lifeSize;`;

/**
 * Pohyb kusu z času kresby: tělo (mávání, vlnění), natočení po dráze a posun kotvou. `lifePath` =
 * fáze, rychlost, poloměr dráhy, svislý rozkmit; matice kusu je jen posun kotvy.
 */
const LIFE_BODY = /* glsl */ `
{
  float lifeT = lifeTime;
  float lifePhase = lifePath.x;
  float lifeSpeed = lifePath.y;
  float lifeRing = lifePath.z;
  float lifeLift = lifePath.w;
  vec3 lifeBody = position;
  float lifeShow = 1.0;
  vec3 lifeOffset = vec3(0.0);
  vec2 lifeHeading = vec2(0.0, 1.0);
  float lifePitch = 0.0;
#ifdef LIFE_FLAP
  float lifeWing = LIFE_FLAP_BASE + LIFE_FLAP_SWING * sin(lifeT * LIFE_FLAP_RATE + lifePhase * 40.0);
  float lifeSpan = abs(lifeBody.x);
  lifeBody.x = sign(lifeBody.x) * lifeSpan * cos(lifeWing);
  lifeBody.y += lifeSpan * sin(lifeWing);
#endif
#ifdef LIFE_WIGGLE
  lifeBody.x += sin(lifeT * LIFE_WIGGLE - lifeBody.z * 4.0 + lifePhase * 40.0) * 0.12 * clamp(0.4 - lifeBody.z, 0.0, 1.4);
#endif
#if defined(LIFE_CIRCLE) || defined(LIFE_FLUTTER)
  float lifeTurn = lifePhase * 6.2832 + lifeT * lifeSpeed;
#ifdef LIFE_FLUTTER
  lifeTurn += sin(lifeT * 1.9 + lifePhase * 21.0) * 0.8;
  lifeRing *= 0.55 + 0.45 * sin(lifeT * 1.3 + lifePhase * 17.0);
#endif
  lifeOffset = vec3(cos(lifeTurn) * lifeRing, sin(lifeT * lifeSpeed * 2.7 + lifePhase * 31.0) * lifeLift, sin(lifeTurn) * lifeRing);
  lifeHeading = vec2(-sin(lifeTurn), cos(lifeTurn));
#elif defined(LIFE_LEAP)
  float lifeCycle = fract(lifeT * lifeSpeed + lifePhase);
  float lifeArc = clamp(lifeCycle / LIFE_SHOWN, 0.0, 1.0);
  float lifeAim = lifePhase * 37.7;
  lifeHeading = vec2(cos(lifeAim), sin(lifeAim));
  lifeOffset = vec3(lifeHeading.x, 0.0, lifeHeading.y) * (2.0 * lifeArc - 1.0) * lifeRing;
  lifeOffset.y = sin(lifeArc * 3.1416) * (lifeLift + LIFE_DIVE) - LIFE_DIVE;
  lifePitch = atan(cos(lifeArc * 3.1416) * 3.1416 * (lifeLift + LIFE_DIVE), 2.0 * lifeRing + 0.001);
  lifeShow = step(lifeCycle, LIFE_SHOWN);
#elif defined(LIFE_RISE)
  float lifeCycle = fract(lifeT * lifeSpeed + lifePhase);
  float lifeAim = lifePhase * 43.98;
  lifeOffset = vec3(cos(lifeAim) * lifeRing * lifeCycle, lifeCycle * lifeLift, sin(lifeAim) * lifeRing * lifeCycle);
  lifeShow = 1.0 - lifeCycle;
#elif defined(LIFE_DRIFT)
  lifeOffset = vec3(sin(lifeT * lifeSpeed * 0.9 + lifePhase * 6.2832) * 0.7 * lifeRing, sin(lifeT * lifeSpeed * 0.6 + lifePhase * 9.1) * lifeLift, cos(lifeT * lifeSpeed * 0.75 + lifePhase * 4.7) * 0.7 * lifeRing);
  lifeShow = 0.6 + 0.4 * sin(lifeT * 2.0 + lifePhase * 30.0);
#elif defined(LIFE_FALL)
  float lifeCycle = fract(lifeT * lifeSpeed + lifePhase);
  float lifeArc = clamp(lifeCycle / LIFE_SHOWN, 0.0, 1.0);
  float lifeAim = lifePhase * 37.7;
  vec3 lifeFall = normalize(vec3(cos(lifeAim) * 2.0 * lifeRing, -lifeLift, sin(lifeAim) * 2.0 * lifeRing));
  vec3 lifeAcross = normalize(cross(vec3(0.0, 1.0, 0.0), lifeFall) + vec3(0.0001, 0.0, 0.0));
  vec3 lifeUp = cross(lifeFall, lifeAcross);
  lifeOffset = vec3(cos(lifeAim) * lifeRing * (2.0 * lifeArc - 1.0), (0.5 - lifeArc) * lifeLift, sin(lifeAim) * lifeRing * (2.0 * lifeArc - 1.0));
  lifeBody = lifeAcross * lifeBody.x + lifeUp * lifeBody.y + lifeFall * lifeBody.z;
  lifeShow = step(lifeCycle, LIFE_SHOWN);
#endif
#if defined(LIFE_CIRCLE) || defined(LIFE_FLUTTER) || defined(LIFE_LEAP)
  lifeBody = vec3(lifeBody.x, lifeBody.y * cos(lifePitch) + lifeBody.z * sin(lifePitch), lifeBody.z * cos(lifePitch) - lifeBody.y * sin(lifePitch));
  lifeBody = vec3(lifeBody.x * lifeHeading.y + lifeBody.z * lifeHeading.x, lifeBody.y, lifeBody.z * lifeHeading.y - lifeBody.x * lifeHeading.x);
#endif
  transformed = lifeBody * lifeSize * lifeShow + lifeOffset;
}`;

const glsl = (value: number): string => value.toFixed(4);

/**
 * Síť jednoho druhu pro všechny kusy úrovně `high`; kolik jich kreslí, řídí `count`. Čas bere
 * ze sdílené uniformy `clock`. Až do rozmístění (`writeLife`) stojí všechny kusy na patě bodu.
 */
export function lifeMesh(kind: AmbientKind, clock: { value: number }): InstancedMesh {
  const spec = LIFE[kind];
  const geometry = spec.shape();
  geometry.setAttribute('lifePath', new InstancedBufferAttribute(new Float32Array(spec.count * 4), 4));
  geometry.setAttribute('lifeSize', new InstancedBufferAttribute(new Float32Array(spec.count), 1));
  const material = new MeshBasicMaterial({ side: DoubleSide });
  material.defines = {
    [MOTION_DEFINE[spec.motion]]: '',
    LIFE_DIVE: glsl(DIVE),
    LIFE_SHOWN: glsl(spec.shown ?? 1),
    ...(spec.flap === undefined ? {} : { LIFE_FLAP: '', LIFE_FLAP_RATE: glsl(spec.flap[0]), LIFE_FLAP_BASE: glsl(spec.flap[1]), LIFE_FLAP_SWING: glsl(spec.flap[2]) }),
    ...(spec.wiggle === undefined ? {} : { LIFE_WIGGLE: glsl(spec.wiggle) }),
  };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.lifeTime = clock;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>${LIFE_HEAD}`).replace('#include <begin_vertex>', `#include <begin_vertex>${LIFE_BODY}`);
  };
  material.customProgramCacheKey = () => `ambient-${kind}`;
  const mesh = new InstancedMesh(geometry, material, spec.count);
  const colour = new Color();
  for (let i = 0; i < spec.count; i += 1) mesh.setColorAt(i, colour.set(spec.colours[i % spec.colours.length]!).multiplyScalar(spec.glow ?? 1));
  // Rig stínů (`ShadowFlags`) síť se značkou nepřepíše: stínový průchod by ji kreslil znovu.
  mesh.userData.rigShadow = 'none';
  mesh.userData.ambient = kind;
  return mesh;
}

const matrix = new Matrix4();

/** Rozmístění do sítě: posun kotvy, parametry pohybu a koule ořezu přes celý rozkmit. */
function writeLife(mesh: InstancedMesh, lives: readonly Life[]): void {
  const path = mesh.geometry.getAttribute('lifePath') as InstancedBufferAttribute;
  const size = mesh.geometry.getAttribute('lifeSize') as InstancedBufferAttribute;
  let extent = 0;
  for (const [index, life] of lives.entries()) {
    mesh.setMatrixAt(index, matrix.makeTranslation(life.x, life.y, life.z));
    path.setXYZW(index, life.phase, life.speed, life.path, life.lift);
    size.setX(index, life.size);
    extent = Math.max(extent, Math.hypot(life.x, life.y, life.z) + life.reach + Math.max(life.up, life.down));
  }
  mesh.instanceMatrix.needsUpdate = true;
  path.needsUpdate = true;
  size.needsUpdate = true;
  mesh.boundingSphere = new Sphere(new Vector3(), extent);
}

/** Orientační bod scény (`userData.landmark` z `Landmark.tsx`). */
function landmarkOf(scene: Object3D): Object3D | null {
  let found: Object3D | null = null;
  scene.traverse((node) => {
    if (node.userData.landmark !== undefined) found = node;
  });
  return found;
}

/** Bod scéna staví až druhým snímkem: hledá se po tolika snímcích, dokud není. */
const SEARCH_FRAMES = 10;
const worldScale = new Vector3();

export function Ambient({ look, tier }: { readonly look: Look; readonly tier: QualityTier }) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const scene = useThree((three) => three.scene);
  const kinds = look.ambient;
  const clock = useMemo(() => ({ value: 0 }), []);
  const meshes = useMemo(() => kinds.map((kind) => lifeMesh(kind, clock)), [kinds, clock]);
  const rest = useMemo(() => new PerspectiveCamera(), []);
  const group = useRef<Group>(null);
  const landmark = useRef<Object3D | null>(null);
  const frames = useRef(0);

  useEffect(() => {
    // Nové sítě se rozmístí znovu kolem bodu, který právě stojí.
    landmark.current = null;
    frames.current = 0;
    return () => {
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
        mesh.dispose();
      }
    };
  }, [meshes]);

  useFrame((_, delta) => {
    const root = group.current;
    if (root === null || meshes.length === 0) return;
    // Bod odešel (nová sada, semínko, velikost obrazu): život se rozmístí kolem nového.
    if (landmark.current !== null && landmark.current.parent === null) landmark.current = null;
    if (landmark.current === null && frames.current++ % SEARCH_FRAMES === 0) {
      const found = landmarkOf(scene);
      if (found !== null) {
        found.updateWorldMatrix(true, true);
        restCamera(camera, rest);
        const id = found.userData.landmark as SceneryModel;
        const scale = found.children[0]?.getWorldScale(worldScale).y ?? 1;
        const foot = found.getWorldPosition(new Vector3());
        for (const [index, mesh] of meshes.entries()) writeLife(mesh, placeLife({ camera: rest, foot, id, scale, kind: kinds[index]! }));
        landmark.current = found;
      }
    }
    const node = landmark.current;
    root.visible = node !== null;
    if (node === null) return;
    // Bod, který jede s kamerou, veze i život.
    node.getWorldPosition(root.position);
    for (const [index, mesh] of meshes.entries()) mesh.count = lifeCount(kinds[index]!, tier);
    clock.value = tickLife(clock.value, delta);
  });

  if (meshes.length === 0) return null;
  return (
    <group ref={group} visible={false}>
      {meshes.map((mesh) => (
        <primitive key={mesh.uuid} object={mesh} />
      ))}
    </group>
  );
}
