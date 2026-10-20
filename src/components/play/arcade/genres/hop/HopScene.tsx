'use client';

/**
 * Scéna přeskákání silnice (P54C T9): řady pole zezadu shora – tráva v šachovnici sloupců, silnice s čárami,
 * řeka a koleje. Kamera jede za hrdinou po +z a na výšku telefonu se do obrazu vejde celá šíře pole; x jádra se
 * zrcadlí jako u běžce, takže tah doprava je skok doprava (`hop-input.ts`, vstup si scéna zapíná sama).
 *
 * Provoz kreslí instance – jedna síť na druh: auta modelem z popisku překážky (`cast.props.obstacle`, jinak
 * sedan), náklaďáky, klády a vagony z katalogu. Strop sítí telefonu (p35-perf, 200) tak nezávisí na hustotě
 * provozu. Oblouk skoku, smrky za hranou pole, blikající světla přejezdu (dokud je vlak v řadě) a orel nad
 * nečinným hrdinou jsou jen obraz: stav ani hash nemění.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  type Group,
  type InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three';

import { color } from '@/brand/tokens';
import { type ArcadeWorld, BODY, COUNTER, FLAG, HEADER, ROLE, RUN_STATE, UNIT, bodyBase, nativeRule } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { type BotLane, DIR, HOP, HOP_HALF, type LaneRef, ROW, colX, hopDir, hopLeft, idleTicks, laneX, logUnder } from '@/play/arcade/pieces/hop';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { loadBodyModel } from '../../look/load';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps, fitModel } from '../../World';
import { useHopInput } from './hop-input';

const m = (units: number): number => units / UNIT;
const CELL = m(HOP.cell);
const HALF = m(HOP_HALF);
/** Zem za hranou pole (m): auta tu vjíždějí a mizí, hrdina sem nesmí. */
const SIDE = 7;
const HERO = { w: m(HOP.hero.w), h: m(HOP.hero.h), d: m(HOP.hero.d) };
/** Vrchol oblouku skoku (m) a výška hrdiny na kládě. */
const ARC = 0.45;
const ON_LOG = 0.22;
/** Řady, ve kterých scéna kreslí provoz: za hrdinou a před ním (horní okraj obrazu na výšku). */
const BEHIND = 5;
const AHEAD = 24;
/** Tráva před startem a za cílem (řady). */
const LEAD_IN = 5;
const RUN_OUT = 10;
/** Kolik tiků před orlem se snáší (stín roste). */
const EAGLE_WARN = 90;
/** Kamera: polovina šíře, která se musí vejít, náklon, rozsah vzdálenosti a kam před hrdinu kouká. */
const CAMERA = { fit: HALF + 0.6, elevation: (58 * Math.PI) / 180, near: 9, far: 26, ahead: 2.6, follow: 5 } as const;
/** Vagony vlaku na jedno tělo jádra a mezera mezi nimi (m). */
const CARRIAGES = 2;
const COUPLING = 0.25;

type Box3D = readonly [w: number, h: number, d: number];

/** Druhy řad podle pruhů robota (řada bez pruhu je tráva); poslední řada je cíl. */
export function hopRowKinds(world: Pick<ArcadeWorld, 'bot'>): number[] {
  const params = world.bot.params as { readonly lanes: readonly BotLane[]; readonly goal: number };
  const kinds: number[] = Array.from({ length: params.goal + 1 }, () => ROW.grass);
  for (const lane of params.lanes) kinds[lane[0]] = lane[1];
  return kinds;
}

const mod = (a: number, b: number): number => ((a % b) + b) % b;
const paint = (token: string): Color => new Color(token);
const shade = (token: string, amount: number): Color => paint(token).lerp(paint(color.ink), amount);

