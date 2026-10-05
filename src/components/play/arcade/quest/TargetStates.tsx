'use client';

/**
 * Stavy cílů úkolu před očima (P32G T5). Vrstva `targets` scény arény kreslí
 * každý cíl podle druhu slovesa (`verbKind`) a stavu:
 *
 * - `fire`: strom v plamenech se žárem → začouzený a kouří → zelený, zachráněný;
 * - `flame`: svíčka s knotem → plamínek se září (bloom);
 * - `cook`: syrové těsto na pánvi → bublinky a pára → zlatá palačinka s leskem;
 * - `repair`: stroj jiskří a kouří, kontrolka rudá → kontrolka svítí čistě;
 * - `free`: zvíře v zavřené kleci → klec převržená, zvíře venku skáče;
 * - `grow`: semínko v hlíně → výhonek → rostlina s květem.
 *
 * Sloveso bez druhu („paint“) kreslí kvádr v barvě stavu. Nedokončený cíl má na
 * zemi kroužek, hotový ho ztratí. Modely jsou z katalogu (`FittedModel`), dokud
 * se nenačtou nebo když chybí, stojí na jejich místě kvádr v paletě.
 *
 * Částice jsou smyčky three.quarks ve vlastní dávce, s tečkou jako efekty A;
 * přechod stavu bouchne záblesk přes `createParticleDirector` efektů A. Bodová
 * světla jsou čtyři pořád (počet světel se nemění, shadery se nepřekládají) a
 * dostanou je svítící cíle nejblíž kameře; ostatní září emisí nad prahem bloomu.
 * Do stavu hry vrstva nic nepíše.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type ReactElement, type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import { AdditiveBlending, Color, DataTexture, type Group, LinearFilter, MeshBasicMaterial, NormalBlending, type PointLight, RGBAFormat } from 'three';
import {
  ApplyForce,
  BatchedRenderer,
  Bezier,
  ColorOverLife,
  ColorRange,
  ConstantValue,
  Gradient,
  IntervalValue,
  ParticleSystem,
  PiecewiseBezier,
  Vector3 as QVector3,
  Vector4 as QVector4,
  RenderMode,
  SizeOverLife,
  SphereEmitter,
} from 'three.quarks';

import { color as brand } from '@/brand/tokens';
import type { ArcadeWorld } from '@/play/arcade/contract';
import type { VerbKind } from '@/play/genre/quest';

import type { TargetBody, TargetLayer } from '../arena/TargetsMount';
import { type Burst, createParticleDirector } from '../effects/particles';
import { FittedModel } from '../World';
import { type Stage, StationScene, type StationSetup } from './StationScene';
import { EMITTERS, type EmitterKind, type EmitterPreset, KIND_BODY, MAX_LIGHTS, fxOf, lightsOf, questVerbOf, risenBursts } from './verbFx';

/**
 * Vrstva cílů pro svět s pravidlem `interact`; jiný svět nechá obrysy místa pro
 * vrstvu. Stanoviště (`order`) s relací a sadou (`stage`) dostane i pult,
 * okno připravenosti a blízkou kameru (`StationScene`).
 */
export function questTargets(world: Pick<ArcadeWorld, 'rules'>, stage?: Stage): TargetLayer | undefined {
  const verb = questVerbOf(world);
  if (verb === null) return undefined;
  const { kind, states, interact } = verb;
  const station = interact.order === true && stage !== undefined ? { ...stage, interact } : undefined;
  return (targets) => <TargetStates targets={targets} kind={kind} states={states} station={station} />;
}

// ---------------------------------------------------------------------------
// Tvary stavů – čisté funkce, test porovnává jejich strom

/** Záře nad prahem bloomu rigu (~1,1): žár ohně, plamínek, kontrolka. */
const BLAZE = new Color(brand.tomato).multiplyScalar(2);
const WICK_FLAME = new Color(brand['sun-soft']).multiplyScalar(3);
const HALO = new Color(brand.sun).multiplyScalar(1.5);
const LAMP_ON = new Color(brand.mint).multiplyScalar(2.5);
/** Obyčejný kvádr slovesa bez druhu: čeká, rozdělaný, hotový. */
const PLAIN = [brand.sky, brand.sun, brand['mint-deep']] as const;
const DIRT = brand['ink-soft'];
const NO_SHADOW = { rigShadow: 'none' } as const;

