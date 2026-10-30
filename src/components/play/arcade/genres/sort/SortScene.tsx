'use client';

/**
 * Scéna třídění (P66 T8): fronty věcí z věty, pod nimi odkladiště a dole řada nádob; hrdina stojí za frontami
 * a chodí ke zvolenému sloupci. Kamera kouká po +z shora, takže x jádra se zrcadlí jako u pruhů – fronta 0 leží
 * vlevo. Na výšku krabice hry mezi horním pásem HUD a zónou palce (`fitTall`), nádoby a čela front ve spodních 45 %
 * výšky; na šířku vlastní póza, celá deska v záběru.
 *
 * Věci kreslí ze stavu (polohu jim každý tik píše ovládání, `layoutRound`): model druhu z věty (`cast.things`,
 * role `sort0`–`sort4`) na podložce barvy druhu, vzácná a epická s kroužkem. Nádoby těla nemají: viditelné nádoby
 * a jejich plnění plyne z věcí kola (`boardOfState`, `boardBins`). Hotová nádoba zapadne, další přijede zprava,
 * věc, která do nádoby šla, do ní doletí. Hodiny kola jsou pruh nad nádobami. Jen obraz – stav ani hash nemění.
 *
 * Plocha dostane `data-lane-edges` (hranice front v řadě čel, pro prst – `lanes-input.ts`), `data-sort-queue`
 * (zvolená fronta), `data-sort-heads` / `data-sort-bins` (výška řady čel a nádob ve zlomku plátna) a `data-sort-tick`
 * (tik nakresleného snímku) – pro e2e.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useMemo, useRef, useState } from 'react';
import { Box3, Color, type Group, Matrix4, type Mesh, type MeshStandardMaterial, type PerspectiveCamera, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { ARCADE_HZ, BODY, FLAG, HEADER, UNIT, bodyBase, bodyHp, nativeRule } from '@/play/arcade/contract';
import { rarityOf } from '@/play/arcade/hooks';
import { riggedCharacter } from '@/play/arcade/models';
import { LANES, laneOf } from '@/play/arcade/pieces/lanes';
import { type SortGame, boardOfState, roundIn } from '@/play/arcade/pieces/sort';
import { SORT, SORT_LAYOUT, binX, boardBins, firstLane, queueX, rowZ, slotX } from '@/play/arcade/pieces/sort-level';

import { renderHeld } from '../../effects/render-feel';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps } from '../../World';
import { HUD_BAND_PX, fitTall, tokenRect } from '../portrait-first';

const m = (units: number): number => units / UNIT;
/** Barvy druhů z kitu (žádná fialová): rajče, nebe, slunce, máta, žvýkačka. */
export const KIND_COLORS: readonly string[] = [color.tomato, color['sky-deep'], color.sun, color['mint-deep'], color.bubblegum];
/** Kroužek vzácné věci (modrozelená jako `play-hooks.css`) a epické (slunce). */
const RARE = `#${new Color(color.mint).lerp(new Color(color.sky), 0.5).getHexString()}`;
const EPIC = color['sun-deep'];
/** Kreslená věc (m): o kus větší než tělo, ať je na telefonu vidět. */
const ITEM = 1.2;
const HERO_H = 2.4;
const BIN = { w: 2.1, h: 1.0, d: 1.5 } as const;
/** Pozice kamery: pod jakým úhlem kouká na desku (rad) na výšku a na šířku. */
const PITCH = { tall: 1.0, wide: 0.82 } as const;
/** Co musí být v záběru: deska od nádob po hlavu hrdiny. */
const HALF_W = m(SORT_LAYOUT.column) * 2 + ITEM / 2 + 0.2;
const BOX = new Box3(new Vector3(-HALF_W, 0, m(SORT_LAYOUT.binZ) - BIN.d / 2 - 0.2), new Vector3(HALF_W, HERO_H, m(SORT_LAYOUT.heroZ) + 0.6));
const LAND = { x0: -30, x1: 30, z0: -30, z1: 45 } as const;
/** Mezera mezi předním okrajem nádob a zónou palce na výšku (px). */
const BOTTOM_GAP_PX = 8;
/** Délka pruhu hodin kola (m). */
const TIMER_W = 2 * HALF_W - 0.6;
/** Kolik nádob se naráz kreslí: viditelné a ty, co právě zapadají. */
const BIN_POOL = 6;
/** Let věci do nádoby a zapadnutí hotové nádoby (s). */
const FLY_S = 0.3;
const SINK_S = 0.35;

type SortSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

const lerp = (from: number, to: number, alpha: number): number => from + (to - from) * alpha;
const ease = (t: number): number => 1 - (1 - t) * (1 - t);

/**
 * Vzdálenost kamery na šířku: každý roh krabice v záběru pod horním pásem HUD, s okrajem. Tatáž úvaha jako `fitTall`
 * (ten na šířku vrací vstupní pózu), jen pás je celé plátno pod HUD a posun se nepočítá.
 */
function fitWide(camera: PerspectiveCamera, box: Box3, width: number, height: number): number {
  const at = box.getCenter(new Vector3());
  const basis = new Matrix4().lookAt(camera.position, at, camera.up);
  const right = new Vector3().setFromMatrixColumn(basis, 0);
  const up = new Vector3().setFromMatrixColumn(basis, 1);
  const back = new Vector3().setFromMatrixColumn(basis, 2);
  const tan = Math.tan((camera.fov * Math.PI) / 360) / camera.zoom;
  const needY = height / 2 / (tan * (height / 2 - HUD_BAND_PX));
  const needX = 1 / (tan * camera.aspect * 0.9);
  let fit = 0;
  const corner = new Vector3();
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    corner.set(x, y, z).sub(at);
    const deeper = -corner.dot(back);
    fit = Math.max(fit, Math.abs(corner.dot(up)) * needY - deeper, Math.abs(corner.dot(right)) * needX - deeper, camera.near - deeper);
  }
  return fit;
}

/** Model druhu z věty, bez modelu tvar z primitiv v barvě druhu. */
function KindModel({ model, kind, size }: { readonly model: string | undefined; readonly kind: number; readonly size: number }) {
  const tint = KIND_COLORS[kind] as string;
  if (model !== undefined) return <FittedModel id={model} w={size} h={size} d={size} fallback={tint} />;
  return (
    <mesh position={[0, size / 2, 0]} castShadow>
      {kind % 3 === 0 ? <sphereGeometry args={[size / 2, 16, 12]} /> : kind % 3 === 1 ? <boxGeometry args={[size * 0.8, size * 0.8, size * 0.8]} /> : <coneGeometry args={[size / 2, size, 16]} />}
      <meshStandardMaterial color={tint} roughness={0.6} />
    </mesh>
  );
}

/** Věc fronty: model na podložce barvy druhu, kroužek vzácnosti (schovaný, dokud věc vzácná není). */
function ItemPiece({ model, kind, onRing }: { readonly model: string | undefined; readonly kind: number; readonly onRing: (mesh: Mesh | null) => void }) {
  return (
    <>
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <cylinderGeometry args={[0.6, 0.64, 0.12, 24]} />
        <meshStandardMaterial color={KIND_COLORS[kind]} roughness={0.7} />
      </mesh>
      <mesh ref={onRing} position={[0, 0.13, 0]} rotation={[-Math.PI / 2, 0, 0]} visible={false}>
        <ringGeometry args={[0.64, 0.76, 28]} />
        <meshStandardMaterial color={RARE} emissive={RARE} emissiveIntensity={0.6} />
      </mesh>
      <group position={[0, 0.12, 0]} rotation={[0, Math.PI, 0]}>
        <KindModel model={model} kind={kind} size={ITEM} />
      </group>
    </>
  );
}

