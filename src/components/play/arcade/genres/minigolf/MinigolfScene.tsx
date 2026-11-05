'use client';

/**
 * Scéna minigolfu (P68 T8, kategorie `vozidla-sport`): jedna jamka z dlaždic s mantinely v místě z věty. Dráha je
 * trávník kitu, mantinely, jamka (procedurální kalíšek – katalog jamku nemá) s vlajkou `finish-flag`, odrazníky
 * a pohyblivá překážka jako věci z věty (`modelIdOf` – model druhu těla, popisek role `barrier` / `obstacle`),
 * kolem povrch, kulisy a horizont sady (`look`). Míček je hráč, kutálí se po stavu jádra – kreslí ho scéna jako
 * kouli: model `gen3d-golf-ball` má odlitý týček s trávníkem a kutálel se s ním.
 *
 * **Kamera** za míčkem po ose z míčku na cíl trasy (`minigolf-camera.ts`, míření ji nehýbe), tlumený přechod mezi klidem
 * a sledováním; na výšku přes `usePlayRectRef` + `fitTall`. **Natažení** dělá DOM vrstva `MinigolfTouch` – registr
 * `GENRE_TOUCH` montuje jen vstup `genre`, minigolf má `throw-rig`, pro který `ArcadeStage` na plátně nic nemá, takže
 * ji scéna sama připojí do kontejneru plátna (`surface`) vlastním kořenem Reactu.
 *
 * Jen obraz, mimo stav i hash: stopa míření na trávníku (délka podle nabití), valení míčku, tlumení kamery. x jádra
 * se zrcadlí jako v aréně (kamera kouká po +z, +x je vpravo), takže kladná osa míří na obrazovce doprava.
 *
 * **Volání kreslení** (P68-L T3): trávník, mantinely, sokly odrazníků a stopa míření jsou každé jedna síť – po kusech
 * stála scéna na Pixelu 7 (CPU ×4) 85 volání kreslení snímku (barva i stín) proti 44 her, které `main` pro tytéž věty
 * hraje. Rovné kusy dráhy (trávník, kalíšek s okrajem) stín jen přijímají. Na tiku 0 kamera netlumí (`minigolfFollow`).
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { type BufferAttribute, BoxGeometry, type BufferGeometry, CircleGeometry, Float32BufferAttribute, type Group, type Mesh, type PerspectiveCamera, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { color, colorHex } from '@/brand/tokens';
import { baseControlOf } from '@/play/arcade/addons';
import { BODY, HEADER, RUN_STATE, UNIT, bodyBase } from '@/play/arcade/contract';
import { minigolfLayout } from '@/play/arcade/pieces/minigolf-hole';
import { MINIGOLF, minigolfAim, minigolfDistance } from '@/play/arcade/pieces/minigolf-roll';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { Scenery } from '../../look/Scenery';
import { usePlayRectRef } from '../../portrait-frame';
import { FittedModel, type WorldProps, modelIdOf } from '../../World';
import { type MinigolfCourseView, minigolfCameraPose, minigolfCourseView, minigolfFollow } from './minigolf-camera';
import { MinigolfTouch } from './MinigolfTouch';

const m = (units: number): number => units / UNIT;
const BALL_M = m(MINIGOLF.ball);
const CUP_M = m(MINIGOLF.holeSize) / 2;
/** Vlajka v jamce (m). */
const FLAG = { w: 0.55, h: 1.6, d: 0.12 } as const;
/**
 * Stopa míření: tečky na trávníku; bez nabití krátká, s nabitím do `max` m podle dojezdu rány. Tečka `k` má neprůhlednost
 * `alpha − k · fade` (slábne ke špičce), leží `y` m nad trávníkem.
 */
