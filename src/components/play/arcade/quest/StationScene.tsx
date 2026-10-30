'use client';

/**
 * Stanoviště úkolu zblízka (P32G T6): kuchař u sporáku, opravář u pracovního
 * stolu. Režim `quest_station` staví pult přes celou šířku (scéna arény ho
 * kreslí šedým kvádrem) a cíle na jeho desce; tahle vrstva nad tím kreslí:
 *
 * - kryt pultu v barvách sady (bok a deska), o kus větší než šedý kvádr;
 * - pod každým cílem základ podle slovesa: u vaření plotýnku sporáku, která
 *   hoří modrým kruhem, dokud se peče; u opravy podložku pracovního stolu;
 *   jinak prkénko;
 * - u cíle, na kterém se pracuje, okno připravenosti: kruh rudý = ještě ne,
 *   mátový a pulzuje = drž „Use“ teď; na hraně otevření bouchnou bublinky.
 *   Ostatní nehotové cíle mají kruh v barvě slunce;
 * - blízkou kameru nad pultem za hrdinou.
 *
 * Kamera bez změny sdíleného shellu: scéna arény ji staví každý snímek
 * s prioritou 0 a priorita > 0 nejde – na úrovni `low` není `EffectComposer`
 * a R3F by přestal kreslit. Kamera stanoviště se proto připojí až druhým
 * průchodem: useFrame se stejnou prioritou běží v pořadí přihlášení, takže
 * po scéně arény i po efektech. Do stavu hry vrstva nic nepíše.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Box3, Color, type Mesh, type MeshBasicMaterial, type PerspectiveCamera, Vector3 } from 'three';

import { color as brand } from '@/brand/tokens';
import { type ArcadeWorld, BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { instantiate } from '@/play/arcade/kernel';
import type { Look } from '@/play/arcade/look';
import { type CompiledInteract, interactRecord, readyWait } from '@/play/arcade/rules/interact';
import type { VerbKind } from '@/play/genre/quest';
import type { HeroAction } from '@/play/spec';

import type { TargetBody } from '../arena/TargetsMount';
import type { Burst } from '../effects/particles';
import { applyIntro, introLeft, useIntroClock } from '../look/intro';
import { FIT_MARGIN_PX, fitTall, usePlayRectRef } from '../portrait-frame';
import type { ArcadeSession } from '../session';

/** Co stanoviště potřebuje od scény arény: relaci (stav, pult z úrovně), sadu (barvy pultu) a činnost hrdiny (P37-0 T2). */
export interface Stage {
  readonly session: ArcadeSession;
  readonly look: Look;
  readonly heroAction: HeroAction;
}

export interface StationSetup extends Stage {
  readonly interact: CompiledInteract;
}

/** Kryt pultu je o tolik širší a hlubší než šedý kvádr scény a deska o tolik výš – kvádr pod ním zmizí. */
const COVER_M = 0.06;
const LIFT_M = 0.01;
const SLAB_M = 0.04;
/** Přesah desky přes bok pultu. */
const LIP_M = 0.04;
const WORKTOP = [brand['ink-soft'], brand.cream] as const;

/** Kruhy na desce (m): plamen plotýnky těsně kolem mísy pánve, plotýnka, okno připravenosti; vejdou se do hloubky desky. */
const FLAME_R = [0.27, 0.31] as const;
const PLATE_R = 0.34;
const READY_R = [0.36, 0.43] as const;

/** Modrý plamen plynu a mátové „teď“ nad prahem bloomu rigu (~1,1); rudé „ještě ne“ bez záře. */
const GAS = new Color(brand['sky-deep']).multiplyScalar(2);
const READY = new Color(brand.mint).multiplyScalar(2);
const WAIT = new Color(brand.alarm);
/** Pulz otevřeného okna (rad/s) a pouk na hraně otevření (s). */
const PULSE = 8;
const POP_S = 0.35;

/** Bublinky na hraně otevření okna, nad deskou. */
const OPEN_BURST: Omit<Burst, 'at'> = { kind: 'sparks', count: 14, colors: [brand.paper, brand.sky], life: [0.4, 0.7], speed: [0.4, 0.9], size: [0.05, 0.09], gravity: -1.2, glow: false };

/** Blízká kamera: sklon nad vodorovnou, rozsah vzdálenosti (m), okraj řady a dojezd za hrdinou (1/s). */
const PITCH = (62 * Math.PI) / 180;
const NEAR_M = 4.5;
const FAR_M = 7.5;
const ROW_MARGIN_M = 1;
const FOLLOW = 5;
/** Bod pohledu leží tolik před středem pultu (k hrdinovi). */
const AIM_FRONT_M = 0.3;
/** Na výšku (P64 T4) se do `playRect` vejde hrdina před pultem (z od −`z`, výška `h`, m) a věci na desce (`STATION_TOP_M` nad ní). */
const HERO_ROOM = { z: 0.6, h: 1.8 } as const;
const STATION_TOP_M = 0.5;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Cíl, na kterém se pracuje: s `order` první nehotový po řadě těl. */
function currentOf(targets: readonly TargetBody[], states: number): TargetBody | undefined {
  let current: TargetBody | undefined;
  for (const target of targets) if (target.state < states - 1 && (current === undefined || target.index < current.index)) current = target;
  return current;
}