/** Nádoba: otevřená bedna barvy druhu, model druhu na čele a `capacity` žetonů plnění. */
function BinPiece({ model, kind, onToken }: { readonly model: string | undefined; readonly kind: number; readonly onToken: (index: number, mesh: Mesh | null) => void }) {
  const tint = KIND_COLORS[kind] as string;
  const wall = 0.12;
  return (
    <>
      <mesh position={[0, 0.06, 0]} receiveShadow>
        <boxGeometry args={[BIN.w, 0.12, BIN.d]} />
        <meshStandardMaterial color={tint} roughness={0.8} />
      </mesh>
      {[
        [0, BIN.h / 2, -BIN.d / 2 + wall / 2, BIN.w, wall],
        [0, BIN.h / 2, BIN.d / 2 - wall / 2, BIN.w, wall],
      ].map(([x, y, z, w, d]) => (
        <mesh key={`z${z}`} position={[x as number, y as number, z as number]} castShadow>
          <boxGeometry args={[w as number, BIN.h, d as number]} />
          <meshStandardMaterial color={tint} roughness={0.7} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={`x${side}`} position={[(side * (BIN.w - wall)) / 2, BIN.h / 2, 0]} castShadow>
          <boxGeometry args={[wall, BIN.h, BIN.d]} />
          <meshStandardMaterial color={tint} roughness={0.7} />
        </mesh>
      ))}
      {Array.from({ length: SORT.capacity }, (_, index) => (
        <mesh key={index} ref={(mesh) => onToken(index, mesh)} position={[((index - (SORT.capacity - 1) / 2) * BIN.w) / 3.4, 0.42, 0]} visible={false} castShadow>
          <sphereGeometry args={[0.26, 14, 10]} />
          <meshStandardMaterial color={color.paper} roughness={0.5} />
        </mesh>
      ))}
      {/* Model druhu stojí na čele nádoby, kamera ho vidí nad přední stěnou. */}
      <group position={[0, BIN.h - 0.1, -BIN.d / 2 + 0.1]} rotation={[0, Math.PI, 0]}>
        <KindModel model={model} kind={kind} size={0.85} />
      </group>
    </>
  );
}

/** Slot zásoby nádob: pořadí nádoby v kole (−1 = volný), x (m) a zbytek zapadání (s). */
interface BinSlot {
  index: number;
  kind: number;
  x: number;
  sink: number;
}

/** Let věci, která šla do nádoby: odkud, kam, uběhlý čas. */
interface Flight {
  readonly from: Vector3;
  readonly to: Vector3;
  t: number;
}