/** Zem všech řad jako jedna síť s barvou ve vrcholech: pole, kraje za hranou, čáry silnice a kolejnice. */
function groundOf(kinds: readonly number[]): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const quad = (x0: number, x1: number, z0: number, z1: number, y: number, tint: Color): void => {
    // Pořadí vrcholů dává normálu +y (plocha kouká nahoru).
    positions.push(x0, y, z0, x1, y, z1, x1, y, z0, x0, y, z0, x0, y, z1, x1, y, z1);
    for (let i = 0; i < 6; i += 1) colors.push(tint.r, tint.g, tint.b);
  };
  const tints = {
    grass: [paint(color.mint), paint(color['mint-deep']), paint(color.grass)],
    goal: [paint(color['sun-soft']), paint(color.sun), shade(color.sun, 0.35)],
    road: [paint(color['ink-soft']), paint(color['ink-soft']), shade(color['ink-soft'], 0.45)],
    river: [paint(color['sky-deep']), paint(color['sky-deep']), shade(color['sky-deep'], 0.3)],
    rail: [paint(color['ink-faint']), paint(color['ink-faint']), shade(color['ink-faint'], 0.4)],
  } as const;
  const dash = paint(color.cream);
  const iron = paint(color.ink);
  const sleeper = shade(color['ink-soft'], 0.2);
  const last = kinds.length - 1;
  for (let row = -LEAD_IN; row <= last + RUN_OUT; row += 1) {
    const kind = row < 0 || row > last ? ROW.grass : (kinds[row] as number);
    const set = row === last ? tints.goal : kind === ROW.road ? tints.road : kind === ROW.river ? tints.river : kind === ROW.rail ? tints.rail : tints.grass;
    const z0 = row * CELL - CELL / 2;
    const z1 = z0 + CELL;
    quad(-HALF - SIDE, -HALF, z0, z1, 0, set[2]);
    quad(HALF, HALF + SIDE, z0, z1, 0, set[2]);
    for (let col = 0; col < HOP.cols; col += 1) {
      const x = -m(colX(col));
      quad(x - CELL / 2, x + CELL / 2, z0, z1, 0, set[(row + col) & 1] as Color);
    }
    // Přerušovaná čára mezi dvěma pruhy silnice.
    if (kind === ROW.road && row < last && kinds[row + 1] === ROW.road) {
      for (let x = -HALF - SIDE + 0.3; x < HALF + SIDE; x += 1.4) quad(x, x + 0.7, z1 - 0.05, z1 + 0.05, 0.01, dash);
    }
    if (kind === ROW.rail) {
      for (let x = -HALF - SIDE; x < HALF + SIDE; x += 0.7) quad(x, x + 0.22, z0 + 0.15, z1 - 0.15, 0.01, sleeper);
      for (const at of [-0.32, 0.32]) quad(-HALF - SIDE, HALF + SIDE, row * CELL + at - 0.05, row * CELL + at + 0.05, 0.02, iron);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

interface Part {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** Materiál patří instanci (primitivum), ne mezipaměti modelů. */
  readonly own: boolean;
}

interface FleetProps {
  /** Model katalogu; bez něj (nebo než se načte) kvádr v barvě kitu. */
  readonly model?: string;
  /** Kvádr modelu (m): šířka napříč pruhem, výška, délka po směru jízdy (model kouká po +z). */
  readonly box: Box3D;
  readonly fill?: boolean;
  readonly capacity: number;
  readonly tint: string;
  readonly glow?: boolean;
  /** Pevné umístění instancí (smrky, sloupky); jinak je píše scéna každý snímek. */
  readonly fixed?: readonly Matrix4[];
  readonly item?: string;
  readonly holder?: React.RefObject<Group | null>;
}

/**
 * Jeden druh těl jako instance: model vepsaný do kvádru (`fitModel`) rozložený na sítě se zapečenou maticí,
 * každá síť jedna `InstancedMesh`. Počet instancí na začátku 0 – scéna je rozmístí (`place`).
 */
function Fleet({ model, box, fill = false, capacity, tint, glow = false, fixed, item, holder }: FleetProps) {
  const [loaded, setLoaded] = useState<Object3D | null | undefined>(undefined);
  useEffect(() => {
    if (model === undefined) return;
    let live = true;
    void loadBodyModel(model).then((found) => {
      if (live) setLoaded(found);
    });
    return () => {
      live = false;
    };
  }, [model]);
  const [w, h, d] = box;
  const parts = useMemo((): readonly Part[] => {
    if (model === undefined || loaded === null || loaded === undefined) {
      const material = new MeshStandardMaterial({ color: tint, roughness: 0.6, ...(glow ? { emissive: tint, emissiveIntensity: 0.9 } : {}) });
      return [{ geometry: new BoxGeometry(w, h, d).translate(0, h / 2, 0), material, own: true }];
    }
    const fitted = fitModel(loaded, { id: model, w, h, d, fill });
    fitted.updateMatrixWorld(true);
    const out: Part[] = [];
    fitted.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh === true && !Array.isArray(mesh.material)) out.push({ geometry: mesh.geometry.clone().applyMatrix4(mesh.matrixWorld), material: mesh.material as Material, own: false });
    });
    return out;
  }, [model, loaded, w, h, d, fill, tint, glow]);
  useEffect(
    () => () => {
      for (const part of parts) {
        part.geometry.dispose();
        if (part.own) part.material.dispose();
      }
    },
    [parts],
  );
  const own = useRef<Group | null>(null);
  const group = holder ?? own;
  useLayoutEffect(() => {
    place(group.current, fixed ?? [], fixed?.length ?? 0);
  }, [group, parts, fixed]);
  return (
    <group ref={group} userData={item === undefined ? {} : { item }}>
      {parts.map((part, index) => (
        <instancedMesh key={index} args={[part.geometry, part.material, capacity]} castShadow receiveShadow frustumCulled={false} />
      ))}
    </group>
  );
}