const TRAIL = { dots: 10, idle: 1.2, max: 5, radius: 0.05, segments: 12, y: 0.02, alpha: 0.95, fade: 0.07 } as const;
/** Skok míčku dál než tohle (m) mezi tiky = návrat z mimo dráhy, ne pohyb. */
const JUMP = 2;
/** Tloušťka trávníku pod nulou a výška soklu odrazníku (m). */
const GREEN_H = 0.1;
const PLINTH_H = 0.06;
/** Kolik povrchu a kulis kolem dráhy (m). */
const AROUND = 30;

type MinigolfSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

interface Piece {
  readonly index: number;
  /** Střed (scéna, m; x zrcadlené), spodek `y` a rozměry. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
  readonly model: string;
}

interface Course {
  readonly view: MinigolfCourseView;
  readonly hole: Piece;
  readonly floor: readonly Piece[];
  readonly rails: readonly Piece[];
  readonly bumpers: readonly Piece[];
  readonly mover: Piece | null;
  /** Obal dráhy ve scéně (m). */
  readonly bounds: { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number };
}

/** Těla hřiště z počátečního stavu světa a rozložení z parametrů ovládání. */
function courseOf(world: MinigolfSceneProps['session']['world'], cast: MinigolfSceneProps['cast']): Course {
  const layout = minigolfLayout.parse(baseControlOf(world.control).params.layout);
  const initial = world.initial;
  const piece = (index: number): Piece => {
    const at = (slot: number): number => initial[bodyBase(index) + slot] as number;
    const kind = world.kinds[at(BODY.kind)] ?? '';
    const size = { w: m(at(BODY.w)), h: m(at(BODY.h)), d: m(at(BODY.d)) };
    return { index, x: -m(at(BODY.x)), y: m(at(BODY.y)), z: m(at(BODY.z)), ...size, model: modelIdOf({ index, kind, role: at(BODY.role), ...size }, cast) };
  };
  const range = ([first, count]: readonly [number, number]): Piece[] => Array.from({ length: count }, (_, k) => piece(first + k));
  const floor = range(layout.floor);
  return {
    view: minigolfCourseView(initial, layout),
    hole: piece(layout.hole),
    floor,
    rails: range(layout.rails),
    bumpers: range(layout.bumpers),
    mover: layout.mover === undefined ? null : piece(layout.mover),
    bounds: {
      x0: Math.min(...floor.map((tile) => tile.x - tile.w / 2)),
      x1: Math.max(...floor.map((tile) => tile.x + tile.w / 2)),
      z0: Math.min(...floor.map((tile) => tile.z - tile.d / 2)),
      z1: Math.max(...floor.map((tile) => tile.z + tile.d / 2)),
    },
  };
}

type Box = Pick<Piece, 'x' | 'y' | 'z' | 'w' | 'h' | 'd'>;

/** Kvádry (střed `x/z`, spodek `y`, m) jako jedna geometrie; prázdný seznam nic. */
function boxesGeometry(boxes: readonly Box[]): BufferGeometry | null {
  if (boxes.length === 0) return null;
  const parts = boxes.map((box) => new BoxGeometry(box.w, box.h, box.d).translate(box.x, box.y + box.h / 2, box.z));
  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
}

/**
 * Stopa míření jako jedna geometrie: `TRAIL.dots` teček v rovině trávníku, slábnutí ke špičce v alfě barvy vrcholů.
 * Polohy vrcholů píše `placeTrail`; `dot` = vrcholy jedné tečky kolem počátku (x, y, z za sebou).
 */
function trailGeometry(): { readonly geometry: BufferGeometry; readonly dot: Float32Array } {
  const dot = new CircleGeometry(TRAIL.radius, TRAIL.segments).rotateX(-Math.PI / 2);
  const parts = Array.from({ length: TRAIL.dots }, (_, k) => {
    const part = dot.clone();
    const alpha = TRAIL.alpha - k * TRAIL.fade;
    part.setAttribute('color', new Float32BufferAttribute(Array.from({ length: part.getAttribute('position').count }, () => [1, 1, 1, alpha]).flat(), 4));
    return part;
  });
  const geometry = mergeGeometries(parts);
  const offsets = Float32Array.from(dot.getAttribute('position').array);
  for (const part of [dot, ...parts]) part.dispose();
  return { geometry, dot: offsets };
}