const TREE = KIND_BODY.fire;
const CANDLE = KIND_BODY.flame;
const PAN = KIND_BODY.cook;
const MACHINE = KIND_BODY.repair;
const CAGE = KIND_BODY.free;
/** Mísa pánve leží −0,4 délky modelu od středu obrysu (rukojeť k +z); posun ji dá na střed cíle. */
const BOWL_Z = 0.17;
const CANDLE_TOP = 1.42;
const LAMP_Y = 1.62;

function fireParts(state: number): ReactNode[] {
  return [
    <FittedModel key="model" id={TREE.model} w={TREE.w} h={TREE.h} d={TREE.d} fallback={brand.grass} />,
    state === 0 && (
      <mesh key="blaze" position={[0, 1.7, 0]} userData={NO_SHADOW}>
        <sphereGeometry args={[0.85, 16, 12]} />
        <meshBasicMaterial color={BLAZE} transparent opacity={0.4} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    ),
    state === 1 && (
      // Začouzená koruna: tmavý průsvitný obal přes zeleň.
      <mesh key="soot" position={[0, 1.75, 0]} userData={NO_SHADOW}>
        <sphereGeometry args={[0.95, 16, 12]} />
        <meshStandardMaterial color={brand.ink} transparent opacity={0.45} roughness={1} depthWrite={false} />
      </mesh>
    ),
  ];
}

function flameParts(state: number): ReactNode[] {
  return [
    <FittedModel key="model" id={CANDLE.model} w={CANDLE.w} h={CANDLE.h} d={CANDLE.d} fallback={brand.cream} />,
    state === 1 && (
      <mesh key="flame" position={[0, CANDLE_TOP, 0]} scale={[1, 1.8, 1]} userData={NO_SHADOW}>
        <sphereGeometry args={[0.07, 12, 8]} />
        <meshBasicMaterial color={WICK_FLAME} toneMapped={false} />
      </mesh>
    ),
    state === 1 && (
      <mesh key="halo" position={[0, CANDLE_TOP, 0]} userData={NO_SHADOW}>
        <sphereGeometry args={[0.25, 16, 12]} />
        <meshBasicMaterial color={HALO} transparent opacity={0.35} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </mesh>
    ),
  ];
}

function cookParts(state: number): ReactNode[] {
  return [
    <group key="pan" position={[0, 0, BOWL_Z]}>
      <FittedModel id={PAN.model} w={PAN.w} h={PAN.h} d={PAN.d} fallback={brand.ink} />
    </group>,
    state < 2 ? (
      // Těsto: syrové bledé, pečené do žluta.
      <mesh key="batter" position={[0, 0.05, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 0.03, 20]} />
        <meshStandardMaterial color={state === 0 ? brand['cream-deep'] : brand['sun-soft']} roughness={0.9} />
      </mesh>
    ) : (
      <group key="pancake" position={[0, 0.03, 0]}>
        <FittedModel id="cc0-pancake" w={0.4} h={0.1} d={0.4} fallback={brand['sun-deep']} />
      </group>
    ),
  ];
}

function repairParts(state: number): ReactNode[] {
  return [
    <FittedModel key="model" id={MACHINE.model} w={MACHINE.w} h={MACHINE.h} d={MACHINE.d} fallback={brand['ink-soft']} />,
    <mesh key={state === 0 ? 'lamp-off' : 'lamp-on'} position={[0, LAMP_Y, 0]} userData={NO_SHADOW}>
      <sphereGeometry args={[0.13, 16, 12]} />
      {state === 0 ? <meshStandardMaterial color={brand.alarm} roughness={0.5} /> : <meshBasicMaterial color={LAMP_ON} toneMapped={false} />}
    </mesh>,
  ];
}

/** Zvíře venku poskakuje. */
function Hop({ children }: { readonly children: ReactNode }) {
  const group = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (group.current !== null) group.current.position.y = Math.abs(Math.sin(clock.elapsedTime * 5)) * 0.35;
  });
  return <group ref={group}>{children}</group>;
}