/** Rozmístí `count` instancí všem sítím druhu; druh bez instancí je skrytý (sonda snímku ho nepočítá). */
function place(group: Group | null, matrices: readonly Matrix4[], count: number): void {
  if (group === null) return;
  group.visible = count > 0;
  for (const child of group.children) {
    const mesh = child as InstancedMesh;
    const n = Math.min(count, mesh.instanceMatrix.count);
    for (let i = 0; i < n; i += 1) mesh.setMatrixAt(i, matrices[i] as Matrix4);
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Zásoba matic jednoho druhu na snímek. */
class Slots {
  readonly matrices: Matrix4[];
  count = 0;
  constructor(readonly capacity: number) {
    this.matrices = Array.from({ length: capacity }, () => new Matrix4());
  }
  add(position: Vector3, turn: Quaternion, scale: Vector3): void {
    if (this.count < this.capacity) (this.matrices[this.count++] as Matrix4).compose(position, turn, scale);
  }
}

const UP = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);
/** Natočení vozidla: jede po −x scény (x jádra +), nebo po +x scény. */
const TURN = { plus: new Quaternion().setFromAxisAngle(UP, -Math.PI / 2), minus: new Quaternion().setFromAxisAngle(UP, Math.PI / 2) };
/** Natočení hrdiny podle směru skoku (`DIR`); doleva v jádře = +x scény. */
const HERO_YAW: Readonly<Record<number, number>> = { [DIR.forward]: 0, [DIR.back]: Math.PI, [DIR.left]: Math.PI / 2, [DIR.right]: -Math.PI / 2 };

const CAPACITY = { car: 160, truck: 64, log: 64, carriage: 4 * CARRIAGES } as const;
const CAR_BOX: Box3D = [0.75, m(HOP.car.h), m(HOP.car.w)];
const TRUCK_BOX: Box3D = [1, m(HOP.truck.h), m(HOP.truck.w)];
const LOG_BOX: Box3D = [m(HOP.log.d), 0.4, 1];
const CARRIAGE_LENGTH = (m(HOP.train.w) - COUPLING * (CARRIAGES - 1)) / CARRIAGES;
const CARRIAGE_BOX: Box3D = [1, m(HOP.train.h), CARRIAGE_LENGTH];

type HopSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

export function HopScene({ session, cast, surface, scene: look, enabled, ghost }: HopSceneProps) {
  useHopInput(session, surface, enabled);
  const world = session.world;
  const kinds = useMemo(() => hopRowKinds(world), [world]);
  const last = kinds.length - 1;
  const ground = useMemo(() => groundOf(kinds), [kinds]);
  const land = useMemo(() => ({ x0: -40, x1: 40, z0: -30, z1: last * CELL + 40 }), [last]);
  useEffect(() => () => ground.dispose(), [ground]);
  const groundMaterial = useMemo(() => new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }), []);
  useEffect(() => () => groundMaterial.dispose(), [groundMaterial]);
  const codes = useMemo(() => ({ car: world.kinds.indexOf('obstacle'), truck: world.kinds.indexOf('truck'), log: world.kinds.indexOf('log'), train: world.kinds.indexOf('train') }), [world]);
  const traffic = useMemo(() => (nativeRule(world.rules, 'hop_traffic')?.params.lanes ?? []) as readonly LaneRef[], [world]);
  // Smrky na trávě za hranou pole; každá řada jinak, bez náhody (jen z čísla řady).
  const pines = useMemo(() => {
    const out: Matrix4[] = [];
    for (let row = -LEAD_IN; row <= last + RUN_OUT; row += 1) {
      if (row >= 0 && row <= last && kinds[row] !== ROW.grass) continue;
      for (const side of [-1, 1]) for (let k = 0; k < 3; k += 1) if ((row * 3 + k + (side > 0 ? 1 : 0)) % 4 !== 0) out.push(new Matrix4().makeTranslation(side * (HALF + 0.9 + k * 1.7), 0, row * CELL));
    }
    return out;
  }, [kinds, last]);
  const rails = useMemo(() => kinds.flatMap((kind, row) => (kind === ROW.rail ? [row] : [])), [kinds]);
  const lampAt = useCallback((row: number, side: number, y: number): Matrix4 => new Matrix4().makeTranslation(side * (HALF + 0.5), y, row * CELL - CELL / 2 + 0.1), []);
  const poles = useMemo(() => rails.flatMap((row) => [lampAt(row, -1, 0), lampAt(row, 1, 0)]), [rails, lampAt]);
  const lampsOff = useMemo(() => rails.flatMap((row) => [lampAt(row, -1, 1.25), lampAt(row, 1, 1.25)]), [rails, lampAt]);

  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const hero = useRef<Group | null>(null);
  const heroTurn = useRef<Group | null>(null);
  const eagle = useRef<Group | null>(null);
  const shadow = useRef<Mesh | null>(null);
  const finish = useRef<Group | null>(null);
  const fleets = { car: useRef<Group | null>(null), truck: useRef<Group | null>(null), log: useRef<Group | null>(null), carriage: useRef<Group | null>(null), lampOn: useRef<Group | null>(null) };
  const hopping = useRef(false);
  const follow = useRef<number | null>(null);
  const scratch = useMemo(
    () => ({
      car: new Slots(CAPACITY.car),
      truck: new Slots(CAPACITY.truck),
      log: new Slots(CAPACITY.log),
      carriage: new Slots(CAPACITY.carriage),
      lampOn: new Slots(Math.max(1, 2 * rails.length)),
      at: new Vector3(),
      size: new Vector3(),
      look: new Vector3(),
      probe: new Vector3(),
    }),
    [rails],
  );
  const heroRig = riggedCharacter(cast.player);
  const carModel = cast.props.obstacle ?? 'cc0-car-sedan';
  const truckModel = cast.props.obstacle ?? 'cc0-garbage-truck';
  const finishModel = cast.props.finish ?? 'finish-flag';

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const player = state[HEADER.player] as number;
    const base = bodyBase(player);
    const lerp = (slot: number): number => m((prev[base + slot] as number) + ((state[base + slot] as number) - (prev[base + slot] as number)) * alpha);
    const kernelX = state[base + BODY.x] as number;
    const kernelZ = state[base + BODY.z] as number;
    // Návrat na trávu (`respawn`) skočí, ne doklouže: za tik se jinak hrdina pohne nejvýš o krok skoku.
    const jumped = Math.abs(kernelZ - (prev[base + BODY.z] as number)) > HOP.cell / 2 || Math.abs(kernelX - (prev[base + BODY.x] as number)) > HOP.cell / 2;
    const heroX = jumped ? -m(kernelX) : -lerp(BODY.x);
    const heroZ = jumped ? m(kernelZ) : lerp(BODY.z);
    const left = hopLeft(state, player);
    hopping.current = left > 0;
    const progress = left > 0 ? Math.min(1, (HOP.hopTicks - left + alpha) / HOP.hopTicks) : 0;
    const lift = left > 0 ? 4 * ARC * progress * (1 - progress) : logUnder(state, kernelX, kernelZ) >= 0 ? ON_LOG : 0;
    hero.current?.position.set(heroX, lift, heroZ);
    if (left > 0 && heroTurn.current !== null) heroTurn.current.rotation.y = HERO_YAW[hopDir(state, player)] ?? 0;
    const heroRow = Math.round(kernelZ / HOP.cell);

    // Provoz v řadách kolem hrdiny, jen na zemi scény.
    for (const slots of [scratch.car, scratch.truck, scratch.log, scratch.carriage, scratch.lampOn]) slots.count = 0;
    const warned = new Set<number>();
    const draw = (code: number, kernelBodyX: number, z: number, units: number, dir: number): void => {
      const row = Math.round(z / HOP.cell);
      if (row < heroRow - BEHIND || row > heroRow + AHEAD) return;
      if (code === codes.train) warned.add(row);
      const x = -m(kernelBodyX);
      const w = m(units);
      if (Math.abs(x) - w / 2 > HALF + SIDE) return;
      const turn = dir >= 0 ? TURN.plus : TURN.minus;
      if (code === codes.log) scratch.log.add(scratch.at.set(x, -0.15, m(z)), turn, scratch.size.set(1, 1, w));
      else if (code === codes.train) {
        for (let k = 0; k < CARRIAGES; k += 1) scratch.carriage.add(scratch.at.set(x - w / 2 + CARRIAGE_LENGTH / 2 + k * (CARRIAGE_LENGTH + COUPLING), 0, m(z)), turn, ONE);
      } else (code === codes.truck ? scratch.truck : scratch.car).add(scratch.at.set(x, 0, m(z)), turn, ONE);
    };
    if ((state[HEADER.tick] as number) === 0) {
      // Před prvním tikem (hra čeká na dotek) provoz ještě nevyjel: scéna ukáže, kde ho první tik předjede.
      for (const lane of traffic) {
        const template = bodyBase(lane[1]);
        const path = { dir: lane[2] as 1 | -1, speed: lane[3], entry: lane[7] };
        for (let sent = -mod(-lane[5], lane[4]); lane[2] * laneX(path, sent, 0) < lane[8]; sent -= lane[4]) {
          draw(world.initial[template + BODY.kind] as number, laneX(path, sent, 0), lane[0] * HOP.cell, world.initial[template + BODY.w] as number, lane[2]);
        }
      }
    }
    for (let index = state[HEADER.spawnBase] as number; index < (state[HEADER.bodyCount] as number); index += 1) {
      const at = bodyBase(index);
      if (((state[at + BODY.flags] as number) & FLAG.alive) === 0) continue;
      const role = state[at + BODY.role] as number;
      if (role !== ROLE.obstacle && role !== ROLE.platform) continue;
      const z = state[at + BODY.z] as number;
      // Těsně vyslané (nebo do slotu jiného těla) vozidlo kreslí stav, ne cestu z místa, kde slot byl.
      const fresh = prev[at + BODY.z] !== z || ((prev[at + BODY.flags] as number) & FLAG.alive) === 0;
      const x = fresh ? (state[at + BODY.x] as number) : (prev[at + BODY.x] as number) + ((state[at + BODY.x] as number) - (prev[at + BODY.x] as number)) * alpha;
      draw(state[at + BODY.kind] as number, x, z, state[at + BODY.w] as number, state[at + BODY.vx] as number);
    }
    // Světla přejezdu blikají, dokud je vlak v řadě (vyjede `HOP.trainLead` tiků před hranou pole).
    const blink = Math.floor((state[HEADER.tick] as number) / 8) % 2 === 0;
    if (blink) for (const row of warned) for (const side of [-1, 1]) scratch.lampOn.add(scratch.at.set(side * (HALF + 0.5), 1.25, row * CELL - CELL / 2 + 0.06), TURN.plus, ONE);
    place(fleets.car.current, scratch.car.matrices, scratch.car.count);
    place(fleets.truck.current, scratch.truck.matrices, scratch.truck.count);
    place(fleets.log.current, scratch.log.matrices, scratch.log.count);
    place(fleets.carriage.current, scratch.carriage.matrices, scratch.carriage.count);
    place(fleets.lampOn.current, scratch.lampOn.matrices, scratch.lampOn.count);
    if (finish.current !== null) finish.current.visible = last <= heroRow + AHEAD;

    // Orel: posledních `EAGLE_WARN` tiků před koncem trpělivosti se snáší nad hrdinu; prohra bez ztráty životů je jeho.
    const idle = idleTicks(state, player);
    const eaten = state[HEADER.runState] === RUN_STATE.lost && (state[HEADER.counters + COUNTER.health] as number) > 0;
    const swoop = eaten ? 1 : Math.max(0, Math.min(1, (idle - (HOP.eagle - EAGLE_WARN)) / EAGLE_WARN));
    if (eagle.current !== null) {
      eagle.current.visible = swoop > 0 && state[HEADER.runState] !== RUN_STATE.won;
      eagle.current.position.set(heroX, HERO.h + 0.3 + 7 * (1 - swoop) ** 2, heroZ - 0.2);
    }
    if (shadow.current !== null) {
      shadow.current.visible = swoop > 0;
      shadow.current.position.set(heroX, 0.03, heroZ);
      shadow.current.scale.setScalar(0.3 + 0.9 * swoop);
    }

    // Kamera za hrdinou: na výšku rozhoduje šíře pole, na šířku strop vzdálenosti.
    if (follow.current === null || Math.abs(follow.current - heroZ) > 12) follow.current = heroZ;
    follow.current += (heroZ - follow.current) * (1 - Math.exp(-delta * CAMERA.follow));
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max(CAMERA.near, Math.min(CAMERA.far, CAMERA.fit / (tan * camera.aspect)));
    const lookZ = follow.current + CAMERA.ahead;
    camera.position.set(0, distance * Math.sin(CAMERA.elevation), lookZ - distance * Math.cos(CAMERA.elevation));
    camera.lookAt(scratch.look.set(0, 0, lookZ));
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    host.dataset.playerX = scratch.probe.set(heroX, HERO.h, heroZ).project(camera).x.toFixed(3);
  });

  return (
    <>
      <FieldGround look={look} area={land} y={-0.05} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={30} />
      <mesh geometry={ground} material={groundMaterial} receiveShadow />
      <Fleet model="cc0-pine" box={[1, 1.7, 1]} capacity={Math.max(1, pines.length)} tint={color.grass} fixed={pines} />
      <Fleet box={[0.12, 1.25, 0.12]} capacity={Math.max(1, poles.length)} tint={color.ink} fixed={poles} />
      <Fleet box={[0.32, 0.32, 0.14]} capacity={Math.max(1, lampsOff.length)} tint={color['ink-soft']} fixed={lampsOff} />
      <Fleet box={[0.34, 0.34, 0.16]} capacity={Math.max(1, 2 * rails.length)} tint={color.tomato} glow holder={fleets.lampOn} />
      <Fleet model={carModel} box={CAR_BOX} capacity={CAPACITY.car} tint={color.tomato} item="obstacle" holder={fleets.car} />
      <Fleet model={truckModel} box={TRUCK_BOX} fill={cast.props.obstacle === undefined} capacity={CAPACITY.truck} tint={color['sun-deep']} item="obstacle" holder={fleets.truck} />
      <Fleet model="cc0-wood-log" box={LOG_BOX} fill capacity={CAPACITY.log} tint={color['sun-deep']} item="platform" holder={fleets.log} />
      <Fleet model="cc0-train" box={CARRIAGE_BOX} fill capacity={CAPACITY.carriage} tint={color['tomato-deep']} item="obstacle" holder={fleets.carriage} />
      <group ref={finish} position={[0, 0, last * CELL + CELL / 2 + 0.4]} userData={{ frame: 'target', item: 'finish' }}>
        <FittedModel id={finishModel} w={2} h={2.2} d={0.6} fallback={color.sun} />
      </group>
      <group ref={hero} userData={{ frame: 'hero' }}>
        <group ref={heroTurn}>
          {heroRig !== undefined ? (
            <RiggedModel character={heroRig} h={HERO.h} clip={() => (hopping.current ? 'jump' : 'idle')} fallback={color['sky-deep']} />
          ) : (
            <FittedModel id={cast.player} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
          )}
        </group>
      </group>
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <circleGeometry args={[0.6, 20]} />
        <meshBasicMaterial color={color.ink} />
      </mesh>
      <group ref={eagle} visible={false}>
        <FittedModel id="gen3d-bald-eagle" w={1.2} h={1.3} d={1.2} fallback={color['ink-soft']} />
      </group>
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