/** Tečka `k` leží `BALL_M + (k + 1) · reach / dots` m od míčku `at` ve směru (`dx`, `dz`) – jednotkový, scéna. */
function placeTrail(position: BufferAttribute, dot: Float32Array, at: { readonly x: number; readonly z: number }, dx: number, dz: number, reach: number): void {
  const per = dot.length / 3;
  for (let k = 0; k < TRAIL.dots; k += 1) {
    const along = BALL_M + ((k + 1) * reach) / TRAIL.dots;
    const cx = at.x + dx * along;
    const cz = at.z + dz * along;
    for (let v = 0; v < per; v += 1) position.setXYZ(k * per + v, cx + (dot[3 * v] as number), TRAIL.y + (dot[3 * v + 1] as number), cz + (dot[3 * v + 2] as number));
  }
  position.needsUpdate = true;
}

/** Sokl odrazníku: nízký kvádr v půdorysu těla, kde se míček odrazí (u odrazníků jedna síť, `boxesGeometry`). */
const plinthOf = (piece: Piece): Box => ({ x: piece.x, y: 0, z: piece.z, w: piece.w, h: PLINTH_H, d: piece.d });

/** Věc z věty na hřišti: model vepsaný do těla (sokl kreslí scéna). */
function Obstacle({ piece }: { readonly piece: Piece }) {
  return <FittedModel id={piece.model} w={piece.w} h={piece.h} d={piece.d} fallback={color.tomato} />;
}

/** DOM vrstva natažení v kontejneru plátna: vlastní kořen Reactu, ať jde i ze stromu plátna (a tunelem feedu). */
function useTouchLayer(surface: React.RefObject<HTMLDivElement | null>, session: MinigolfSceneProps['session'], enabled: boolean): void {
  useEffect(() => {
    const host = surface.current;
    if (!enabled || host === null) return;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:absolute;inset:0';
    host.appendChild(holder);
    const root = createRoot(holder);
    root.render(<MinigolfTouch session={session} />);
    return () => {
      holder.remove();
      // Mimo průchod usmíření plátna: synchronní odpojení kořene uprostřed renderu React hlásí jako chybu.
      window.setTimeout(() => root.unmount(), 0);
    };
  }, [surface, session, enabled]);
}

