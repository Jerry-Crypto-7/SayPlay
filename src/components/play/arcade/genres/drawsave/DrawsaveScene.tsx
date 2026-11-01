'use client';

/**
 * Scéna hry kresli a zachraň (P68-S T14): pevná deska 8 × 12 buněk z boku (`side`), stojí svisle na zemi prostředí
 * věty. Kamera, buňky pro prst (`data-lane-cells`) a souřadnice jsou v `drawsave-camera.ts`; deska se kreslí ve
 * skupině otočené o π, uvnitř jsou souřadnice jádra v metrech (sloupec 0 vlevo, `+z` míří ke kameře).
 *
 * - **Mřížka:** tečka v každé buňce (papír s inkoustovým kroužkem) – body, které tah spojuje; po konci kreslení
 *   zmizí. Desku z boků vymezují dva inkoustové sloupky.
 * - **Čára** z úseček ve stavu jádra (`segmentsOf`): inkoust s papírovým lemem, ať je čitelná na každé obloze;
 *   nová úsečka se dotáhne od bodu tahu (odpověď na tah, `prefers-reduced-motion` ji ukáže hned).
 * - **Náhled dalšího bodu:** dokud prst kreslí, poslední bod tahu má slunečný kroužek a kolem něj kruh dosahu
 *   (poloměr = zbylý inkoust): každá buňka v kruhu může být další bod. Buňka, na kterou inkoust nestačí, dostane
 *   poplachový kroužek a čárkovanou čáru od bodu tahu.
 * - **Inkoust:** pruh nad deskou ubývá zleva doprava se zbylým inkoustem; pod ním tenký pruh času – ve fázi kreslení
 *   slunečný (okno kreslení), v obraně mátový (kolik zbývá přežít). Bez textu ve WebGL.
 * - **Postava** z věty (hrdina) sedí ve své buňce na prkénku na tyči; čitelnost (`LegibleBodies`) ji zvětší nejvýš
 *   na `HERO_CAP`, ať nepřeroste buňku. **Hrozby** z obsazení věty (`cast.things.threat`, jinak rajčatová koule)
 *   s rajčatovým terčíkem za sebou padají, odrážejí se a kutálí podle ujeté vodorovné dráhy.
 *
 * Čte jen stav jádra (`drawsave-world.ts`), záznam vstupů (náhled buňky pod prstem) a tik kresby, do relace nic
 * nepíše. Pohyb sám od sebe scéna nemá (riggovaná postava hraje klip `idle` jako všude); pohyb jako odpověď na akci
 * (dotažení úsečky, kutálení hrozby) vypne `prefers-reduced-motion`, kde nenese stav. Plocha dostane
 * `data-lane-cells` (čte ho `DrawsaveTouch`) a `data-player-x`. Kamera stojí ~20–25 m od desky, proto scéna posune
 * mlhu a vzdálenou rovinu za desku a při odchodu je vrátí (vzor `BuildshiftScene`).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import {
  CircleGeometry,
  CylinderGeometry,
  Fog,
  type Group,
  InstancedMesh,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  type PerspectiveCamera,
  type Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

import { color } from '@/brand/tokens';
import { BODY, BUTTON, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import {
  BOARD_CELLS,
  BOARD_TOP,
  DRAWSAVE,
  HALF_WIDTH,
  PHASE,
  SPAWN_SLOTS,
  alive,
  cellX,
  cellY,
  defendStartOf,
  heroCellOf,
  inkLeftOf,
  isBoardCell,
  phaseOf,
  segmentsOf,
  strokeLastOf,
  threatsOf,
} from '@/play/arcade/pieces/drawsave-world';
import { cellOfAxis } from '@/play/arcade/pieces/lanes';
import { DRAWSAVE_STROKE } from '@/play/genre/p68-contract';

import { reducedMotion } from '../../effects/feel';
import { renderHeld } from '../../effects/render-feel';
import { FieldGround } from '../../look/FieldGround';
import { type PlayRect, usePlayRectRef } from '../../portrait-frame';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { VIEW, cellsAttr, placeCamera, reachOf, tallFallback } from './drawsave-camera';

type DrawsaveSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

const m = (units: number): number => units / UNIT;
const HALF = m(HALF_WIDTH);
const TOP = m(BOARD_TOP);
const HOLD = BUTTON[DRAWSAVE_STROKE.hold];
const HERO = { w: m(DRAWSAVE.hero.w), h: m(DRAWSAVE.hero.h), d: m(DRAWSAVE.hero.d) };
/**
 * Hrdina je hrdina sondy (`frame: 'hero'`), čitelnost by ho ale zvětšila až na dvojnásobek a přerostl by buňku, ve
 * které ho jádro zasáhne: vnitřní skupina drží kreslenou velikost nejvýš na tolikanásobku.
 */