export function SortScene({ session, cast, surface, scene: look }: SortSceneProps) {
  const world = session.world;
  const game = useMemo(() => nativeRule(world.rules, 'sort_tap')?.params as unknown as SortGame, [world]);
  const kinds = useMemo(() => {
    const initial = Int32Array.from(world.initial);
    return (body: number): number => bodyHp(initial, body) - 1;
  }, [world]);
  const models = useMemo(() => Array.from({ length: SORT.kinds }, (_, kind) => cast.things?.[`sort${kind}`]), [cast]);
  const [round, setRound] = useState(0);
  const plan = game.rounds[round] as SortGame['rounds'][number];
  const items = useMemo(() => Array.from({ length: plan.count }, (_, index) => plan.start + index), [plan]);
  const [binKinds, setBinKinds] = useState<number[]>(() => new Array<number>(BIN_POOL).fill(-1));

  const itemGroups = useRef(new Map<number, Group>());
  const rings = useRef(new Map<number, Mesh>());
  const spots = useRef(new Map<number, Vector3>());
  const flights = useRef(new Map<number, Flight>());
  const binGroups = useRef<(Group | null)[]>([]);
  const tokens = useRef<(Mesh | null)[][]>(Array.from({ length: BIN_POOL }, () => []));
  const slots = useRef<BinSlot[]>(Array.from({ length: BIN_POOL }, () => ({ index: -1, kind: -1, x: 0, sink: 0 })));
  const binAt = useRef(new Map<number, Vector3>());
  const hero = useRef<Group | null>(null);
  const marker = useRef<Group | null>(null);
  const timer = useRef<Group | null>(null);
  const timerColor = useRef<MeshStandardMaterial | null>(null);
  const shelf = useRef<(MeshStandardMaterial | null)[]>([]);
  const moving = useRef(false);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const size = useThree((three) => three.size);
  const probe = useMemo(() => new Vector3(), []);
  const center = useMemo(() => BOX.getCenter(new Vector3()), []);
  const heroRig = riggedCharacter(cast.player);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    const state = session.state();
    const prev = session.prev();
    const now = roundIn(state, game);
    if (now !== round) {
      setRound(now);
      return;
    }
    const step = 1 - Math.exp(-16 * delta);
    const board = boardOfState(state, game, now);
    const bins = boardBins(board);
    const at = (body: number, slot: number): number => lerp(prev[bodyBase(body) + slot] as number, state[bodyBase(body) + slot] as number, alpha);

    // Nádoby: viditelné drží svůj slot zásoby, nová přijede zprava, hotová zapadne.
    const pool = slots.current;
    const shown = new Set(bins.map((bin) => bin.index));
    for (const slot of pool) if (slot.index >= 0 && slot.sink <= 0 && !shown.has(slot.index)) slot.sink = SINK_S;
    let changed = false;
    bins.forEach((bin, place) => {
      const target = -m(binX(place, plan.show));
      let slot = pool.find((candidate) => candidate.index === bin.index && candidate.sink <= 0);
      if (slot === undefined) {
        slot = pool.find((candidate) => candidate.index < 0);
        if (slot === undefined) return;
        slot.index = bin.index;
        slot.x = target - m(SORT_LAYOUT.bin);
        if (slot.kind !== bin.kind) changed = true;
        slot.kind = bin.kind;
      }
      slot.x = lerp(slot.x, target, step);
      const own = pool.indexOf(slot);
      tokens.current[own]?.forEach((token, index) => token !== null && (token.visible = index < bin.fill));
      binAt.current.set(bin.kind, new Vector3(slot.x, 0.5, m(SORT_LAYOUT.binZ)));
    });
    pool.forEach((slot, own) => {
      const group = binGroups.current[own];
      if (group === null || group === undefined) return;
      if (slot.sink > 0) {
        slot.sink -= delta;
        if (slot.sink <= 0) slot.index = -1;
      }
      group.visible = slot.index >= 0;
      const sinking = slot.sink > 0 ? 1 - slot.sink / SINK_S : 0;
      group.position.set(slot.x, -1.2 * ease(sinking), m(SORT_LAYOUT.binZ));
      group.scale.setScalar(1 - 0.4 * sinking);
    });
    if (changed) setBinKinds(pool.map((slot) => slot.kind));

    // Věci: živé tam, kam je ovládání postavilo (hlubší než viditelné řady schované), poslané do nádoby doletí.
    const hidden = new Set(board.queues.flatMap((line) => line.slice(SORT_LAYOUT.rows).map((item) => item.body)));
    for (const body of items) {
      const group = itemGroups.current.get(body);
      if (group === undefined) continue;
      const base = bodyBase(body);
      const alive = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      let spot = spots.current.get(body);
      if (alive) {
        const z = Math.min(m(at(body, BODY.z)), m(rowZ(SORT_LAYOUT.rows)) + 2);
        const target = probe.set(-m(at(body, BODY.x)), 0, z);
        if (spot === undefined) spots.current.set(body, (spot = target.clone()));
        else spot.lerp(target, step);
        group.visible = !hidden.has(body);
        group.position.copy(spot);
        group.scale.setScalar(1);
        const rarity = rarityOf(state, body);
        const ring = rings.current.get(body);
        if (ring !== undefined) {
          ring.visible = rarity === 'rare' || rarity === 'epic';
          if (ring.visible) (ring.material as MeshStandardMaterial).color.set(rarity === 'epic' ? EPIC : RARE);
        }
        continue;
      }
      if (spot === undefined || !group.visible) continue;
      let flight = flights.current.get(body);
      if (flight === undefined) {
        flight = { from: spot.clone(), to: binAt.current.get(kinds(body))?.clone() ?? new Vector3(0, 0.5, m(SORT_LAYOUT.binZ)), t: 0 };
        flights.current.set(body, flight);
      }
      flight.t += delta;
      const t = Math.min(1, flight.t / FLY_S);
      group.position.lerpVectors(flight.from, flight.to, ease(t));
      group.position.y += Math.sin(Math.PI * t) * 1.2;
      group.scale.setScalar(1 - 0.55 * t);
      if (t >= 1) group.visible = false;
    }

    // Odkladiště: místa zčervenají, když zbývá poslední.
    const warn = board.buffer.length >= game.slots - 1;
    for (const material of shelf.current) material?.color.set(warn ? color.alarm : color['ink-soft']);

    // Hodiny kola: pruh se krátí, posledních 10 s v barvě poplachu.
    const counter = bodyBase(game.board);
    const clock = state[counter + BODY.y] === now ? (state[counter + BODY.x] as number) : 0;
    const { ticks } = game.rounds[now] as SortGame['rounds'][number];
    const left = Math.max(0, 1 - clock / ticks);
    timer.current?.scale.set(Math.max(0.001, left), 1, 1);
    timerColor.current?.color.set(left * ticks < 10 * ARCADE_HZ ? color.alarm : color['sun-deep']);

    // Hrdina za frontami jde ke zvolenému sloupci; značka před čelem zvolené fronty.
    const player = state[HEADER.player] as number;
    const heroX = -m(at(player, BODY.x));
    hero.current?.position.set(heroX, 0, m(SORT_LAYOUT.heroZ));
    moving.current = state[bodyBase(player) + BODY.x] !== prev[bodyBase(player) + BODY.x];
    const queues = plan.queues;
    const first = firstLane(queues);
    const chosen = Math.min(queues - 1, Math.max(0, laneOf(state, player) - first));
    if (marker.current !== null) marker.current.position.x = lerp(marker.current.position.x, -m(queueX(chosen, queues)), step);

    // Kamera: na výšku krabice hry v pásu mezi HUD a zónou palce, na šířku celá deska s mírnějším sklonem.
    const tall = camera.aspect < 1;
    const pitch = tall ? PITCH.tall : PITCH.wide;
    const back = probe.set(0, Math.sin(pitch), -Math.cos(pitch));
    camera.position.copy(center).addScaledVector(back, 20);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    const rect = tokenRect(size.width, size.height);
    const fit = tall ? fitTall(camera, BOX, rect) : { distance: fitWide(camera, BOX, size.width, size.height), shift: 0 };
    camera.position.copy(center).addScaledVector(probe.set(0, Math.sin(pitch), -Math.cos(pitch)), fit.distance);
    camera.lookAt(center);
    camera.updateMatrixWorld();
    if (tall) {
      // Na výšku je fit úzký (šíře desky), takže svisle zbude místo: deska se přisune dolů k zóně palce, ať nádoby
      // i čela front leží ve spodních 45 % výšky a nad nimi zbude místo pro hrdinu.
      camera.setViewOffset(size.width, size.height, 0, fit.shift, size.width, size.height);
      const bottom = ((1 - probe.set(0, 0, BOX.min.z).project(camera).y) / 2) * size.height;
      camera.setViewOffset(size.width, size.height, 0, fit.shift - (rect.bottom - BOTTOM_GAP_PX - bottom), size.width, size.height);
    } else if (camera.view !== null) camera.clearViewOffset();
    camera.updateMatrixWorld();

    const host = surface.current;
    if (host === null) return;
    const fraction = (x: number, z: number): { readonly x: number; readonly y: number } => {
      probe.set(x, 0.5, z).project(camera);
      return { x: (probe.x + 1) / 2, y: (1 - probe.y) / 2 };
    };
    const heads = m(rowZ(0));
    const edges = Array.from({ length: LANES.count - 1 }, (_, edge) => {
      if (edge < first) return '-1';
      if (edge >= first + queues - 1) return '2';
      const between = (queueX(edge - first, queues) + queueX(edge - first + 1, queues)) / 2;
      return fraction(-m(between), heads).x.toFixed(4);
    }).join(',');
    if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    const queue = String(chosen);
    if (host.dataset.sortQueue !== queue) host.dataset.sortQueue = queue;
    host.dataset.sortHeads = fraction(0, heads).y.toFixed(3);
    host.dataset.sortBins = fraction(0, m(SORT_LAYOUT.binZ)).y.toFixed(3);
    // Tik, ze kterého jsou hodnoty výš (e2e hraje po ticích a čte je až z nakresleného snímku).
    host.dataset.sortTick = String(state[HEADER.tick]);
  });

  const lanes = plan.queues;
  const deepest = m(rowZ(SORT_LAYOUT.rows - 1));
  return (
    <>
      <FieldGround look={look} area={LAND} y={-0.03} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={30} />
      {/* Pásy front: od řady čel po poslední viditelnou řadu. */}
      {Array.from({ length: lanes }, (_, queue) => (
        <mesh key={`lane-${lanes}-${queue}`} position={[-m(queueX(queue, lanes)), 0.01, (m(rowZ(0)) + deepest) / 2]} receiveShadow>
          <boxGeometry args={[m(SORT_LAYOUT.column) - 0.3, 0.04, deepest - m(rowZ(0)) + 1.4]} />
          <meshStandardMaterial color={color.cream} roughness={0.9} />
        </mesh>
      ))}
      <group ref={marker} position={[0, 0.03, m(rowZ(0)) - 0.95]}>
        <mesh rotation={[-Math.PI / 2, 0, Math.PI]}>
          <circleGeometry args={[0.42, 3]} />
          <meshStandardMaterial color={color.sun} emissive={color.sun} emissiveIntensity={0.35} />
        </mesh>
      </group>
      {/* Odkladiště: polička s místy. */}
      <mesh position={[0, 0.02, m(SORT_LAYOUT.bufferZ)]} receiveShadow>
        <boxGeometry args={[m(slotX(game.slots - 1, game.slots)) * 2 + 1.8, 0.05, 1.5]} />
        <meshStandardMaterial color={color['cream-deep']} roughness={0.9} />
      </mesh>
      {Array.from({ length: game.slots }, (_, place) => (
        <mesh key={`shelf-${place}`} position={[-m(slotX(place, game.slots)), 0.05, m(SORT_LAYOUT.bufferZ)]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.66, 0.78, 28]} />
          <meshStandardMaterial
            ref={(material) => {
              shelf.current[place] = material;
            }}
            color={color['ink-soft']}
          />
        </mesh>
      ))}
      {/* Hodiny kola: pruh mezi odkladištěm a nádobami, krátí se k levému okraji. */}
      <group ref={timer} position={[TIMER_W / 2, 0.04, (m(SORT_LAYOUT.bufferZ) + m(SORT_LAYOUT.binZ)) / 2 + 0.2]}>
        <mesh position={[-TIMER_W / 2, 0, 0]}>
          <boxGeometry args={[TIMER_W, 0.06, 0.16]} />
          <meshStandardMaterial
            ref={(material) => {
              timerColor.current = material;
            }}
            color={color['sun-deep']}
          />
        </mesh>
      </group>
      {binKinds.map((kind, own) => (
        <group
          key={`bin-${own}-${kind}`}
          ref={(group) => {
            binGroups.current[own] = group;
          }}
          visible={false}
          userData={{ item: 'sort-bin' }}
        >
          {kind >= 0 ? (
            <BinPiece
              model={models[kind]}
              kind={kind}
              onToken={(index, mesh) => {
                (tokens.current[own] as (Mesh | null)[])[index] = mesh;
              }}
            />
          ) : null}
        </group>
      ))}
      {items.map((body) => (
        <group
          key={body}
          ref={(group) => {
            if (group === null) itemGroups.current.delete(body);
            else itemGroups.current.set(body, group);
          }}
          visible={false}
          userData={{ item: `sort${kinds(body)}` }}
        >
          <ItemPiece
            model={models[kinds(body)]}
            kind={kinds(body)}
            onRing={(mesh) => {
              if (mesh === null) rings.current.delete(body);
              else rings.current.set(body, mesh);
            }}
          />
        </group>
      ))}
      <group ref={hero} position={[0, 0, m(SORT_LAYOUT.heroZ)]} rotation={[0, Math.PI, 0]} userData={{ frame: 'hero' }}>
        {heroRig !== undefined ? (
          <RiggedModel character={heroRig} h={HERO_H} clip={() => (moving.current ? 'run' : 'idle')} fallback={color['sky-deep']} />
        ) : (
          <FittedModel id={cast.player} w={HERO_H * 0.75} h={HERO_H} d={HERO_H * 0.6} fallback={color['sky-deep']} character />
        )}
      </group>
    </>
  );
}