export function MinigolfScene({ session, cast, surface, scene: look, enabled, ghost }: MinigolfSceneProps) {
  const world = session.world;
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const course = useMemo(() => courseOf(world, cast), [world, cast]);
  const playRect = usePlayRectRef();
  useTouchLayer(surface, session, enabled);

  const ball = useRef<Group | null>(null);
  const spin = useRef<Group | null>(null);
  const mover = useRef<Group | null>(null);
  const trailMesh = useRef<Mesh | null>(null);
  /** `trail` = poslední zapsaná stopa (x, z míčku, směr, dosah) – vrcholy se přepíšou, jen když se změní. */
  const memory = useRef<{ eye: Vector3; look: Vector3; at: Vector3 | null; framed: boolean; trail: number[] }>({ eye: new Vector3(), look: new Vector3(), at: null, framed: false, trail: [] });
  const scratch = useMemo(() => ({ axis: new Vector3(), step: new Vector3() }), []);
  const boxes = useMemo(
    () => ({
      green: boxesGeometry(course.floor.map((tile) => ({ ...tile, y: -GREEN_H, h: GREEN_H }))),
      rails: boxesGeometry(course.rails),
      plinths: boxesGeometry(course.bumpers.map(plinthOf)),
    }),
    [course],
  );
  useEffect(
    () => () => {
      for (const geometry of Object.values(boxes)) geometry?.dispose();
    },
    [boxes],
  );
  const trail = useMemo(trailGeometry, []);
  useEffect(() => () => trail.geometry.dispose(), [trail]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    /** Poloha těla ve scéně (m), interpolovaná; skok (návrat z mimo dráhy) se neinterpoluje. */
    const place = (body: number): { x: number; z: number } => {
      const base = bodyBase(body);
      const nx = state[base + BODY.x] as number;
      const nz = state[base + BODY.z] as number;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      return Math.hypot(m(nx - px), m(nz - pz)) > JUMP ? { x: -m(nx), z: m(nz) } : { x: -m(px + (nx - px) * alpha), z: m(pz + (nz - pz) * alpha) };
    };

    // Míček: valí se po trávníku (natočení podle ujeté dráhy), po výhře sedí v kalíšku.
    const player = state[HEADER.player] as number;
    const p = bodyBase(player);
    const won = state[HEADER.runState] === RUN_STATE.won;
    const at = won ? { x: course.hole.x, z: course.hole.z } : place(player);
    const group = ball.current;
    if (group !== null) {
      const last = memory.current.at;
      if (last !== null && spin.current !== null) {
        scratch.step.set(at.x - last.x, 0, at.z - last.z);
        const length = scratch.step.length();
        if (length > 1e-4 && length < JUMP) spin.current.rotateOnWorldAxis(scratch.axis.set(scratch.step.z, 0, -scratch.step.x).normalize(), length / (BALL_M / 2));
      }
      memory.current.at = (memory.current.at ?? new Vector3()).set(at.x, 0, at.z);
      // V jamce napůl pod okrajem kalíšku.
      group.position.set(at.x, won ? -BALL_M / 2 : 0, at.z);
    }

    // Pohyblivá překážka: kyvadlo jádra.
    if (course.mover !== null && mover.current !== null) {
      const there = place(course.mover.index);
      mover.current.position.set(there.x, 0, there.z);
    }

    // Stopa míření: ze stavu (osa, nabití), jen když míček stojí a hra běží.
    const resting = (state[p + BODY.vx] as number) === 0 && (state[p + BODY.vz] as number) === 0;
    const showTrail = !won && state[HEADER.runState] === RUN_STATE.running && resting;
    const [ax, az] = minigolfAim(state[p + BODY.aux0] as number);
    const length = Math.hypot(ax, az);
    const charge = Math.max(0, state[p + BODY.aux1] as number);
    const reach = charge > 0 ? Math.min(TRAIL.max, m(minigolfDistance(charge))) : TRAIL.idle;
    const dots = trailMesh.current;
    if (dots !== null) {
      dots.visible = showTrail;
      const next = [at.x, at.z, -ax / length, az / length, reach];
      const last = memory.current.trail;
      if (showTrail && next.some((value, k) => value !== last[k])) {
        placeTrail(dots.geometry.getAttribute('position') as BufferAttribute, trail.dot, at, next[2] as number, next[3] as number, reach);
        memory.current.trail = next;
      }
    }

    // Kamera přes rameno: póza ze stavu, tlumený přechod (první snímek a tik 0 bez tlumení).
    if (camera.view !== null) camera.clearViewOffset();
    const pose = minigolfCameraPose(state, camera.aspect, playRect.current, course.view, camera.fov);
    const ease = minigolfFollow(delta, state[HEADER.tick] as number, memory.current.framed);
    memory.current.framed = true;
    memory.current.eye.lerp(pose.position, ease);
    memory.current.look.lerp(pose.look, ease);
    camera.position.copy(memory.current.eye);
    camera.lookAt(memory.current.look);
    camera.updateMatrixWorld();
  });

  const { bounds } = course;
  const middle = (bounds.x0 + bounds.x1) / 2;
  const reach = Math.max(Math.abs(bounds.x0), Math.abs(bounds.x1), Math.abs(bounds.z0), Math.abs(bounds.z1));
  return (
    <>
      <FieldGround look={look} area={{ x0: bounds.x0 - AROUND, x1: bounds.x1 + AROUND, z0: bounds.z0 - AROUND, z1: bounds.z1 + AROUND }} y={-0.03} />
      <group position={[middle, 0, 0]}>
        <Scenery look={look} layout="sides" inner={(bounds.x1 - bounds.x0) / 2 + 3} from={bounds.z0 - 6} to={bounds.z1 + 6} />
      </group>
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={reach + 8} />

      {/* Trávník dráhy (rovný: stín jen přijímá) a mantinely – každé jedna síť. */}
      {boxes.green !== null && (
        <mesh geometry={boxes.green} receiveShadow userData={{ rigShadow: 'receive' }}>
          <meshStandardMaterial color={colorHex.grass} roughness={0.95} />
        </mesh>
      )}
      {boxes.rails !== null && (
        <mesh geometry={boxes.rails} castShadow receiveShadow>
          <meshStandardMaterial color={colorHex['cream-deep']} roughness={0.7} />
        </mesh>
      )}

      {/* Jamka: kalíšek s okrajem (rovné, stín jen přijímají) a vlajka (`frame: 'target'` pro sondu čitelnosti). */}
      <group position={[course.hole.x, 0, course.hole.z]} userData={{ frame: 'target', item: 'goal' }}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]} receiveShadow userData={{ rigShadow: 'receive' }}>
          <circleGeometry args={[CUP_M, 32]} />
          <meshBasicMaterial color={colorHex.ink} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]} receiveShadow userData={{ rigShadow: 'receive' }}>
          <ringGeometry args={[CUP_M, CUP_M + 0.06, 32]} />
          <meshStandardMaterial color={colorHex.paper} roughness={0.6} />
        </mesh>
        <FittedModel id="finish-flag" w={FLAG.w} h={FLAG.h} d={FLAG.d} fallback={color.tomato} />
      </group>

      {/* Odrazníky a pohyblivá překážka: věci z věty; sokly odrazníků jedna síť, pohyblivá překážka si nese svůj. */}
      {boxes.plinths !== null && (
        <mesh geometry={boxes.plinths} receiveShadow>
          <meshStandardMaterial color={colorHex.ink} roughness={0.8} />
        </mesh>
      )}
      {course.bumpers.map((bumper) => (
        <group key={`bumper-${String(bumper.index)}`} position={[bumper.x, 0, bumper.z]} userData={{ item: 'obstacle' }}>
          <Obstacle piece={bumper} />
        </group>
      ))}
      {course.mover !== null && (
        <group ref={mover} position={[course.mover.x, 0, course.mover.z]} userData={{ item: 'obstacle' }}>
          <mesh position={[0, PLINTH_H / 2, 0]} receiveShadow>
            <boxGeometry args={[course.mover.w, PLINTH_H, course.mover.d]} />
            <meshStandardMaterial color={colorHex.ink} roughness={0.8} />
          </mesh>
          <Obstacle piece={course.mover} />
        </group>
      )}

      {/* Míček (hráč). */}
      {/* Koule s plochými stěnami, ať je valení vidět; točí se kolem středu (`spin` ve výšce poloměru). */}
      <group ref={ball} userData={{ frame: 'hero' }}>
        <group ref={spin} position={[0, BALL_M / 2, 0]}>
          <mesh castShadow>
            <icosahedronGeometry args={[BALL_M / 2, 1]} />
            <meshStandardMaterial color={colorHex.paper} roughness={0.5} flatShading />
          </mesh>
        </group>
      </group>

      {/* Stopa míření: pomůcka, mlha rigu ji nezakryje a stín nevrhá; vrcholy píše scéna, obal se nepočítá. */}
      <mesh ref={trailMesh} geometry={trail.geometry} visible={false} frustumCulled={false} userData={{ rigShadow: 'none' }}>
        <meshBasicMaterial color={colorHex.paper} vertexColors transparent fog={false} />
      </mesh>
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