const HERO_CAP = 1.15;
/**
 * Hrozba se kreslí o kus větší než její tělo (0,3 m), ať je na telefonu vidět; s čarou o poloměru `LINE.r` se tak
 * na pohled dotkne o 3 cm dřív, než ji jádro odrazí.
 */
const THREAT_SIZE = 0.42;
/** Terčík za hrozbou (m): rajčatový kotouč s inkoustovým kroužkem – hrozba z věty je čitelná i jako malý model. */
const THREAT_MARK = { r: 0.22, ring: 0.27, z: -0.25 } as const;
/** Čára: poloměr inkoustu a lemu (m), dotažení nové úsečky (s). */
const LINE = { r: 0.06, halo: 0.035, grow: 0.12 } as const;
/** Tečka buňky: papír a inkoustový kroužek (m). */
const DOT = { r: 0.09, ring: 0.13 } as const;
/** Kroužek bodu tahu a buňky bez inkoustu, tloušťka kruhu dosahu a délka čárky náhledu (m). */
const PEN = { inner: 0.2, outer: 0.3, reach: 0.035, dash: 0.25 } as const;
/** Pruh nad deskou (m nad horní hranou): inkoust a čas. */
const INK_BAR = { y: 0.42, h: 0.26, border: 0.03 } as const;
const TIME_BAR = { y: 0.13, h: 0.09 } as const;
/**
 * Hloubky vrstev (m, `+z` ke kameře): tečky a pruhy za čarou, kroužky před ní. Lem čáry je válec většího poloměru –
 * musí ležet tak daleko za inkoustem, aby ho jeho přední stěna nepřekryla.
 */
const DEPTH = { dots: -0.3, bars: -0.2, halo: -0.15, line: 0, pen: 0.1 } as const;
/** Mlha začne tolik metrů za deskou. */
const FOG_CLEAR = 6;
const LAND = { x0: -40, x1: 40, z0: -35, z1: 60 } as const;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));


interface Pose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly fov: number;
  readonly attr: string;
  /** Hloubka desky před kamerou (m) – odtud se posouvá mlha. */
  readonly reach: number;
}

/** Postava z popisku: riggovaná s klipem `idle`, nebo model vepsaný do kvádru těla. */
function Hero({ model }: { readonly model: string }) {
  const rig = riggedCharacter(model);
  return rig !== undefined ? (
    <RiggedModel character={rig} h={HERO.h} clip={() => 'idle'} fallback={color['sky-deep']} />
  ) : (
    <FittedModel id={model} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
  );
}

/** Válec mezi dvěma body roviny desky (m, lokální souřadnice) do matice `dummy`; `r` = poloměr. */
function placeSpan(dummy: Object3D, ax: number, ay: number, bx: number, by: number, r: number, z: number): void {
  dummy.position.set((ax + bx) / 2, (ay + by) / 2, z);
  dummy.rotation.set(0, 0, Math.atan2(by - ay, bx - ax) - Math.PI / 2);
  dummy.scale.set(r, Math.max(1e-4, Math.hypot(bx - ax, by - ay)), r);
  dummy.updateMatrix();
}

/** Koule (spoj úseček) do matice `dummy`. */
function placeJoint(dummy: Object3D, x: number, y: number, r: number, z: number): void {
  dummy.position.set(x, y, z);
  dummy.rotation.set(0, 0, 0);
  dummy.scale.setScalar(r);
  dummy.updateMatrix();
}

// ---------------------------------------------------------------------------

