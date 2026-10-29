'use client';

/**
 * Scéna šipek (P66 T9): mřížka kusů z věty (model věci, nad ním odznak se šipkou směru) na zemi místa věty, hrdina
 * z věty stojí za mřížkou čelem k hráči. Kamera kouká po +z shora pod úhlem `VIEW.pitch` (x jádra kreslí zrcadlově
 * jako ostatní scény), takže sloupec 0 je vlevo a řada 0 nahoře.
 *
 * **Na výšku** (`fitTall`) leží mřížka běžícího kola celá v pásu `tapRect` – ve spodních 45 % plátna nad dolní řadou
 * HUD, kde na ni dosáhne palec; nad ní je vidět hrdina a místo. **Na šířku** vlastní póza: mřížka i hrdina uprostřed.
 * S novým kolem (větší mřížka) kamera plynule couvne.
 *
 * Plocha dostane `data-lane-cells` („sloupce,řady,vlevo,nahoře,vpravo,dole“ ve zlomcích plátna): podle něj
 * `lanes-input.ts` (`cellAxisAt`) promění ťuk prstu v buňku v ose záznamu. Rohy mřížky se promítají skutečnou
 * kamerou; perspektiva dělá z mřížky mírný lichoběžník, proto se boky průměrují (střed každé buňky padne do své
 * buňky, `VIEW.fov` je úzký, ať je lichoběžník malý). Dál `data-arrows-cursor` (buňka kurzoru klávesnice, −1 = žádný)
 * a `data-player-x`.
 *
 * Co jádro nevidí, je jen obraz: odlet kusu po šipce z mřížky ven, náraz (kus poskočí ke kusu v cestě a vrátí se,
 * odznak blikne), naskočení kusů nového kola, kurzor. Stav ani hash nemění.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box3, type Group, type Mesh, MeshStandardMaterial, type PerspectiveCamera, Shape, Vector3 } from 'three';

import { color, size, space } from '@/brand/tokens';
import { BODY, COUNTER, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp, nativeRule } from '@/play/arcade/contract';
import { hooksOf, inBreak, roundOf } from '@/play/arcade/hooks';
import { SURFACES } from '@/play/arcade/look';
import { riggedCharacter } from '@/play/arcade/models';
import { type ArrowsTapParams, cursorOf, gridOfRound, heroZOf, tapOf } from '@/play/arcade/pieces/arrows';
import { ARROWS, type ArrowsGrid, DIR_STEP, cellAt, dirOfCode, roundOfCode } from '@/play/arcade/pieces/arrows-level';

import { renderHeld } from '../../effects/render-feel';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { Scenery } from '../../look/Scenery';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { HUD_BAND_PX, type PlayRect, fitTall } from '../portrait-first';

const m = (units: number): number => units / UNIT;
const CELL = m(ARROWS.cell);
const PIECE = { w: m(ARROWS.piece.w), h: m(ARROWS.piece.h), d: m(ARROWS.piece.d) };
const HERO = { w: m(ARROWS.hero.w), h: m(ARROWS.hero.h), d: m(ARROWS.hero.d) };

const VIEW = {
  /** Úhel pohledu pod vodorovnou (rad): mřížka skoro shora, hrdina za ní ještě stojí. */
  pitch: 0.98,
  /** Úzký zorný úhel scény (°): menší lichoběžník mřížky, buňky na celé ploše stejně velké. */
  fov: 32,
  /** Pás klepání začíná tady (podíl výšky plátna): spodních 45 %. */
  tapTop: 0.55,
  /** Dolní řada HUD pod mřížkou (px): odsazení, řada kol, mezera. */
  bottomPx: space['4'] + size['control-l'] + space['3'],
  /** Jak rychle kamera dojede na mřížku nového kola (1/s). */
  ease: 4,
} as const;

/** Na šířku se hrdina rámuje i s rezervou na zvětšení čitelností (`LEGIBLE_CAP` 2, obvykle méně). */
const LANDSCAPE_HERO = 1.6;

/** Odlet (s), náraz (s), naskočení kusu nového kola (s) a rozestup naskočení po kusech (s). */
const FLY_S = 0.45;
const BUMP_S = 0.3;
const POP_S = 0.25;
const POP_STAGGER_S = 0.025;
/** Kam až kus odletí: za okraj mřížky o tolik buněk. */
const FLY_BEYOND = 2;
/** O kolik buňky kus při nárazu poskočí. */
const BUMP_REACH = 0.3;
const LAND = { x0: -30, x1: 30, z0: -30, z1: 40 } as const;

type ArrowsSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