function freeParts(state: number): ReactNode[] {
  const animal = <FittedModel id="dog" w={0.45} h={0.45} d={0.6} fallback={brand['sun-deep']} />;
  if (state === 0) return [<FittedModel key="cage" id={CAGE.model} w={CAGE.w} h={CAGE.h} d={CAGE.d} fallback={brand.ink} />, <group key="animal">{animal}</group>];
  return [
    // Klec převržená na bok otvorem ke zvířeti.
    <group key="cage-open" position={[0.3, 0.45, 0]} rotation={[0, 0, -Math.PI / 2]}>
      <FittedModel id={CAGE.model} w={CAGE.w} h={CAGE.h} d={CAGE.d} fallback={brand.ink} />
    </group>,
    <group key="animal-out" position={[-0.55, 0, 0]}>
      <Hop>{animal}</Hop>
    </group>,
  ];
}

const leaf = (key: string, y: number, side: 1 | -1, size: number): ReactNode => (
  <mesh key={key} position={[side * size * 0.8, y, 0]} rotation={[0, 0, side * -0.5]} scale={[1, 0.35, 0.6]}>
    <sphereGeometry args={[size, 12, 8]} />
    <meshStandardMaterial color={brand['mint-deep']} roughness={0.7} />
  </mesh>
);