export function DrawsaveScene({ session, cast, surface, scene: look }: DrawsaveSceneProps) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const playRect = usePlayRectRef();
  const threatModel = cast.things?.threat;
  /** Buňka postavy: semínko ji posadí při stavbě a jádro s ní nehýbe. */
  const heroCell = useMemo(() => heroCellOf(session.state()), [session]);
  const heroBottom = m(cellY(heroCell)) - HERO.h / 2;

  const clock = useRef(0);
  const hero = useRef<Group | null>(null);
  const heroInner = useRef<Group | null>(null);
  const dots = useRef<Group | null>(null);
  const lineBody = useRef<InstancedMesh | null>(null);
  const lineHalo = useRef<InstancedMesh | null>(null);
  const jointBody = useRef<InstancedMesh | null>(null);
  const jointHalo = useRef<InstancedMesh | null>(null);
  /** Kdy (s kresby) se která úsečka objevila, a kolik jich scéna naposledy viděla a nakreslila celých. */
  const segmentBorn = useRef<number[]>([]);
  const segmentsDrawn = useRef({ count: -1, growing: false });
  const pen = useRef<Mesh | null>(null);
  const reach = useRef<Group | null>(null);
  const reachOuter = useRef<Mesh | null>(null);
  const reachInner = useRef<Mesh | null>(null);
  const reachRadius = useRef(-1);
  const refused = useRef<Group | null>(null);
  const refusedDashes = useRef<InstancedMesh | null>(null);
  const inkBar = useRef<Group | null>(null);
  const inkFill = useRef<Mesh | null>(null);
  const timeFill = useRef<Mesh | null>(null);
  /** Pool hrozeb: tělo, které slot kreslí (−1 = volný). */
  const slots = useRef<number[]>(Array.from({ length: SPAWN_SLOTS }, () => -1));
  const threatGroups = useRef<(Group | null)[]>([]);
  const threatSpin = useRef<(Group | null)[]>([]);
  const poseKey = useRef<{ readonly rect: PlayRect | null; readonly width: number; readonly height: number } | null>(null);
  const pose = useRef<Pose | null>(null);
  /** Mlha rigu, jak ji sada nastavila (vrací se při odchodu), a pro jakou hloubku desky je posunutá. */
  const fogOrigin = useRef<{ readonly fog: Fog; readonly near: number; readonly far: number } | null>(null);
  const fogPushed = useRef<{ readonly fog: Fog; readonly reach: number } | null>(null);
  const cameraFar = useRef(camera.far);
  const probe = useMemo(() => new Vector3(), []);
  const dummy = useMemo(() => new Object3D(), []);

  const parts = useMemo(
    () => ({
      span: new CylinderGeometry(1, 1, 1, 10, 1),
      ball: new SphereGeometry(1, 12, 8),
      disc: new CircleGeometry(DOT.r, 16),
      dotRing: new RingGeometry(DOT.r, DOT.ring, 20),
      penRing: new RingGeometry(PEN.inner, PEN.outer, 32),
      markDisc: new CircleGeometry(THREAT_MARK.r, 20),
      markRing: new RingGeometry(THREAT_MARK.r, THREAT_MARK.ring, 24),
      ink: new MeshBasicMaterial({ color: color.ink, toneMapped: false }),
      paper: new MeshBasicMaterial({ color: color.paper, toneMapped: false }),
      sun: new MeshBasicMaterial({ color: color.sun, toneMapped: false }),
      sunDeep: new MeshBasicMaterial({ color: color['sun-deep'], toneMapped: false }),
      alarm: new MeshBasicMaterial({ color: color.alarm, toneMapped: false }),
      mint: new MeshBasicMaterial({ color: color['mint-deep'], toneMapped: false }),
      track: new MeshBasicMaterial({ color: color['cream-deep'], toneMapped: false }),
      mark: new MeshBasicMaterial({ color: color.tomato, toneMapped: false }),
      threat: new MeshStandardMaterial({ color: color.tomato, roughness: 0.6 }),
    }),
    [],
  );
  /** Kruh dosahu: inkoustový lem a slunečný střed; geometrie se přestaví jen se zbylým inkoustem (≤ 12× za kolo). */
  const reachShape = useMemo<{ outer: RingGeometry; inner: RingGeometry }>(() => ({ outer: new RingGeometry(0.5, 0.51, 8), inner: new RingGeometry(0.5, 0.51, 8) }), []);

  useEffect(
    () => () => {
      for (const geometry of [parts.span, parts.ball, parts.disc, parts.dotRing, parts.penRing, parts.markDisc, parts.markRing, reachShape.outer, reachShape.inner]) geometry.dispose();
      for (const material of [parts.ink, parts.paper, parts.sun, parts.sunDeep, parts.alarm, parts.mint, parts.track, parts.mark, parts.threat]) material.dispose();
    },
    [parts, reachShape],
  );

  // Tečky buněk: matice jednou, pak jen viditelnost skupiny.
  const dotMeshes = useMemo(() => {
    const disc = new InstancedMesh(parts.disc, parts.paper, BOARD_CELLS);
    const ring = new InstancedMesh(parts.dotRing, parts.ink, BOARD_CELLS);
    const at = new Object3D();
    for (let cell = 0; cell < BOARD_CELLS; cell += 1) {
      at.position.set(m(cellX(cell)), m(cellY(cell)), DEPTH.dots);
      at.updateMatrix();
      disc.setMatrixAt(cell, at.matrix);
      ring.setMatrixAt(cell, at.matrix);
    }
    // Obálka instancí je celá deska, ne jedna tečka v počátku.
    disc.frustumCulled = false;
    ring.frustumCulled = false;
    return { disc, ring };
  }, [parts]);
  useEffect(() => () => {
    dotMeshes.disc.dispose();
    dotMeshes.ring.dispose();
  }, [dotMeshes]);

  // Zorný úhel, vzdálená rovina a mlha patří rigu: po odchodu scény se vrátí, stejně jako buňky na ploše.
  useEffect(() => {
    const fov = camera.fov;
    const far = camera.far;
    const host = surface.current;
    return () => {
      const origin = fogOrigin.current;
      if (origin !== null) {
        origin.fog.near = origin.near;
        origin.fog.far = origin.far;
      }
      camera.fov = fov;
      camera.far = far;
      camera.updateProjectionMatrix();
      if (host !== null) {
        delete host.dataset.laneCells;
        delete host.dataset.playerX;
      }
    };
  }, [camera, surface]);

  useFrame((three, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    clock.current += delta;
    const now = clock.current;
    const state = session.state();
    const prev = session.prev();
    const tick = state[HEADER.tick] as number;
    const phase = phaseOf(state);
    const reduced = reducedMotion();

    // Kamera: póza jen při změně plátna nebo obdélníku; každý snímek se jen obnoví.
    const rect = playRect.current;
    const known = poseKey.current;
    if (known === null || known.rect !== rect || known.width !== three.size.width || known.height !== three.size.height) {
      poseKey.current = { rect, width: three.size.width, height: three.size.height };
      if (camera.view?.enabled === true) camera.clearViewOffset();
      placeCamera(camera, three.size, rect ?? tallFallback(three.size));
      pose.current = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), fov: camera.fov, attr: cellsAttr(camera, three.size), reach: reachOf(camera) };
    }
    const placed = pose.current as Pose;
    camera.position.copy(placed.position);
    camera.quaternion.copy(placed.quaternion);
    if (camera.fov !== placed.fov) {
      camera.fov = placed.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    const fog = three.scene.fog;
    if (fog instanceof Fog) {
      if (fogOrigin.current?.fog !== fog) fogOrigin.current = { fog, near: fog.near, far: fog.far };
      if (fogPushed.current?.fog !== fog || fogPushed.current.reach !== placed.reach) {
        const origin = fogOrigin.current;
        fog.near = Math.max(origin.near, placed.reach + FOG_CLEAR);
        fog.far = fog.near + Math.max(1, origin.far - origin.near);
        fogPushed.current = { fog, reach: placed.reach };
      }
    }
    const far = Math.max(cameraFar.current, fog instanceof Fog ? fog.far : placed.reach + FOG_CLEAR);
    if (camera.far !== far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }

    // Tečky jen ve fázi kreslení.
    const drawing = phase === PHASE.draw;
    if (dots.current !== null) dots.current.visible = drawing;

    // Čára: úsečky jádra; nová se dotáhne od svého počátku. Matice jen při změně nebo během dotažení.
    const segments = segmentsOf(state);
    const born = segmentBorn.current;
    if (segments.length < born.length) born.length = 0;
    while (born.length < segments.length) born.push(reduced || segmentsDrawn.current.count < 0 ? -Infinity : now);
    const growing = segments.some((_, k) => now - (born[k] as number) < LINE.grow);
    const drawn = segmentsDrawn.current;
    if (drawn.count !== segments.length || growing || drawn.growing) {
      drawn.count = segments.length;
      drawn.growing = growing;
      const meshes = [lineBody.current, lineHalo.current, jointBody.current, jointHalo.current];
      if (meshes.every((mesh) => mesh !== null)) {
        const [body, halo, jBody, jHalo] = meshes as InstancedMesh[];
        segments.forEach((segment, k) => {
          const grow = clamp01((now - (born[k] as number)) / LINE.grow);
          const ax = m(segment.ax);
          const ay = m(segment.ay);
          const bx = lerp(ax, m(segment.bx), grow);
          const by = lerp(ay, m(segment.by), grow);
          placeSpan(dummy, ax, ay, bx, by, LINE.r, DEPTH.line);
          body.setMatrixAt(k, dummy.matrix);
          placeSpan(dummy, ax, ay, bx, by, LINE.r + LINE.halo, DEPTH.halo);
          halo.setMatrixAt(k, dummy.matrix);
          for (const [end, x, y] of [[0, ax, ay], [1, bx, by]] as const) {
            placeJoint(dummy, x, y, LINE.r, DEPTH.line);
            jBody.setMatrixAt(2 * k + end, dummy.matrix);
            placeJoint(dummy, x, y, LINE.r + LINE.halo, DEPTH.halo);
            jHalo.setMatrixAt(2 * k + end, dummy.matrix);
          }
        });
        for (const mesh of [body, halo]) mesh.count = segments.length;
        for (const mesh of [jBody, jHalo]) mesh.count = 2 * segments.length;
        for (const mesh of [body, halo, jBody, jHalo]) {
          mesh.visible = segments.length > 0;
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
    }

    // Náhled dalšího bodu: bod tahu, kruh dosahu (zbylý inkoust) a buňka, na kterou inkoust nestačil. Buňku pod prstem
    // dá poslední zapsaný vstup – tik s `HOLD`, který jádro právě dostalo.
    const last = strokeLastOf(state);
    const input = session.inputs().at(-1);
    const finger = drawing && input !== undefined && input.tick === tick - 1 && (input.buttons & HOLD) !== 0 ? cellOfAxis(input.axis) : -1;
    const penDown = drawing && last >= 0;
    if (pen.current !== null) {
      pen.current.visible = penDown;
      if (penDown) pen.current.position.set(m(cellX(last)), m(cellY(last)), DEPTH.pen);
    }
    const inkLeft = m(inkLeftOf(state));
    if (reach.current !== null) {
      reach.current.visible = penDown && inkLeft > 0;
      if (reach.current.visible) {
        reach.current.position.set(m(cellX(last)), m(cellY(last)), DEPTH.pen);
        if (reachRadius.current !== inkLeft && reachOuter.current !== null && reachInner.current !== null) {
          reachRadius.current = inkLeft;
          reachShape.outer.dispose();
          reachShape.inner.dispose();
          reachShape.outer = new RingGeometry(Math.max(0.01, inkLeft - PEN.reach), inkLeft + PEN.reach, 96);
          reachShape.inner = new RingGeometry(Math.max(0.01, inkLeft - PEN.reach / 2), inkLeft + PEN.reach / 2, 96);
          reachOuter.current.geometry = reachShape.outer;
          reachInner.current.geometry = reachShape.inner;
        }
      }
    }
    const refusedCell = penDown && isBoardCell(finger) && finger !== last ? finger : -1;
    if (refused.current !== null) {
      refused.current.visible = refusedCell >= 0;
      if (refusedCell >= 0 && refusedDashes.current !== null) {
        refused.current.position.set(m(cellX(refusedCell)), m(cellY(refusedCell)), DEPTH.pen);
        // Čárkovaná čára od bodu tahu k odmítnuté buňce (lokálně od kroužku k bodu tahu).
        const dx = m(cellX(last) - cellX(refusedCell));
        const dy = m(cellY(last) - cellY(refusedCell));
        const length = Math.hypot(dx, dy);
        const count = Math.min(refusedDashes.current.instanceMatrix.count, Math.floor(length / (2 * PEN.dash)));
        for (let k = 0; k < count; k += 1) {
          const from = (2 * k + 0.5) * PEN.dash;
          const to = from + PEN.dash;
          placeSpan(dummy, (dx * from) / length, (dy * from) / length, (dx * to) / length, (dy * to) / length, LINE.r * 0.7, 0);
          refusedDashes.current.setMatrixAt(k, dummy.matrix);
        }
        refusedDashes.current.count = count;
        refusedDashes.current.instanceMatrix.needsUpdate = true;
      }
    }

    // Inkoust (jen ve fázi kreslení) a čas fáze: kreslení do `drawTicks`, obrana `surviveTicks` od jejího začátku.
    if (inkBar.current !== null) inkBar.current.visible = drawing;
    if (inkFill.current !== null) {
      const left = clamp01(inkLeftOf(state) / DRAWSAVE.ink);
      inkFill.current.visible = left > 0;
      inkFill.current.scale.x = Math.max(1e-3, 2 * HALF * left);
      inkFill.current.position.x = -HALF + HALF * left;
    }
    if (timeFill.current !== null) {
      const left = drawing ? clamp01(1 - tick / DRAWSAVE.drawTicks) : clamp01(1 - (tick - defendStartOf(state)) / DRAWSAVE.surviveTicks);
      timeFill.current.scale.x = Math.max(1e-3, 2 * HALF * left);
      timeFill.current.position.x = -HALF + HALF * left;
      timeFill.current.material = drawing ? parts.sun : parts.mint;
    }

    // Postava: stojí ve své buňce; vnitřní skupina drží velikost pod stropem čitelnosti.
    if (heroInner.current !== null && hero.current !== null) heroInner.current.scale.setScalar(Math.min(1, HERO_CAP / Math.max(1e-3, hero.current.scale.x)));

    // Hrozby: sloty se drží (model se nepřestaví), nová dostane první volný.
    const threats = threatsOf(state);
    const pool = slots.current;
    pool.forEach((body, index) => {
      if (body >= 0 && !threats.includes(body)) pool[index] = -1;
    });
    for (const body of threats) {
      if (pool.includes(body)) continue;
      const free = pool.indexOf(-1);
      if (free >= 0) pool[free] = body;
    }
    pool.forEach((body, index) => {
      const group = threatGroups.current[index];
      if (group == null) return;
      group.visible = body >= 0;
      if (body < 0) return;
      const base = bodyBase(body);
      const x1 = state[base + BODY.x] as number;
      const y1 = state[base + BODY.y] as number;
      // Nová hrozba (předtím mrtvá) se neprolíná.
      const fresh = !alive(prev, body);
      const x = m(fresh ? x1 : lerp(prev[base + BODY.x] as number, x1, alpha));
      const y = m(fresh ? y1 : lerp(prev[base + BODY.y] as number, y1, alpha));
      group.position.set(x, y + m(DRAWSAVE.threat) / 2, 0);
      // Kutálení: natočení podle ujeté vodorovné dráhy (odpověď na odraz); svislý pád ji netočí.
      threatSpin.current[index]?.rotation.set(0, 0, reduced ? 0 : -x / (THREAT_SIZE / 2));
    });

    const host = surface.current;
    if (host === null) return;
    if (host.dataset.laneCells !== placed.attr) host.dataset.laneCells = placed.attr;
    // Kreslené x je zrcadlené (skupina desky je otočená o π).
    host.dataset.playerX = probe.set(-m(cellX(heroCell)), m(cellY(heroCell)), 0).project(camera).x.toFixed(3);
  });

  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <group rotation={[0, Math.PI, 0]}>
        {/* Sloupky po stranách desky: kde mřížka končí. */}
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * (HALF + 0.08), (TOP + VIEW.strip) / 2, DEPTH.dots]} material={parts.ink}>
            <boxGeometry args={[0.12, TOP + VIEW.strip, 0.12]} />
          </mesh>
        ))}

        <group ref={dots} userData={{ item: 'cell' }}>
          <primitive object={dotMeshes.ring} />
          <primitive object={dotMeshes.disc} position={[0, 0, 0.005]} />
        </group>

        {/* Inkoust a čas nad deskou. */}
        <group ref={inkBar} position={[0, TOP + INK_BAR.y, DEPTH.bars]} userData={{ item: 'ink' }}>
          <mesh material={parts.ink}>
            <planeGeometry args={[2 * HALF + 2 * INK_BAR.border, INK_BAR.h + 2 * INK_BAR.border]} />
          </mesh>
          <mesh position={[0, 0, 0.005]} material={parts.paper}>
            <planeGeometry args={[2 * HALF, INK_BAR.h]} />
          </mesh>
          <mesh ref={inkFill} position={[0, 0, 0.01]} material={parts.ink}>
            <planeGeometry args={[1, INK_BAR.h]} />
          </mesh>
        </group>
        <group position={[0, TOP + TIME_BAR.y, DEPTH.bars]}>
          <mesh material={parts.track}>
            <planeGeometry args={[2 * HALF, TIME_BAR.h]} />
          </mesh>
          <mesh ref={timeFill} position={[0, 0, 0.005]} material={parts.sun}>
            <planeGeometry args={[1, TIME_BAR.h]} />
          </mesh>
        </group>

        {/* Čára: papírový lem za inkoustem, spoje koulemi. */}
        <instancedMesh ref={lineHalo} args={[parts.span, parts.paper, DRAWSAVE.maxSegments]} visible={false} frustumCulled={false} />
        <instancedMesh ref={jointHalo} args={[parts.ball, parts.paper, 2 * DRAWSAVE.maxSegments]} visible={false} frustumCulled={false} />
        <instancedMesh ref={lineBody} args={[parts.span, parts.ink, DRAWSAVE.maxSegments]} visible={false} frustumCulled={false} userData={{ item: 'line' }} />
        <instancedMesh ref={jointBody} args={[parts.ball, parts.ink, 2 * DRAWSAVE.maxSegments]} visible={false} frustumCulled={false} />

        {/* Náhled dalšího bodu. */}
        <mesh ref={pen} geometry={parts.penRing} material={parts.sun} visible={false} userData={{ item: 'pen' }} />
        <group ref={reach} visible={false} userData={{ item: 'reach' }}>
          <mesh ref={reachOuter} geometry={reachShape.outer} material={parts.ink} />
          <mesh ref={reachInner} geometry={reachShape.inner} material={parts.sunDeep} position={[0, 0, 0.005]} />
        </group>
        <group ref={refused} visible={false} userData={{ item: 'refused' }}>
          <mesh geometry={parts.penRing} material={parts.alarm} />
          <instancedMesh ref={refusedDashes} args={[parts.span, parts.alarm, 24]} frustumCulled={false} />
        </group>

        {/* Postava na prkénku na tyči. */}
        {heroBottom > 0.05 && (
          <mesh position={[m(cellX(heroCell)), heroBottom / 2, -0.1]} material={parts.ink}>
            <boxGeometry args={[0.1, heroBottom, 0.1]} />
          </mesh>
        )}
        <mesh position={[m(cellX(heroCell)), heroBottom - 0.05, 0]}>
          <boxGeometry args={[HERO.w, 0.1, 0.5]} />
          <meshStandardMaterial color={color['sun-deep']} roughness={0.8} />
        </mesh>
        <group ref={hero} position={[m(cellX(heroCell)), heroBottom, 0]} userData={{ frame: 'hero' }}>
          <group ref={heroInner}>
            <Hero model={cast.player} />
          </group>
        </group>

        {/* Hrozby. */}
        {Array.from({ length: SPAWN_SLOTS }, (_, index) => (
          <group
            key={index}
            ref={(group) => {
              threatGroups.current[index] = group;
            }}
            visible={false}
            userData={{ item: 'threat' }}
          >
            <mesh geometry={parts.markRing} material={parts.ink} position={[0, 0, THREAT_MARK.z]} />
            <mesh geometry={parts.markDisc} material={parts.mark} position={[0, 0, THREAT_MARK.z]} />
            <group
              ref={(group) => {
                threatSpin.current[index] = group;
              }}
            >
              {threatModel === undefined ? (
                <mesh geometry={parts.ball} material={parts.threat} scale={THREAT_SIZE / 2} />
              ) : (
                <group position={[0, -THREAT_SIZE / 2, 0]}>
                  <FittedModel id={threatModel} w={THREAT_SIZE} h={THREAT_SIZE} d={THREAT_SIZE} fallback={color.tomato} />
                </group>
              )}
            </group>
          </group>
        ))}
      </group>
    </>
  );
}
