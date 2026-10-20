'use client';

/**
 * Scéna slučování (P54C T11): nádoba zepředu, nad ní hrdina na kolejnici drží další předmět. Předměty jsou koule
 * Rapieru – scéna je kreslí podle stavu jádra (poloha interpolovaná mezi tiky, natočení z `aux0/aux1`), výchozí
 * ovoce jako řada z katalogu (třešeň → meloun), jinak model z popisku věty v šesti velikostech. Kameny (předmět, který
 * hráč nepustil včas) jsou balvany vepsané do kvádru těla.
 *
 * Jen obraz, mimo stav i hash: kroužek trpělivosti kolem drženého předmětu (dílky ubývají, na konci rajčatové),
 * vodicí čára pustu na zadní stěně, náhled příštího předmětu se štítkem „Next“, záblesk víka a štítek „Too full!“,
 * když nad víkem něco je, a natočení kamery. x jádra se zrcadlí (kamera kouká po +z), takže +x je na obrazovce
 * vpravo. Předměty kreslí instance – jedna síť na úroveň a díl modelu, strop sítí telefonu (p35-perf, 200) tak
 * nezávisí na plnosti nádoby.
 *
 * Vstup si scéna zapíná sama (`merge-input.ts`) a zapíše plátnu `data-drop-edges`: kde na šířce plátna leží levý
 * a pravý kraj dosahu dávkovače, podle čehož prst míří.
 */

import { Html } from '@react-three/drei/web/Html';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BoxGeometry, type BufferGeometry, type Group, type InstancedMesh, type Material, Matrix4, type Mesh, MeshStandardMaterial, type Object3D, type PerspectiveCamera, Quaternion, SphereGeometry, Vector3 } from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, nativeRule, unpackRotation } from '@/play/arcade/contract';
import { riggedCharacter, sceneModelOf } from '@/play/arcade/models';
import { MERGE, MERGE_DEPTH, MERGE_ITEM, MERGE_LEVELS, clockOf, dropLimit, dropsOf, itemLevel, overOf, patienceOf, queued, sizeOf } from '@/play/arcade/pieces/merge-drop';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { loadBodyModel } from '../../look/load';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps, fitModel } from '../../World';
import { useMergeInput } from './merge-input';

const m = (units: number): number => units / UNIT;
const HALF = m(MERGE.half);
const WALL = m(MERGE.wall);
const LID = m(MERGE.lid);
const HEIGHT = m(MERGE.lid + MERGE.wallOver);
const DEPTH = m(MERGE_DEPTH);
const DROPPER_Y = m(MERGE.dropperY);
const REACH = dropLimit(sizeOf(1));
/** Výchozí řada ovoce úrovní 1–6 (katalog). */
const FRUIT_CHAIN = ['gen3d-red-cherry', 'gen3d-strawberry', 'gen3d-lemon', 'gen3d-orange', 'gen3d-pear', 'gen3d-suika'] as const;
const STONE_MODEL = 'gen3d-river-boulder';
/** Barvy úrovní pro kouli, dokud se model nenačte (nebo když ho katalog nemá). */
const LEVEL_TINTS = [color.tomato, color.bubblegum, color['sun-soft'], color['sun-deep'], color.sun, color.grass] as const;
/** Kolik předmětů jedné úrovně scéna nakreslí naráz (víc se do nádoby nevejde). */
const CAPACITY = 48;
/** Hrdina na kolejnici nad nádobou (m). */
const HERO = { w: 0.7, h: 1.1, d: 0.6 } as const;
/** Dílky kroužku trpělivosti a jeho poloměr nad poloměrem předmětu (m). */
const RING_PARTS = 20;
const RING_GAP = 0.14;
/** Náhled příštího předmětu: místo (j jádra, vpravo nahoře v nádobě) a zmenšení. */
const PREVIEW = { x: MERGE.half - 450, y: MERGE.lid + 1700, scale: 0.55 } as const;
/** Od kolika tiků nad víkem scéna varuje (pod tím jde o předmět, který jen prolétá). */
const OVER_WARN = 12;
/** Kamera: co se musí vejít (m) a kam kouká. */
const FRAME = { halfWidth: HALF + WALL + 0.35, bottom: -0.4, top: DROPPER_Y + HERO.h + 0.5, elevation: 0.08 } as const;

type MergeSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;

interface Part {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** Materiál patří instanci (primitivum), ne mezipaměti modelů. */
  readonly own: boolean;
}

/**
 * Jeden druh těl jako instance: model vepsaný do kostky hrany `size` (`fitModel`), střed v počátku (točí se kolem
 * něj), rozložený na sítě se zapečenou maticí – každá síť jedna `InstancedMesh`. Bez modelu (nebo než se načte)
 * koule nebo kostka v barvě `tint`. Velikost instance dá měřítko matice.
 */
function Instances({ model, size, tint, ball, holder, item }: { readonly model: string; readonly size: number; readonly tint: string; readonly ball: boolean; readonly holder: React.RefObject<Group | null>; readonly item: string }) {
  const [loaded, setLoaded] = useState<Object3D | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadBodyModel(model).then((found) => {
      if (live) setLoaded(found);
    });
    return () => {
      live = false;
    };
  }, [model]);
  const parts = useMemo((): readonly Part[] => {
    if (loaded === null || loaded === undefined) {
      const geometry = ball ? new SphereGeometry(size / 2, 20, 14) : new BoxGeometry(size, size, size);
      return [{ geometry, material: new MeshStandardMaterial({ color: tint, roughness: 0.55 }), own: true }];
    }
    const fitted = fitModel(loaded, { id: model, w: size, h: size, d: size });
    fitted.updateMatrixWorld(true);
    const out: Part[] = [];
    fitted.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh === true && !Array.isArray(mesh.material)) out.push({ geometry: mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).translate(0, -size / 2, 0), material: mesh.material as Material, own: false });
    });
    return out;
  }, [model, loaded, size, tint, ball]);
  useEffect(
    () => () => {
      for (const part of parts) {
        part.geometry.dispose();
        if (part.own) part.material.dispose();
      }
    },
    [parts],
  );
  useLayoutEffect(() => place(holder.current, [], 0), [holder, parts]);
  return (
    <group ref={holder} userData={{ item }}>
      {parts.map((part, index) => (
        <instancedMesh key={index} args={[part.geometry, part.material, CAPACITY]} castShadow receiveShadow frustumCulled={false} />
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
  readonly matrices: Matrix4[] = Array.from({ length: CAPACITY }, () => new Matrix4());
  count = 0;
  add(position: Vector3, turn: Quaternion, scale: Vector3): void {
    if (this.count < CAPACITY) (this.matrices[this.count++] as Matrix4).compose(position, turn, scale);
  }
}

const NO_TURN = new Quaternion();

/** Natočení tělesa Rapieru ve scéně: x jádra je zrcadlené, takže i kvaternion (y a z složka mění znaménko). */
function turnOf(state: Int32Array, body: number, out: Quaternion): Quaternion {
  const base = bodyBase(body);
  const [x, y, z, w] = unpackRotation(state[base + BODY.aux0] as number, state[base + BODY.aux1] as number);
  return out.set(x, -y, -z, w).normalize();
}

export function MergeScene({ session, cast, surface, scene: look, enabled, ghost }: MergeSceneProps) {
  const world = session.world;
  const queue = useMemo(() => (nativeRule(world.rules, 'merge_drop')?.params.queue ?? [1]) as readonly number[], [world]);
  const input = useMergeInput(session, surface, enabled);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  // Výchozí ovoce kreslí řadu ovoce; předmět z věty má model z popisku ve všech velikostech.
  const named = cast.things?.item;
  const models = useMemo(() => (named === undefined || named === sceneModelOf(MERGE_ITEM, false) ? [...FRUIT_CHAIN] : FRUIT_CHAIN.map(() => named)), [named]);
  const heroRig = riggedCharacter(cast.player);

  const hero = useRef<Group | null>(null);
  const holders = useMemo(() => Array.from({ length: MERGE_LEVELS }, (): React.RefObject<Group | null> => ({ current: null })), []);
  const stones = useRef<Group | null>(null);
  const ring = useRef<Group | null>(null);
  const guide = useRef<Mesh | null>(null);
  const fullTag = useRef<HTMLSpanElement | null>(null);
  const nextTag = useRef<Group | null>(null);
  const clock = useRef(0);
  const lidMaterial = useMemo(() => new MeshStandardMaterial({ color: color.tomato, emissive: color.tomato, emissiveIntensity: 0, roughness: 0.5 }), []);
  const ringParts = useMemo(() => ({ geometry: new BoxGeometry(0.1, 0.05, 0.05), material: new MeshStandardMaterial({ color: color.ink, roughness: 0.6 }) }), []);
  useEffect(
    () => () => {
      lidMaterial.dispose();
      ringParts.geometry.dispose();
      ringParts.material.dispose();
    },
    [lidMaterial, ringParts],
  );
  const scratch = useMemo(
    () => ({
      levels: Array.from({ length: MERGE_LEVELS }, () => new Slots()),
      stones: new Slots(),
      ring: new Slots(),
      at: new Vector3(),
      size: new Vector3(),
      turn: new Quaternion(),
      look: new Vector3(),
      probe: new Vector3(),
    }),
    [],
  );

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    input.current.settle();
    if (renderHeld(session)) return;
    clock.current += delta;
    const state = session.state();
    const prev = session.prev();
    const lerp = (body: number, slot: number): number => {
      const base = bodyBase(body);
      const now = state[base + slot] as number;
      // Tělo, které v minulém tiku nežilo nebo mělo jinou velikost (nový slot spawnu), se neinterpoluje.
      const fresh = ((prev[base + BODY.flags] as number) & FLAG.alive) === 0 || prev[base + BODY.w] !== state[base + BODY.w];
      return fresh ? now : (prev[base + slot] as number) + (now - (prev[base + slot] as number)) * alpha;
    };
    const player = state[HEADER.player] as number;
    const dropperX = -m(lerp(player, BODY.x));
    hero.current?.position.set(dropperX, DROPPER_Y, 0);

    for (const slots of scratch.levels) slots.count = 0;
    scratch.stones.count = 0;
    scratch.ring.count = 0;
    for (let body = 0; body < (state[HEADER.bodyCount] as number); body += 1) {
      const base = bodyBase(body);
      if (((state[base + BODY.flags] as number) & (FLAG.alive | FLAG.physics)) !== (FLAG.alive | FLAG.physics)) continue;
      const size = m(state[base + BODY.w] as number);
      scratch.at.set(-m(lerp(body, BODY.x)), m(lerp(body, BODY.y)) + size / 2, m(lerp(body, BODY.z)));
      turnOf(state, body, scratch.turn);
      const level = itemLevel(state, body);
      if (level > 0) {
        // Předlohy úrovní mají svou velikost, instance kreslí v měřítku 1.
        (scratch.levels[level - 1] as Slots).add(scratch.at, scratch.turn, scratch.size.set(1, 1, 1));
      } else if (state[base + BODY.role] === ROLE.obstacle) scratch.stones.add(scratch.at, scratch.turn, scratch.size.set(size, size, size));
    }

    // Držený předmět pod dávkovačem: připravený plně, při přebíjení vyrůstá; kolem kroužek trpělivosti.
    const tick = state[HEADER.tick] as number;
    const running = state[HEADER.runState] === 0;
    const timer = clockOf(state);
    const drops = dropsOf(state);
    const level = queued(queue, drops);
    const radius = m(sizeOf(level)) / 2;
    const heldX = -m(Math.max(-dropLimit(sizeOf(level)), Math.min(dropLimit(sizeOf(level)), state[bodyBase(player) + BODY.x] as number)));
    const heldY = m(MERGE.lid + MERGE.dropGap) + radius;
    const grown = timer <= 0 ? 1 : Math.max(0.15, 1 - timer / MERGE.reload);
    if (running) (scratch.levels[level - 1] as Slots).add(scratch.at.set(heldX, heldY, 0), NO_TURN, scratch.size.set(grown, grown, grown));
    const patience = timer <= 0 ? Math.max(0, 1 - -timer / patienceOf(tick)) : 1;
    if (running && timer <= 0) {
      const shown = Math.ceil(patience * RING_PARTS);
      const late = patience < 0.35;
      for (let part = 0; part < shown; part += 1) {
        const angle = Math.PI / 2 + (part / RING_PARTS) * Math.PI * 2;
        const r = radius + RING_GAP;
        scratch.turn.setFromAxisAngle(scratch.look.set(0, 0, 1), angle);
        scratch.ring.add(scratch.at.set(heldX + Math.cos(angle) * r, heldY + Math.sin(angle) * r, -0.05), scratch.turn, scratch.size.set(late ? 1.4 : 1, 1, 1));
      }
      ringParts.material.color.set(late ? color.tomato : color.ink);
    }
    // Náhled příštího předmětu vpravo nahoře.
    const next = queued(queue, drops + 1);
    const preview = PREVIEW.scale;
    (scratch.levels[next - 1] as Slots).add(scratch.at.set(-m(PREVIEW.x), m(PREVIEW.y), 0), NO_TURN, scratch.size.set(preview, preview, preview));
    nextTag.current?.position.set(-m(PREVIEW.x), m(PREVIEW.y) + (m(sizeOf(next)) * preview) / 2 + 0.35, 0);

    holders.forEach((holder, index) => place(holder.current, (scratch.levels[index] as Slots).matrices, (scratch.levels[index] as Slots).count));
    place(stones.current, scratch.stones.matrices, scratch.stones.count);
    place(ring.current, scratch.ring.matrices, scratch.ring.count);

    // Vodicí čára pustu na zadní stěně, od drženého předmětu ke dnu.
    if (guide.current !== null) {
      guide.current.visible = running && timer <= 0;
      guide.current.position.set(heldX, (heldY - radius) / 2, DEPTH / 2 - 0.02);
      guide.current.scale.set(1, Math.max(0.01, heldY - radius), 1);
    }
    // Víko bliká, dokud nad ním něco leží (čerstvě puštěný předmět jen prolétá); štítek varuje.
    const over = overOf(state) >= OVER_WARN;
    lidMaterial.emissiveIntensity = over ? 0.4 + 0.4 * Math.abs(Math.sin(clock.current * 10)) : 0;
    if (fullTag.current !== null) fullTag.current.style.visibility = over && running ? 'visible' : 'hidden';

    // Kamera zepředu: na výšku telefonu rozhoduje šíře nádoby, na šířku výška od dna po hrdinu.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const midY = (FRAME.top + FRAME.bottom) / 2;
    const distance = Math.max((FRAME.top - FRAME.bottom) / 2 / tan, FRAME.halfWidth / (tan * camera.aspect)) + DEPTH;
    camera.position.set(0, midY + distance * FRAME.elevation, -distance);
    camera.lookAt(scratch.look.set(0, midY, 0));
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    // Prst míří podle krajů dosahu dávkovače promítnutých ve výšce drženého předmětu (−dosah jádra je ve scéně +x).
    const left = (scratch.probe.set(m(REACH), heldY, 0).project(camera).x + 1) / 2;
    const right = (scratch.probe.set(-m(REACH), heldY, 0).project(camera).x + 1) / 2;
    const edges = `${left.toFixed(4)},${right.toFixed(4)}`;
    if (host.dataset.dropEdges !== edges) host.dataset.dropEdges = edges;
    host.dataset.playerX = scratch.probe.set(dropperX, DROPPER_Y, 0).project(camera).x.toFixed(3);
  });

  const back = DEPTH / 2 + WALL / 2;
  return (
    <>
      <FieldGround look={look} area={{ x0: -30, x1: 30, z0: -30, z1: 40 }} y={-0.02} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={12} />
      {/* Nádoba: dno, boční stěny s inkoustovým okrajem, zadní stěna; přední sklo jádra se nekreslí. */}
      <mesh position={[0, -0.1, 0]} receiveShadow>
        <boxGeometry args={[2 * (HALF + WALL), 0.2, DEPTH + 2 * WALL]} />
        <meshStandardMaterial color={color['ink-soft']} roughness={0.8} />
      </mesh>
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (HALF + WALL / 2), HEIGHT / 2, 0]}>
          <mesh castShadow receiveShadow>
            <boxGeometry args={[WALL, HEIGHT, DEPTH + 2 * WALL]} />
            <meshStandardMaterial color={color['cream-deep']} roughness={0.8} />
          </mesh>
          <mesh position={[0, HEIGHT / 2 + 0.04, 0]}>
            <boxGeometry args={[WALL + 0.04, 0.08, DEPTH + 2 * WALL + 0.04]} />
            <meshStandardMaterial color={color.ink} roughness={0.7} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, HEIGHT / 2, back]} receiveShadow>
        <boxGeometry args={[2 * HALF, HEIGHT, WALL]} />
        <meshStandardMaterial color={color.cream} roughness={0.9} />
      </mesh>
      {/* Víko: čára, nad kterou nic nesmí zůstat. */}
      <mesh position={[0, LID, -DEPTH / 2]} material={lidMaterial}>
        <boxGeometry args={[2 * HALF, 0.06, 0.06]} />
      </mesh>
      <mesh position={[0, LID, back - WALL / 2 - 0.01]} material={lidMaterial}>
        <boxGeometry args={[2 * HALF, 0.05, 0.02]} />
      </mesh>
      <mesh ref={guide} position={[0, 1, back - WALL / 2 - 0.02]} visible={false}>
        <boxGeometry args={[0.035, 1, 0.01]} />
        <meshStandardMaterial color={color['ink-faint']} roughness={0.9} />
      </mesh>
      {/* Kolejnice dávkovače přes celou nádobu. */}
      <mesh position={[0, DROPPER_Y - 0.06, 0]} castShadow>
        <boxGeometry args={[2 * (HALF + WALL), 0.12, 0.16]} />
        <meshStandardMaterial color={color.ink} roughness={0.6} />
      </mesh>
      {models.map((model, index) => (
        <Instances key={`${model}-${String(index)}`} model={model} size={m(sizeOf(index + 1))} tint={LEVEL_TINTS[index] as string} ball holder={holders[index] as React.RefObject<Group | null>} item="item" />
      ))}
      <Instances model={STONE_MODEL} size={1} tint={color['ink-faint']} ball={false} holder={stones} item="stone" />
      <group ref={ring}>
        <instancedMesh args={[ringParts.geometry, ringParts.material, CAPACITY]} frustumCulled={false} />
      </group>
      <group ref={nextTag}>
        <Html center pointerEvents="none" zIndexRange={[10, 0]}>
          <span className="sp-world-tag sp-world-tag--goal" data-testid="merge-next">
            Next
          </span>
        </Html>
      </group>
      <group position={[0, LID + 0.45, -DEPTH / 2]}>
        <Html center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={fullTag} className="sp-world-tag" data-testid="merge-full" style={{ visibility: 'hidden' }}>
            Too full!
          </span>
        </Html>
      </group>
      <group ref={hero} position={[0, DROPPER_Y, 0]} userData={{ frame: 'hero' }}>
        {/* Hrdina stojí na kolejnici čelem ke kameře. */}
        <group rotation={[0, Math.PI, 0]}>
          {heroRig !== undefined ? (
            <RiggedModel character={heroRig} h={HERO.h} clip={() => 'idle'} fallback={color['sky-deep']} />
          ) : (
            <FittedModel id={cast.player} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
          )}
        </group>
      </group>
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