/** Pult v metrech scény (x zrcadlené jako u ostatních těl). */
interface Box {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/** Pult z počátečního stavu světa – nehýbe se. */
function counterOf(world: ArcadeWorld): Box | undefined {
  const state = instantiate(world);
  const count = state[HEADER.bodyCount] as number;
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    if (world.kinds[state[base + BODY.kind] as number] !== 'counter') continue;
    const at = (field: number): number => (state[base + field] as number) / UNIT;
    return { x: -at(BODY.x), y: at(BODY.y), z: at(BODY.z), w: at(BODY.w), h: at(BODY.h), d: at(BODY.d) };
  }
  return undefined;
}

function Counter({ body, look }: { readonly body: Box; readonly look: Look }) {
  const w = body.w + COVER_M;
  const h = body.h;
  const d = body.d + COVER_M;
  // Hmota bloků sady; bez ní skříňka a světlá pracovní deska – barvy rekvizit (`tint`) daly v kuchyni rudozelený pult.
  const [side, top] = look.block ?? WORKTOP;
  return (
    <group position={[body.x, body.y, body.z]}>
      <mesh position={[0, h / 2, 0]}>
        <boxGeometry args={[w, h, d]} />
        <meshStandardMaterial color={side} roughness={0.8} />
      </mesh>
      <mesh position={[0, h + LIFT_M - SLAB_M / 2, 0]} userData={{ rigShadow: 'receive' }}>
        <boxGeometry args={[w + LIP_M, SLAB_M, d + LIP_M]} />
        <meshStandardMaterial color={top} roughness={0.5} />
      </mesh>
    </group>
  );
}

/** Základ pod cílem: plotýnka sporáku (hoří, dokud se peče), podložka pracovního stolu, nebo prkénko. */
function baseParts(kind: VerbKind | null, state: number): ReactNode[] {
  if (kind === 'cook') {
    return [
      <mesh key="plate" position={[0, LIFT_M + 0.006, 0]} userData={{ rigShadow: 'receive' }}>
        <cylinderGeometry args={[PLATE_R, PLATE_R, 0.012, 32]} />
        <meshStandardMaterial color={brand.ink} roughness={0.4} metalness={0.3} />
      </mesh>,
      state === 1 && (
        <mesh key="gas" position={[0, LIFT_M + 0.014, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ rigShadow: 'off' }}>
          <ringGeometry args={[FLAME_R[0], FLAME_R[1], 32]} />
          <meshBasicMaterial color={GAS} toneMapped={false} />
        </mesh>
      ),
    ];
  }
  const [w, d, color] = kind === 'repair' ? [1.1, 0.8, brand['ink-soft']] : [0.6, 0.6, brand['cream-deep']];
  return [
    <mesh key="mat" position={[0, LIFT_M + 0.01, 0]} userData={{ rigShadow: 'receive' }}>
      <boxGeometry args={[w, 0.02, d]} />
      <meshStandardMaterial color={color} roughness={0.9} />
    </mesh>,
  ];
}

/** Kruh okna připravenosti u cíle, na kterém se pracuje; sonda `data-quest-ready` na plátně (1 = okno otevřené). */
function ReadyRing({ session, interact, target, burst }: { readonly session: ArcadeSession; readonly interact: CompiledInteract; readonly target: TargetBody; readonly burst: (bursts: readonly Burst[]) => void }) {
  const ring = useRef<Mesh>(null);
  const canvas = useThree((three) => three.gl.domElement);
  const last = useRef<{ tick: number; open: boolean } | null>(null);
  const popAt = useRef(-Infinity);

  useFrame(() => {
    const mesh = ring.current;
    if (mesh === null) return;
    const state = session.state();
    const tick = state[HEADER.tick] as number;
    const open = readyWait(interact, interactRecord(state), target.index, tick) === 0;
    const now = performance.now() / 1000;
    // Hrana otevření, ne první snímek ani restart.
    if (open && last.current !== null && !last.current.open && tick > last.current.tick) {
      popAt.current = now;
      burst([{ ...OPEN_BURST, at: [target.x, target.y + LIFT_M + 0.12, target.z] }]);
    }
    last.current = { tick, open };
    (mesh.material as MeshBasicMaterial).color.copy(open ? READY : WAIT);
    const pop = Math.max(0, 1 - (now - popAt.current) / POP_S);
    mesh.scale.setScalar(open ? 1 + 0.08 * Math.sin(now * PULSE) + 0.4 * pop : 1);
    const flag = open ? '1' : '0';
    if (canvas.dataset.questReady !== flag) canvas.dataset.questReady = flag;
  });

  useEffect(
    () => () => {
      delete canvas.dataset.questReady;
    },
    [canvas],
  );

  return (
    <mesh ref={ring} position={[target.x, target.y + LIFT_M + 0.02, target.z]} rotation={[-Math.PI / 2, 0, 0]} userData={{ rigShadow: 'off' }}>
      <ringGeometry args={[READY_R[0], READY_R[1], 40]} />
      <meshBasicMaterial color={WAIT} toneMapped={false} />
    </mesh>
  );
}