/** Kus z úrovně: tělo, kolo, buňka, směr a poloha ve scéně (x zrcadlené). */
interface PieceView {
  readonly body: number;
  readonly round: number;
  readonly cell: number;
  readonly dir: number;
  readonly x: number;
  readonly z: number;
  /** Pořadí v kole – rozestup naskočení. */
  readonly order: number;
}

/** Obraz kusu mezi snímky: viděn živý, čas od odletu / nárazu / naskočení (−1 = neběží). */
interface PieceAnim {
  alive: boolean;
  fly: number;
  bump: number;
  pop: number;
}

/** Směr ve scéně (x zrcadlené): krok mřížky [sloupec, řada] → [x, z]. Řada roste ke kameře (−z), sloupec doprava (−x). */
const sceneStep = (dir: number): readonly [number, number] => {
  const [dc, dr] = DIR_STEP[dir] as readonly [number, number];
  return [-dc, -dr];
};

/** Natočení modelu (čelem po +z) po šipce. */
const yawOf = (dir: number): number => {
  const [sx, sz] = sceneStep(dir);
  return Math.atan2(sx, sz);
};

/** Buněk od kusu k okraji ve směru šipky (+ `FLY_BEYOND`): tak daleko odletí. */
function flightCells(grid: ArrowsGrid, cell: number, dir: number): number {
  const col = cell % grid.cols;
  const row = Math.floor(cell / grid.cols);
  const left = [row, grid.cols - 1 - col, grid.rows - 1 - row, col][dir] as number;
  return left + FLY_BEYOND;
}

/** Největší mřížka hry (finále): plocha místa a kulisy se staví na ni. */
const largest = (grids: readonly ArrowsGrid[]): ArrowsGrid => grids.reduce((big, grid) => (grid.cols * grid.rows > big.cols * big.rows ? grid : big));

/** Pás klepání na plátně `width × height`: spodních 45 % nad dolní řadou HUD. */
export const tapRect = (width: number, height: number): PlayRect => ({ width, height, top: Math.max(HUD_BAND_PX, height * VIEW.tapTop), bottom: height - VIEW.bottomPx });

/** Šipka odznaku: dřík a hrot v rovině x–y, hrot po +y (odznak se položí, +y míří po šipce). */
function arrowShape(): Shape {
  const shape = new Shape();
  shape.moveTo(-0.09, -0.3);
  shape.lineTo(0.09, -0.3);
  shape.lineTo(0.09, 0.02);
  shape.lineTo(0.24, 0.02);
  shape.lineTo(0, 0.32);
  shape.lineTo(-0.24, 0.02);
  shape.lineTo(-0.09, 0.02);
  shape.closePath();
  return shape;
}

/** Čáry stání a obrubník mřížky kola (barva krému na zemi místa). */
function GridLines({ grid }: { readonly grid: ArrowsGrid }) {
  const width = grid.cols * CELL;
  const depth = grid.rows * CELL;
  return (
    <group>
      {Array.from({ length: grid.cols + 1 }, (_, col) => (
        <mesh key={`c${col}`} position={[width / 2 - col * CELL, 0.01, 0]} receiveShadow>
          <boxGeometry args={[0.08, 0.02, depth]} />
          <meshStandardMaterial color={color.cream} roughness={0.9} />
        </mesh>
      ))}
      {Array.from({ length: grid.rows + 1 }, (_, row) => (
        <mesh key={`r${row}`} position={[0, 0.01, depth / 2 - row * CELL]} receiveShadow>
          <boxGeometry args={[width, 0.02, 0.08]} />
          <meshStandardMaterial color={color.cream} roughness={0.9} />
        </mesh>
      ))}
      {/* Obrubník kolem mřížky: tady kusy vyjíždějí ven. */}
      {[1, -1].map((side) => (
        <mesh key={`x${side}`} position={[(side * (width + 0.5)) / 2, 0.06, 0]} castShadow receiveShadow>
          <boxGeometry args={[0.5, 0.12, depth + 1]} />
          <meshStandardMaterial color={color['cream-deep']} roughness={0.85} />
        </mesh>
      ))}
      {[1, -1].map((side) => (
        <mesh key={`z${side}`} position={[0, 0.06, (side * (depth + 0.5)) / 2]} castShadow receiveShadow>
          <boxGeometry args={[width + 1, 0.12, 0.5]} />
          <meshStandardMaterial color={color['cream-deep']} roughness={0.85} />
        </mesh>
      ))}
    </group>
  );
}

