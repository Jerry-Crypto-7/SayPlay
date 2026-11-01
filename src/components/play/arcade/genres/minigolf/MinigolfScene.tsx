'use client';

/**
 * Scéna minigolfu (P68 T8, kategorie `vozidla-sport`): jedna jamka z dlaždic s mantinely v místě z věty. Dráha je
 * trávník kitu, mantinely, jamka (procedurální kalíšek – katalog jamku nemá) s vlajkou `finish-flag`, odrazníky
 * a pohyblivá překážka jako věci z věty (`modelIdOf` – model druhu těla, popisek role `barrier` / `obstacle`),
 * kolem povrch, kulisy a horizont sady (`look`). Míček je hráč (`gen3d-golf-ball`), kutálí se po stavu jádra.
 *
 * **Kamera** přes rameno za míčkem ve směru míření ze stavu (`minigolf-camera.ts`), tlumený přechod mezi klidem
 * a sledováním; na výšku přes `usePlayRectRef` + `fitTall`. **Natažení** dělá DOM vrstva `MinigolfTouch` – registr
 * `GENRE_TOUCH` montuje jen vstup `genre`, minigolf má `throw-rig`, pro který `ArcadeStage` na plátně nic nemá, takže
 * ji scéna sama připojí do kontejneru plátna (`surface`) vlastním kořenem Reactu.
 *
 * Jen obraz, mimo stav i hash: stopa míření na trávníku (délka podle nabití), valení míčku, tlumení kamery. x jádra
 * se zrcadlí jako v aréně (kamera kouká po +z, +x je vpravo), takže kladná osa míří na obrazovce doprava.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { type Group, type Mesh, type PerspectiveCamera, Vector3 } from 'three';

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
import { type MinigolfCourseView, minigolfCameraPose, minigolfCourseView } from './minigolf-camera';
import { MinigolfTouch } from './MinigolfTouch';

const m = (units: number): number => units / UNIT;
const BALL_M = m(MINIGOLF.ball);
const CUP_M = m(MINIGOLF.holeSize) / 2;
/** Vlajka v jamce (m). */
const FLAG = { w: 0.55, h: 1.6, d: 0.12 } as const;
/** Stopa míření: tečky na trávníku; bez nabití krátká, s nabitím do `max` m podle dojezdu rány. */
const TRAIL = { dots: 10, idle: 1.2, max: 5, radius: 0.05 } as const;
/** Tlumení kamery (1/s) a skok míčku dál než tohle (m) mezi tiky = návrat z mimo dráhy, ne pohyb. */
const FOLLOW = 5;
const JUMP = 2;
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
  readonly ball: string;
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
  const player = initial[HEADER.player] as number;
  return {
    view: minigolfCourseView(initial, layout),
    ball: world.kinds[initial[bodyBase(player) + BODY.kind] as number] ?? 'ball',
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

/** Věc z věty na hřišti: nízký sokl v půdorysu těla (kde se míček odrazí) a model vepsaný do těla. */
function Obstacle({ piece }: { readonly piece: Piece }) {
  return (
    <>
      <mesh position={[0, 0.03, 0]} receiveShadow>
        <boxGeometry args={[piece.w, 0.06, piece.d]} />
        <meshStandardMaterial color={colorHex.ink} roughness={0.8} />
      </mesh>
      <FittedModel id={piece.model} w={piece.w} h={piece.h} d={piece.d} fallback={color.tomato} />
    </>
  );
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
  const dots = useRef<(Mesh | null)[]>([]);
  const memory = useRef<{ eye: Vector3; look: Vector3; at: Vector3 | null; framed: boolean }>({ eye: new Vector3(), look: new Vector3(), at: null, framed: false });
  const scratch = useMemo(() => ({ axis: new Vector3(), step: new Vector3() }), []);

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
    dots.current.forEach((dot, k) => {
      if (dot === null) return;
      dot.visible = showTrail;
      const along = BALL_M + ((k + 1) * reach) / TRAIL.dots;
      dot.position.set(at.x - (ax / length) * along, 0.02, at.z + (az / length) * along);
    });

    // Kamera přes rameno: póza ze stavu, tlumený přechod (první snímek bez tlumení).
    if (camera.view !== null) camera.clearViewOffset();
    const pose = minigolfCameraPose(state, camera.aspect, playRect.current, course.view, camera.fov);
    const ease = memory.current.framed ? 1 - Math.exp(-FOLLOW * Math.min(delta, 0.1)) : 1;
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

      {/* Trávník dráhy a mantinely. */}
      {course.floor.map((tile) => (
        <mesh key={`tile-${String(tile.index)}`} position={[tile.x, -0.05, tile.z]} receiveShadow>
          <boxGeometry args={[tile.w, 0.1, tile.d]} />
          <meshStandardMaterial color={colorHex.grass} roughness={0.95} />
        </mesh>
      ))}
      {course.rails.map((rail) => (
        <mesh key={`rail-${String(rail.index)}`} position={[rail.x, rail.y + rail.h / 2, rail.z]} castShadow receiveShadow>
          <boxGeometry args={[rail.w, rail.h, rail.d]} />
          <meshStandardMaterial color={colorHex['cream-deep']} roughness={0.7} />
        </mesh>
      ))}

      {/* Jamka: kalíšek s okrajem a vlajka (`frame: 'target'` pro sondu čitelnosti). */}
      <group position={[course.hole.x, 0, course.hole.z]} userData={{ frame: 'target', item: 'goal' }}>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
          <circleGeometry args={[CUP_M, 32]} />
          <meshBasicMaterial color={colorHex.ink} />
        </mesh>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.006, 0]}>
          <ringGeometry args={[CUP_M, CUP_M + 0.06, 32]} />
          <meshStandardMaterial color={colorHex.paper} roughness={0.6} />
        </mesh>
        <FittedModel id="finish-flag" w={FLAG.w} h={FLAG.h} d={FLAG.d} fallback={color.tomato} />
      </group>

      {/* Odrazníky a pohyblivá překážka: věci z věty. */}
      {course.bumpers.map((bumper) => (
        <group key={`bumper-${String(bumper.index)}`} position={[bumper.x, 0, bumper.z]} userData={{ item: 'obstacle' }}>
          <Obstacle piece={bumper} />
        </group>
      ))}
      {course.mover !== null && (
        <group ref={mover} position={[course.mover.x, 0, course.mover.z]} userData={{ item: 'obstacle' }}>
          <Obstacle piece={course.mover} />
        </group>
      )}

      {/* Míček (hráč). */}
      {/* Model stojí spodkem na nule: točí se kolem středu (`spin` ve výšce poloměru), ne kolem spodku. */}
      <group ref={ball} userData={{ frame: 'hero' }}>
        <group ref={spin} position={[0, BALL_M / 2, 0]}>
          <group position={[0, -BALL_M / 2, 0]}>
            <FittedModel id={course.ball} w={BALL_M} h={BALL_M} d={BALL_M} fallback={color.paper} />
          </group>
        </group>
      </group>

      {/* Stopa míření: pomůcka, mlha rigu ji nezakryje a stín nevrhá. */}
      {Array.from({ length: TRAIL.dots }, (_, k) => (
        <mesh
          key={`dot-${String(k)}`}
          ref={(mesh) => {
            dots.current[k] = mesh;
          }}
          visible={false}
          rotation={[-Math.PI / 2, 0, 0]}
          userData={{ rigShadow: 'none' }}
        >
          <circleGeometry args={[TRAIL.radius, 12]} />
          <meshBasicMaterial color={colorHex.paper} transparent opacity={0.95 - k * 0.07} fog={false} />
        </mesh>
      ))}
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