function growParts(state: number): ReactNode[] {
  const stem = (h: number): ReactNode => (
    <mesh key="stem" position={[0, 0.2 + h / 2, 0]}>
      <cylinderGeometry args={[0.03, 0.04, h, 8]} />
      <meshStandardMaterial color={brand.grass} roughness={0.8} />
    </mesh>
  );
  return [
    <mesh key="mound" scale={[1, 0.5, 1]}>
      <sphereGeometry args={[0.4, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} />
      <meshStandardMaterial color={DIRT} roughness={1} />
    </mesh>,
    ...(state === 0
      ? [
          <mesh key="seed" position={[0, 0.21, 0]} scale={[1, 1.3, 1]}>
            <sphereGeometry args={[0.08, 12, 8]} />
            <meshStandardMaterial color={brand['sun-deep']} roughness={0.6} />
          </mesh>,
        ]
      : state === 1
        ? [stem(0.4), leaf('leaf-l', 0.55, -1, 0.12), leaf('leaf-r', 0.55, 1, 0.12)]
        : [
            stem(0.9),
            leaf('leaf-l', 0.55, -1, 0.16),
            leaf('leaf-r', 0.55, 1, 0.16),
            leaf('leaf-l2', 0.85, -1, 0.14),
            leaf('leaf-r2', 0.85, 1, 0.14),
            <mesh key="flower" position={[0, 1.15, 0]} scale={[1, 0.6, 1]}>
              <sphereGeometry args={[0.16, 16, 10]} />
              <meshStandardMaterial color={brand.sun} roughness={0.5} />
            </mesh>,
            <mesh key="flower-heart" position={[0, 1.22, 0]}>
              <sphereGeometry args={[0.07, 12, 8]} />
              <meshStandardMaterial color={brand.tomato} roughness={0.5} />
            </mesh>,
          ]),
  ];
}

function plainParts(state: number, done: boolean, target: TargetBody): ReactNode[] {
  return [
    <mesh key="block" position={[0, target.h / 2, 0]}>
      <boxGeometry args={[target.w, target.h, target.d]} />
      <meshStandardMaterial color={done ? PLAIN[2] : PLAIN[Math.min(state, 1)]} roughness={0.6} />
    </mesh>,
  ];
}

function partsOf(kind: VerbKind | null, state: number, done: boolean, target: TargetBody): ReactNode[] {
  switch (kind) {
    case 'fire':
      return fireParts(state);
    case 'flame':
      return flameParts(state);
    case 'cook':
      return cookParts(state);
    case 'repair':
      return repairParts(state);
    case 'free':
      return freeParts(state);
    case 'grow':
      return growParts(state);
    default:
      return plainParts(state, done, target);
  }
}

/** Poloměr půdorysu kresby – kolem něj leží kroužek „ještě práce“. */
function reachOf(kind: VerbKind | null, target: TargetBody): number {
  if (kind === null) return Math.max(target.w, target.d) / 2;
  if (kind === 'grow') return 0.4;
  return Math.max(KIND_BODY[kind].w, KIND_BODY[kind].d) / 2;
}

/** Jeden cíl ve svém stavu: tvar, zdroje částic a kroužek, dokud není hotový (`ring`; stanoviště kreslí vlastní na desce). */
export function targetParts(target: TargetBody, kind: VerbKind | null, states: number, ring = true): ReactElement {
  const state = Math.min(target.state, states - 1);
  const done = state === states - 1;
  const r = reachOf(kind, target) + 0.15;
  return (
    <group key={target.index} position={[target.x, target.y, target.z]} userData={{ frame: 'target' }}>
      {partsOf(kind, state, done, target)}
      {fxOf(kind, state).emitters.map((emitter) => (
        <TargetEmitter key={`${emitter.kind}@${String(emitter.y)}`} kind={emitter.kind} y={emitter.y} />
      ))}
      {ring && !done && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} userData={{ rigShadow: 'receive' }}>
          <ringGeometry args={[r, r + 0.1, 32]} />
          <meshBasicMaterial color={brand.sun} />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Částice a světla

interface Fx {
  readonly batch: BatchedRenderer;
  readonly map: DataTexture;
  readonly glow: MeshBasicMaterial;
  readonly plain: MeshBasicMaterial;
}

const FxContext = createContext<Fx | null>(null);

/** Strop živých částic záblesků přechodu. */
const BURST_CAP = 300;

const DOT_PX = 64;

/** Měkká kulatá tečka jako u efektů A (plná uprostřed, 85 % v 0,45 poloměru, na kraji nic), spočtená bez plátna. */
function dotTexture(): DataTexture {
  const data = new Uint8Array(DOT_PX * DOT_PX * 4).fill(255);
  for (let y = 0; y < DOT_PX; y += 1) {
    for (let x = 0; x < DOT_PX; x += 1) {
      const r = Math.hypot(x + 0.5 - DOT_PX / 2, y + 0.5 - DOT_PX / 2) / (DOT_PX / 2);
      const alpha = r >= 1 ? 0 : r <= 0.45 ? 1 - (0.15 * r) / 0.45 : 0.85 * (1 - (r - 0.45) / 0.55);
      data[(y * DOT_PX + x) * 4 + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new DataTexture(data, DOT_PX, DOT_PX, RGBAFormat);
  texture.magFilter = texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const quarksColor = (hex: string): QVector4 => {
  const color = new Color(hex);
  return new QVector4(color.r, color.g, color.b, 1);
};

const SHRINK = new PiecewiseBezier([[new Bezier(1, 0.95, 0.6, 0), 0]]);
const GROW = new PiecewiseBezier([[new Bezier(0.5, 0.9, 1.1, 1.2), 0]]);

/** Systém částic: smyčka (`rate` za sekundu) nebo jednorázový výbuch (`count`). */
function systemOf(fx: Fx, spray: Omit<EmitterPreset, 'rate'>, emission: { readonly rate: number } | { readonly count: number }): ParticleSystem {
  const looping = 'rate' in emission;
  return new ParticleSystem({
    duration: looping ? 1 : 0.2,
    looping,
    worldSpace: true,
    startLife: new IntervalValue(spray.life[0], spray.life[1]),
    startSpeed: new IntervalValue(spray.speed[0], spray.speed[1]),
    startSize: new IntervalValue(spray.size[0], spray.size[1]),
    startColor: new ColorRange(quarksColor(spray.colors[0]), quarksColor(spray.colors[1])),
    emissionOverTime: new ConstantValue(looping ? emission.rate : 0),
    emissionBursts: looping ? [] : [{ time: 0, count: new ConstantValue(emission.count), cycle: 1, interval: 0.01, probability: 1 }],
    shape: new SphereEmitter({ radius: spray.radius }),
    material: spray.glow ? fx.glow : fx.plain,
    renderMode: RenderMode.BillBoard,
    behaviors: [
      new ApplyForce(new QVector3(0, -1, 0), new ConstantValue(spray.gravity)),
      new SizeOverLife(spray.grow ? GROW : SHRINK),
      new ColorOverLife(
        new Gradient(
          [
            [new QVector3(1, 1, 1), 0],
            [new QVector3(1, 1, 1), 1],
          ],
          [
            [1, 0],
            [0, 1],
          ],
        ),
      ),
    ],
  });
}

/** Stálý zdroj částic stavu; s jiným stavem zmizí (klíč) a jeho částice s ním. */
function TargetEmitter({ kind, y }: { readonly kind: EmitterKind; readonly y: number }) {
  const fx = useContext(FxContext);
  const system = useMemo(() => (fx === null ? null : systemOf(fx, EMITTERS[kind], { rate: EMITTERS[kind].rate })), [fx, kind]);
  useEffect(() => {
    if (fx === null || system === null) return;
    fx.batch.addSystem(system);
    return () => fx.batch.deleteSystem(system);
  }, [fx, system]);
  return system === null ? null : <primitive object={system.emitter} position={[0, y, 0]} />;
}

export function TargetStates({
  targets,
  kind,
  states,
  station,
}: {
  readonly targets: readonly TargetBody[];
  readonly kind: VerbKind | null;
  readonly states: number;
  readonly station?: StationSetup | undefined;
}) {
  const camera = useThree((three) => three.camera);
  const scene = useThree((three) => three.scene);
  const canvas = useThree((three) => three.gl.domElement);
  const fx = useMemo((): Fx => {
    const map = dotTexture();
    return {
      batch: new BatchedRenderer(),
      map,
      glow: new MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: AdditiveBlending }),
      plain: new MeshBasicMaterial({ map, transparent: true, depthWrite: false, blending: NormalBlending }),
    };
  }, []);
  const director = useMemo(
    () =>
      createParticleDirector((burst: Burst) => {
        const system = systemOf(fx, { ...burst, radius: 0.15, grow: burst.kind === 'flash' || burst.kind === 'puff' }, { count: burst.count });
        system.emitter.position.set(...burst.at);
        scene.add(system.emitter);
        fx.batch.addSystem(system);
        return { dispose: () => system.dispose() };
      }),
    [fx, scene],
  );
  const seen = useMemo(() => new Map<number, number>(), []);
  const lights = useRef<(PointLight | null)[]>([]);

  useEffect(
    () => () => {
      director.reset();
      fx.map.dispose();
      fx.glow.dispose();
      fx.plain.dispose();
    },
    [fx, director],
  );

  // Vrstva se překreslí jen se změnou cíle: tady se pozná posun stavu. Sonda pro e2e: stavy cílů po řadě.
  useEffect(() => {
    const bursts = risenBursts(seen, targets, kind);
    if (bursts.length > 0) director.emit(bursts, performance.now() / 1000, BURST_CAP);
    canvas.dataset.quest = targets.map((target) => target.state).join(' ');
  }, [targets, kind, seen, director, canvas]);
  const burst = useCallback((bursts: readonly Burst[]) => director.emit(bursts, performance.now() / 1000, BURST_CAP), [director]);

  useFrame((_, delta) => {
    const now = performance.now() / 1000;
    fx.batch.update(delta);
    director.update(now);
    const spots = lightsOf(targets, kind, camera.position);
    lights.current.forEach((light, i) => {
      if (light === null) return;
      const spot = spots[i];
      if (spot === undefined) {
        light.intensity = 0;
        return;
      }
      light.position.set(spot.x, spot.y, spot.z);
      light.color.set(spot.color);
      light.distance = spot.distance;
      // Oheň a plamínek se chvějí, kontrolka stroje svítí klidně.
      light.intensity = kind === 'repair' ? spot.intensity : spot.intensity * (0.85 + 0.15 * Math.sin(now * 13 + i * 2.1));
    });
  });

  return (
    <FxContext.Provider value={fx}>
      <primitive object={fx.batch} />
      {Array.from({ length: MAX_LIGHTS }, (_, i) => (
        <pointLight
          key={i}
          ref={(light) => {
            lights.current[i] = light;
          }}
          intensity={0}
          decay={2}
        />
      ))}
      {targets.map((target) => targetParts(target, kind, states, station === undefined))}
      {station !== undefined && <StationScene {...station} targets={targets} kind={kind} states={states} burst={burst} />}
    </FxContext.Provider>
  );
}