/** Náhrada modelu kusu: zaoblený kvádr v barvě kitu se „světly“ vpředu, ať je vidět, kam míří. */
function PiecePrimitive() {
  return (
    <group>
      <mesh position={[0, PIECE.h * 0.45, 0]} castShadow>
        <boxGeometry args={[PIECE.w * 0.7, PIECE.h * 0.8, PIECE.d * 0.95]} />
        <meshStandardMaterial color={color['sky-deep']} roughness={0.6} />
      </mesh>
      <mesh position={[0, PIECE.h * 0.5, PIECE.d * 0.48]}>
        <boxGeometry args={[PIECE.w * 0.5, PIECE.h * 0.2, 0.04]} />
        <meshStandardMaterial color={color.sun} emissive={color.sun} emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

export function ArrowsScene({ session, cast, surface, scene: look }: ArrowsSceneProps) {
  const world = session.world;
  const tap = useMemo(() => nativeRule(world.rules, 'arrows_tap')?.params as ArrowsTapParams, [world]);
  const keeper = useMemo(() => hooksOf(world.rules)?.keeper ?? tap.keeper, [world, tap]);
  const grids = tap.grids;
  const pieces = useMemo(() => {
    const out: PieceView[] = [];
    const initial = Int32Array.from(world.initial);
    const orders = grids.map(() => 0);
    for (let body = 1; body < (initial[HEADER.bodyCount] as number); body += 1) {
      const base = bodyBase(body);
      if (initial[base + BODY.role] !== ROLE.target) continue;
      const code = bodyHp(initial, body);
      if (code <= 0) continue;
      const round = roundOfCode(code);
      const grid = gridOfRound(grids, round);
      const x = initial[base + BODY.x] as number;
      const z = initial[base + BODY.z] as number;
      out.push({ body, round, cell: cellAt(grid, x, z), dir: dirOfCode(code), x: -m(x), z: m(z), order: orders[round]!++ });
    }
    return out;
  }, [world, grids]);
  const [shown, setShown] = useState(0);
  const groups = useRef<(Group | null)[]>([]);
  const badges = useRef<(Mesh | null)[]>([]);
  const anims = useRef<PieceAnim[]>([]);
  const hero = useRef<Group | null>(null);
  const cursorRing = useRef<Group | null>(null);
  const lastRound = useRef(-1);
  const lastHealth = useRef(-1);
  const lastTick = useRef(-1);
  const fit = useRef<{ distance: number; shift: number; heroZ: number } | null>(null);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const view = useThree((three) => three.size);
  const probe = useMemo(() => new Vector3(), []);
  const center = useMemo(() => new Vector3(), []);
  const box = useMemo(() => new Box3(), []);
  /** Směr od středu mřížky ke kameře: za ní (−z) a nad ní pod `VIEW.pitch`. */
  const back = useMemo(() => new Vector3(0, Math.sin(VIEW.pitch), -Math.cos(VIEW.pitch)), []);
  const arrowGeometry = useMemo(() => arrowShape(), []);
  const heroRig = riggedCharacter(cast.player);
  const pieceModel = cast.things?.piece;
  // Odznaky sdílí tři materiály; náraz odznak na chvíli přepne na poplach.
  const materials = useMemo(
    () => ({
      calm: new MeshStandardMaterial({ color: color.cream, roughness: 0.7 }),
      bumped: new MeshStandardMaterial({ color: color.alarm, emissive: color.alarm, emissiveIntensity: 0.5 }),
      arrow: new MeshStandardMaterial({ color: color.ink, roughness: 0.8 }),
    }),
    [],
  );
  useEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);

  // Úzký zorný úhel jen pro tuhle scénu; po odchodu se vrátí i posun záběru.
  useEffect(() => {
    const fov = camera.fov;
    camera.fov = VIEW.fov;
    camera.updateProjectionMatrix();
    return () => {
      camera.fov = fov;
      camera.clearViewOffset();
      camera.updateProjectionMatrix();
    };
  }, [camera]);

  useFrame((_, delta) => {
    session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const player = state[HEADER.player] as number;
    // V přestávce po kole už scéna ukazuje mřížku dalšího kola: kusy naskočí a kamera couvne, než kolo začne.
    const running = roundOf(state, keeper);
    const round = inBreak(state, keeper) && running + 1 < grids.length ? running + 1 : running;
    const grid = gridOfRound(grids, round);
    if (round !== shown) setShown(round);
    const fresh = round !== lastRound.current;
    lastRound.current = round;

    // Náraz: srdce ubylo a ťuk tiku míří na kus. Jen když snímek viděl právě jeden tik – ťuk staršího tiku už ve stavu není.
    const health = state[HEADER.counters + COUNTER.health] as number;
    const tick = state[HEADER.tick] as number;
    const bumpedCell = lastHealth.current >= 0 && health < lastHealth.current && tick === lastTick.current + 1 ? tapOf(state, player) - 1 : -1;
    lastHealth.current = health;
    lastTick.current = tick;

    if (anims.current.length !== pieces.length) anims.current = pieces.map(() => ({ alive: true, fly: -1, bump: -1, pop: -1 }));
    pieces.forEach((piece, index) => {
      const anim = anims.current[index] as PieceAnim;
      const group = groups.current[index];
      const alive = ((state[bodyBase(piece.body) + BODY.flags] as number) & FLAG.alive) !== 0;
      if (anim.alive && !alive) anim.fly = 0;
      anim.alive = alive;
      if (fresh && piece.round === round && round > 0) anim.pop = 0;
      if (alive && piece.round === round && piece.cell === bumpedCell) anim.bump = 0;
      if (group === null || group === undefined) return;
      const flying = anim.fly >= 0 && anim.fly < FLY_S;
      group.visible = (alive && piece.round === round) || flying;
      if (!group.visible) return;
      const [sx, sz] = sceneStep(piece.dir);
      let reach = 0;
      let scale = 1;
      if (flying) {
        const t = anim.fly / FLY_S;
        reach = flightCells(gridOfRound(grids, piece.round), piece.cell, piece.dir) * CELL * t * t;
        scale = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        anim.fly += delta;
      } else if (anim.bump >= 0) {
        reach = Math.sin((Math.PI * Math.min(1, anim.bump / BUMP_S))) * BUMP_REACH * CELL;
        anim.bump = anim.bump + delta >= BUMP_S ? -1 : anim.bump + delta;
      }
      if (anim.pop >= 0) {
        const t = Math.max(0, anim.pop - piece.order * POP_STAGGER_S) / POP_S;
        scale *= Math.min(1, t);
        anim.pop = t >= 1 ? -1 : anim.pop + delta;
      }
      group.position.set(piece.x + sx * reach, 0, piece.z + sz * reach);
      group.scale.setScalar(Math.max(0.001, scale));
      const badge = badges.current[index];
      if (badge !== null && badge !== undefined) badge.material = anim.bump >= 0 ? materials.bumped : materials.calm;
    });

    // Kurzor klávesnice nad kusem běžícího kola.
    const cursor = cursorOf(state, player) - 1;
    const ring = cursorRing.current;
    const target = cursor >= 0 ? pieces.find((piece) => piece.round === running && piece.cell === cursor && ((state[bodyBase(piece.body) + BODY.flags] as number) & FLAG.alive) !== 0) : undefined;
    if (ring !== null) {
      ring.visible = target !== undefined;
      if (target !== undefined) ring.position.set(target.x, 0.04, target.z);
    }

    // Kamera: mřížka běžícího kola v pásu klepání; s novým kolem plynule dojede.
    const width = grid.cols * CELL;
    const depth = grid.rows * CELL;
    const heroZ = m(heroZOf(grid.rows));
    box.min.set(-width / 2, 0, -depth / 2);
    box.max.set(width / 2, PIECE.h, depth / 2);
    center.set(0, 0, 0);
    camera.position.copy(back).multiplyScalar(60);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    let wanted: { distance: number; shift: number };
    if (camera.aspect < 1) wanted = fitTall(camera, box, tapRect(view.width, view.height));
    else {
      // Na šířku mřížka i hrdina (s rezervou na zvětšení čitelností) mezi pásy HUD: výška záběru od přední hrany mřížky
      // po temeno hrdiny po ose „nahoru“ kamery, šířka mřížky; střed záběru mezi nimi.
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const top = HERO.h * LANDSCAPE_HERO;
      const tall = (heroZ + depth / 2) * Math.sin(VIEW.pitch) + top * Math.cos(VIEW.pitch);
      const usable = Math.max(0.5, (view.height - HUD_BAND_PX - VIEW.bottomPx) / view.height);
      wanted = { distance: Math.max((width / 2 + 1) / (tan * camera.aspect), tall / 2 / (tan * usable)), shift: 0 };
    }
    const now = fit.current;
    const alpha = now === null ? 1 : 1 - Math.exp(-delta * VIEW.ease);
    const next = {
      distance: now === null ? wanted.distance : now.distance + (wanted.distance - now.distance) * alpha,
      shift: now === null ? wanted.shift : now.shift + (wanted.shift - now.shift) * alpha,
      heroZ: now === null ? heroZ : now.heroZ + (heroZ - now.heroZ) * alpha,
    };
    fit.current = next;
    // Na šířku střed záběru mezi přední hranou mřížky a temenem hrdiny.
    if (camera.aspect >= 1) center.set(0, (HERO.h * LANDSCAPE_HERO) / 2, (next.heroZ - depth / 2) / 2);
    camera.position.copy(back).multiplyScalar(next.distance).add(center);
    camera.lookAt(center);
    if (camera.aspect < 1) camera.setViewOffset(view.width, view.height, 0, next.shift, view.width, view.height);
    else camera.clearViewOffset();
    camera.updateMatrixWorld();
    hero.current?.position.set(0, 0, next.heroZ);

    const host = surface.current;
    if (host === null) return;
    const at = (x: number, z: number): readonly [number, number] => {
      probe.set(x, 0, z).project(camera);
      return [(probe.x + 1) / 2, (1 - probe.y) / 2];
    };
    // Sloupec 0 je vlevo (x scény +), řada 0 nahoře (z +).
    const [farLeftX, farY] = at(width / 2, depth / 2);
    const [farRightX] = at(-width / 2, depth / 2);
    const [nearLeftX, nearY] = at(width / 2, -depth / 2);
    const [nearRightX] = at(-width / 2, -depth / 2);
    const cells = [grid.cols, grid.rows, (farLeftX + nearLeftX) / 2, farY, (farRightX + nearRightX) / 2, nearY].map((value, index) => (index < 2 ? String(value) : value.toFixed(4))).join(',');
    if (host.dataset.laneCells !== cells) host.dataset.laneCells = cells;
    const cursorText = String(target === undefined ? -1 : cursor);
    if (host.dataset.arrowsCursor !== cursorText) host.dataset.arrowsCursor = cursorText;
    host.dataset.playerX = probe.set(0, HERO.h, next.heroZ).project(camera).x.toFixed(3);
  });

  const showGrid = gridOfRound(grids, shown);
  const lot = largest(grids);
  const behind = m(heroZOf(lot.rows)) + 2.5;
  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={26} />
      {/* Plocha místa pod mřížkou i dráhou odletu v povrchu cesty sady (parkoviště = asfalt, přístav = prkna). */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.005, 0]} receiveShadow>
        <planeGeometry args={[(lot.cols + 2 * FLY_BEYOND) * CELL, (lot.rows + 2 * FLY_BEYOND) * CELL]} />
        <meshStandardMaterial color={SURFACES[look.surface].color} roughness={0.95} />
      </mesh>
      {/* Kulisy místa v řadě za hrdinou: na výšku plní horní část obrazu nad mřížkou. */}
      <group rotation={[0, -Math.PI / 2, 0]}>
        <Scenery look={look} layout="behind" inner={behind} from={-10} to={10} />
      </group>
      <GridLines key={shown} grid={showGrid} />
      <group ref={hero} rotation={[0, Math.PI, 0]} userData={{ frame: 'hero' }}>
        {heroRig !== undefined ? (
          <RiggedModel character={heroRig} h={HERO.h} clip={() => 'idle'} fallback={color['sky-deep']} />
        ) : (
          <FittedModel id={cast.player} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
        )}
      </group>
      <group ref={cursorRing} visible={false}>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.78, 0.95, 32]} />
          <meshStandardMaterial color={color.sun} emissive={color.sun} emissiveIntensity={0.6} />
        </mesh>
      </group>
      {pieces.map((piece, index) => (
        <group
          key={piece.body}
          ref={(group) => {
            groups.current[index] = group;
          }}
          position={[piece.x, 0, piece.z]}
          visible={piece.round === 0}
          userData={{ item: 'piece' }}
        >
          <group rotation={[0, yawOf(piece.dir), 0]}>
            {pieceModel !== undefined ? <FittedModel id={pieceModel} w={PIECE.w} h={PIECE.h} d={PIECE.d} fallback={color['sky-deep']} /> : <PiecePrimitive />}
          </group>
          {/* Odznak se šipkou nad kusem: krémový kotouč, inkoustová šipka po směru. */}
          <group position={[0, PIECE.h + 0.25, 0]} rotation={[-Math.PI / 2, 0, yawOf(piece.dir) + Math.PI]}>
            <mesh
              ref={(mesh) => {
                badges.current[index] = mesh;
              }}
              material={materials.calm}
            >
              <circleGeometry args={[0.42, 24]} />
            </mesh>
            <mesh position={[0, 0, 0.01]} material={materials.arrow}>
              <shapeGeometry args={[arrowGeometry]} />
            </mesh>
          </group>
        </group>
      ))}
    </>
  );
}