/** Blízká kamera nad pultem za hrdinou; na výšku bod pohledu sleduje hrdinu, dokud se řada celá nevejde. */
function StationCamera({ session, counter, targets }: { readonly session: ArcadeSession; readonly counter: Box; readonly targets: readonly TargetBody[] }) {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const aim = useMemo(() => new Vector3(), []);
  const bench = useMemo(() => new Box3(), []);
  const row = useMemo(() => new Box3(), []);
  const playArea = usePlayRectRef();
  const follow = useRef<number | null>(null);
  const introClock = useIntroClock();

  useFrame((_, delta) => {
    const state = session.state();
    const heroX = -(state[bodyBase(state[HEADER.player] as number) + BODY.x] as number) / UNIT;
    const xs = targets.map((target) => target.x);
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const center = (lo + hi) / 2;
    const half = (hi - lo) / 2 + ROW_MARGIN_M;
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = clamp(half / (tan * camera.aspect), NEAR_M, FAR_M);
    const slack = Math.max(0, half - distance * tan * camera.aspect);
    const want = clamp(heroX, center - slack, center + slack);
    const x = follow.current === null ? want : follow.current + (want - follow.current) * (1 - Math.exp(-delta * FOLLOW));
    follow.current = x;
    aim.set(x, counter.y + counter.h, counter.z - AIM_FRONT_M);
    camera.position.set(aim.x, aim.y + distance * Math.sin(PITCH), aim.z - distance * Math.cos(PITCH));
    camera.lookAt(aim);
    const rect = playArea.current;
    if (camera.aspect < 1 && rect !== null) {
      // Na výšku (P64 T4): úsek pultu, který kamera do stran vidí, i s hrdinou před ním leží v `playRect` – nad tlačítkem
      // „Use“ a pod HUD. Do stran se záběr nemění. Bod pohledu jede s kamerou, ať průlet míří tam, kam herní pohled.
      const reach = distance * tan * camera.aspect * (1 - (2 * FIT_MARGIN_PX) / rect.canvas.width);
      bench.min.set(x - reach, counter.y, -HERO_ROOM.z);
      bench.max.set(x + reach, Math.max(counter.y + counter.h + STATION_TOP_M, HERO_ROOM.h), counter.z + counter.d / 2);
      row.min.set(x - reach, aim.y, aim.z);
      row.max.set(x + reach, aim.y, aim.z);
      const fit = fitTall(camera, bench, rect, { keep: row }).position;
      aim.add(fit).sub(camera.position);
      camera.position.copy(fit);
    }
    applyIntro(camera, aim, introLeft(introClock()));
    camera.updateMatrixWorld();
  });
  return null;
}

/** Připojí děti až druhým průchodem – jejich useFrame se přihlásí po všech, kdo se připojili s první. */
function Late({ children }: { readonly children: ReactNode }) {
  const [late, setLate] = useState(false);
  useEffect(() => setLate(true), []);
  return late ? children : null;
}

export function StationScene({
  session,
  look,
  interact,
  targets,
  kind,
  states,
  burst,
}: StationSetup & {
  readonly targets: readonly TargetBody[];
  readonly kind: VerbKind | null;
  readonly states: number;
  readonly burst: (bursts: readonly Burst[]) => void;
}) {
  const counter = useMemo(() => counterOf(session.world), [session]);
  const current = currentOf(targets, states);
  return (
    <>
      {counter !== undefined && <Counter body={counter} look={look} />}
      {targets.map((target) => (
        <group key={target.index} position={[target.x, target.y, target.z]}>
          {baseParts(kind, Math.min(target.state, states - 1))}
          {target.state < states - 1 && target !== current && (
            <mesh position={[0, LIFT_M + 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ rigShadow: 'off' }}>
              <ringGeometry args={[READY_R[0], READY_R[1], 40]} />
              <meshBasicMaterial color={brand.sun} />
            </mesh>
          )}
        </group>
      ))}
      {current !== undefined && <ReadyRing key={current.index} session={session} interact={interact} target={current} burst={burst} />}
      {counter !== undefined && targets.length > 0 && (
        <Late>
          <StationCamera session={session} counter={counter} targets={targets} />
        </Late>
      )}
    </>
  );
}
