'use client';

/**
 * Scéna davu a bran (P54C T10): dav běží zezadu shora po trati, před ním dvojice bran s čísly (modrá roste,
 * rajčatová ubírá), pily v pruzích a na konci zlobr před hradem. x jádra se zrcadlí jako u běžce a přeskákání:
 * kamera kouká po +z, takže pruh −1 je na obrazovce vlevo.
 *
 * Dav kreslí instance jednoho modelu (`cast.player`, u riggované postavy kluk z katalogu) rozestavené kolem hrdiny
 * do kotouče – kolik jich je, říká čítač davu jádra (nejvýš `SHOWN`). Kotouč, poskakování, výpad k obrovi, kamera
 * a čísla bran jsou jen obraz: stav ani hash nemění. Počet davu a síla obra visí nad nimi jako štítky kitu
 * (`sp-world-tag`, DOM, ne WebGL). Brány se kreslí ze zásoby slotů (`SLOTS` dvojic před hrdinou), ať strop sítí
 * telefonu (p35-perf, 200) nezávisí na délce trati.
 *
 * Vstup je vstup pruhů (`lanes-input.ts`, ArcadeStage ho zapne podle `STAGES.crowd`): scéna zapíše `data-lane-edges`
 * se všemi hranicemi uprostřed trati, takže prst v levé půlce plátna je pruh −1 a v pravé +1.
 */

import { Html } from '@react-three/drei/web/Html';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  type Group,
  type InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from 'three';

import { color } from '@/brand/tokens';
import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase, bodyHp, nativeRule } from '@/play/arcade/contract';
import { riggedCharacter } from '@/play/arcade/models';
import { CROWD, type GateRef, OP, crowdOf, gateLabel } from '@/play/arcade/pieces/crowd';

import { renderHeld } from '../../effects/render-feel';
import { worldPlacement } from '../../Ghost';
import { GhostSlot } from '../../GhostSlot';
import { HorizonBackdrop } from '../../look/Backdrop';
import { FieldGround } from '../../look/FieldGround';
import { loadBodyModel } from '../../look/load';
import { RiggedModel } from '../../RiggedModel';
import { FittedModel, type WorldProps, fitModel } from '../../World';

const m = (units: number): number => units / UNIT;
const LANE = m(CROWD.laneX);
const GATE_W = m(CROWD.gateW);
/** Polovina šíře trati (m): dva pruhy bran a obruba. */
const ROAD_HALF = LANE + GATE_W / 2 + 0.35;
/** Hrdina vede dav: o půl hlavy větší než panáčci, ne tak velký jako jeho tělo v jádře (to je jen pro kolize). */
const HERO = { w: 0.5, h: 0.95, d: 0.45 } as const;
/** Panáček davu (m) a kolik jich scéna nejvýš kreslí. */
const MEMBER = { w: 0.34, h: 0.55, d: 0.3 } as const;
const SHOWN = 160;
/** Dvojic bran, které scéna kreslí naráz (před hrdinou a jedna za ním). */
const SLOTS = 10;
/** Brána: spodní a horní hrana cedule, sloupek, pás na zemi (m). */
const SIGN = { bottom: 1.85, h: 0.9 } as const;
const POST = { r: 0.09, h: SIGN.bottom + SIGN.h } as const;
const PAD_D = 0.7;
/** Tráva kolem trati a trať za čárou souboje (m). */
const LEAD_IN = 12;
const RUN_OUT = 26;
/** Kamera: polovina šíře, která se vejde, náklon, rozsah vzdálenosti a kam před hrdinu kouká. */
const CAMERA = { fit: ROAD_HALF + 0.3, elevation: (40 * Math.PI) / 180, near: 9, far: 20, ahead: 2 } as const;

type CrowdSceneProps = Omit<WorldProps, 'control' | 'backdrop'>;
type Box3D = readonly [w: number, h: number, d: number];

/** Roste brána dav? (+N a ×N modře, −N a ÷N rajčatově.) */
const grows = (op: number): boolean => op === OP.add || op === OP.mul;

/** Cedule brány: číslo v barvě kitu na plném podkladu s inkoustovým okrajem (žádná průhlednost). */
function signTexture(label: string, grow: boolean): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 112;
  const context = canvas.getContext('2d') as CanvasRenderingContext2D;
  context.fillStyle = grow ? color['sky-deep'] : color.tomato;
  context.strokeStyle = color.ink;
  context.lineWidth = 10;
  context.beginPath();
  context.roundRect(5, 5, 246, 102, 18);
  context.fill();
  context.stroke();
  context.fillStyle = color.paper;
  context.font = '900 76px Roboto, system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, 128, 60);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

interface Part {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** Materiál patří instanci (primitivum), ne mezipaměti modelů. */
  readonly own: boolean;
}

/**
 * Jeden druh těl jako instance: model vepsaný do kvádru (`fitModel`), rozložený na sítě se zapečenou maticí; každá
 * síť jedna `InstancedMesh`. Bez modelu (nebo než se načte) kvádr v barvě kitu. Scéna instance rozmísťuje (`place`).
 */
function Instances({ model, box, capacity, tint, holder, item, character = false, centred = false }: { readonly model?: string; readonly box: Box3D; readonly capacity: number; readonly tint: string; readonly holder: React.RefObject<Group | null>; readonly item?: string; readonly character?: boolean; readonly centred?: boolean }) {
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
    // Střed kvádru v počátku (točí se kolem něj), jinak podstava.
    const lift = centred ? -h / 2 : 0;
    if (model === undefined || loaded === null || loaded === undefined) {
      return [{ geometry: new BoxGeometry(w, h, d).translate(0, h / 2 + lift, 0), material: new MeshStandardMaterial({ color: tint, roughness: 0.6 }), own: true }];
    }
    const fitted = fitModel(loaded, { id: model, w, h, d, character });
    fitted.updateMatrixWorld(true);
    const out: Part[] = [];
    fitted.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh === true && !Array.isArray(mesh.material)) out.push({ geometry: mesh.geometry.clone().applyMatrix4(mesh.matrixWorld).translate(0, lift, 0), material: mesh.material as Material, own: false });
    });
    return out;
  }, [model, loaded, w, h, d, tint, character, centred]);
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
    <group ref={holder} userData={item === undefined ? {} : { item }}>
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

const ONE = new Vector3(1, 1, 1);
const FORWARD = new Quaternion();
/** Pila stojí napříč pruhem čelem k davu a točí se kolem osy z; její průměr (m). */
const AXLE = new Vector3(0, 0, 1);
const SAW = 1.6;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** Místo panáčka `index` v kotouči za hrdinou (m, x jádra nezrcadlené): zlatý úhel, elipsa užší napříč (do 1 m, pruh). */
function formation(index: number): readonly [x: number, z: number] {
  const r = 0.24 * Math.sqrt(index + 1);
  const angle = index * GOLDEN;
  return [r * Math.cos(angle) * 0.33, r * Math.sin(angle) * 0.7 - 0.7 - r * 0.3];
}

export function CrowdScene({ session, cast, surface, scene: look, ghost }: CrowdSceneProps) {
  const world = session.world;
  const gates = useMemo(() => (nativeRule(world.rules, 'crowd_gate')?.params.gates ?? []) as readonly GateRef[], [world]);
  const fight = useMemo(() => nativeRule(world.rules, 'crowd_fight')?.params as { readonly boss: number; readonly stop: number }, [world]);
  const obstacles = useMemo(() => {
    const out: number[] = [];
    for (let body = 1; body < (world.initial[HEADER.bodyCount] as number); body += 1) if (world.initial[bodyBase(body) + BODY.role] === ROLE.obstacle) out.push(body);
    return out;
  }, [world]);
  const boss = useMemo(() => {
    const base = bodyBase(fight.boss);
    return { z: m(world.initial[base + BODY.z] as number), w: m(world.initial[base + BODY.w] as number), h: m(world.initial[base + BODY.h] as number), d: m(world.initial[base + BODY.d] as number) };
  }, [world, fight]);
  const stopM = m(fight.stop);
  const end = boss.z + boss.d / 2 + RUN_OUT;
  const land = useMemo(() => ({ x0: -40, x1: 40, z0: -30, z1: end + 40 }), [end]);
  const textures = useMemo(() => new Map<string, CanvasTexture>(), []);
  useEffect(() => () => textures.forEach((texture) => texture.dispose()), [textures]);
  const textureOf = (op: number, n: number): CanvasTexture => {
    const label = gateLabel(op, n);
    let texture = textures.get(label);
    if (texture === undefined) textures.set(label, (texture = signTexture(label, grows(op))));
    return texture;
  };
  const signMaterials = useMemo(() => Array.from({ length: 2 * SLOTS }, () => new MeshBasicMaterial({ toneMapped: false })), []);
  useEffect(() => () => signMaterials.forEach((material) => material.dispose()), [signMaterials]);
  const signGeometry = useMemo(() => new BoxGeometry(GATE_W, SIGN.h, 0.08), []);
  useEffect(() => () => signGeometry.dispose(), [signGeometry]);

  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const hero = useRef<Group | null>(null);
  const members = useRef<Group | null>(null);
  const posts = useRef<Group | null>(null);
  const pads = { grow: useRef<Group | null>(null), shrink: useRef<Group | null>(null) };
  const saws = useRef<Group | null>(null);
  const bossGroup = useRef<Group | null>(null);
  const crowdTag = useRef<Group | null>(null);
  const crowdText = useRef<HTMLSpanElement | null>(null);
  const bossText = useRef<HTMLSpanElement | null>(null);
  const signs = useRef<(Mesh | null)[]>([]);
  const shown = useRef<number[]>(Array.from({ length: SLOTS }, () => -1));
  const clock = useRef(0);
  const moving = useRef(false);
  const bossStart = useMemo(() => bodyHp(Int32Array.from(world.initial), fight.boss), [world, fight]);
  const scratch = useMemo(
    () => ({
      members: new Slots(SHOWN),
      posts: new Slots(3 * SLOTS),
      grow: new Slots(2 * SLOTS),
      shrink: new Slots(2 * SLOTS),
      saws: new Slots(Math.max(1, obstacles.length)),
      at: new Vector3(),
      size: new Vector3(),
      turn: new Quaternion(),
      look: new Vector3(),
      probe: new Vector3(),
    }),
    [obstacles],
  );
  const heroRig = riggedCharacter(cast.player);
  // Dav je z modelu hrdiny; riggovaná postava (kostra by se v instanci nehýbala) dá kluka z katalogu.
  const memberModel = heroRig === undefined ? cast.player : 'kid';
  const sawModel = cast.props.obstacle ?? 'cc0-hazard-saw';
  const bossModel = cast.things?.boss ?? 'gen3d-ogre';

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (renderHeld(session)) return;
    clock.current += delta;
    const state = session.state();
    const prev = session.prev();
    const player = state[HEADER.player] as number;
    const base = bodyBase(player);
    const lerp = (slot: number): number => m((prev[base + slot] as number) + ((state[base + slot] as number) - (prev[base + slot] as number)) * alpha);
    const heroX = -lerp(BODY.x);
    const heroZ = lerp(BODY.z);
    hero.current?.position.set(heroX, 0, heroZ);
    const fighting = (state[base + BODY.z] as number) >= fight.stop;
    const running = state[HEADER.runState] === 0 && !fighting && (state[HEADER.tick] as number) > 0;

    // Brány: zásoba `SLOTS` dvojic od první, kterou hrdina ještě nemá daleko za sebou.
    const first = gates.findIndex((gate) => m(gate[0]) > heroZ - 3);
    for (const slots of [scratch.posts, scratch.grow, scratch.shrink, scratch.saws, scratch.members]) slots.count = 0;
    for (let slot = 0; slot < SLOTS; slot += 1) {
      const index = first < 0 ? -1 : first + slot;
      const gate = index < 0 ? undefined : gates[index];
      for (const side of [0, 1]) {
        const sign = signs.current[2 * slot + side];
        if (sign === null || sign === undefined) continue;
        sign.visible = gate !== undefined;
        if (gate === undefined) continue;
        const op = side === 0 ? gate[1] : gate[3];
        const n = side === 0 ? gate[2] : gate[4];
        // Strana −1 jádra (vlevo na obrazovce) je ve scéně +x.
        const x = side === 0 ? LANE : -LANE;
        sign.position.set(x, SIGN.bottom + SIGN.h / 2, m(gate[0]));
        if (shown.current[slot] !== index) {
          const material = signMaterials[2 * slot + side] as MeshBasicMaterial;
          material.map = textureOf(op, n);
          material.needsUpdate = true;
        }
        (grows(op) ? scratch.grow : scratch.shrink).add(scratch.at.set(x, 0.015, m(gate[0])), FORWARD, ONE);
      }
      if (gate !== undefined) {
        shown.current[slot] = index;
        for (const x of [LANE + GATE_W / 2, 0, -LANE - GATE_W / 2]) scratch.posts.add(scratch.at.set(x, 0, m(gate[0])), FORWARD, ONE);
      }
    }

    // Pily v pruzích (živé překážky jádra) se točí kolem své osy, čelem k davu.
    scratch.turn.setFromAxisAngle(AXLE, clock.current * 9);
    for (const body of obstacles) {
      const at = bodyBase(body);
      if (((state[at + BODY.flags] as number) & FLAG.alive) === 0) continue;
      const z = m(state[at + BODY.z] as number);
      if (z < heroZ - 4 || z > heroZ + 60) continue;
      scratch.saws.add(scratch.at.set(-m(state[at + BODY.x] as number), SAW / 2 + 0.05, z), scratch.turn, ONE);
    }

    // Dav: kotouč kolem hrdiny, poskakuje v běhu; v souboji se proudem valí do zlobra.
    const crowd = crowdOf(state);
    const count = Math.min(SHOWN, Math.max(0, crowd));
    const front = boss.z - boss.d / 2;
    const bossAlive = ((state[bodyBase(fight.boss) + BODY.flags] as number) & FLAG.alive) !== 0;
    moving.current = running || fighting;
    for (let index = 0; index < count; index += 1) {
      const [dx, dz] = formation(index);
      const hop = moving.current ? Math.abs(Math.sin(clock.current * 11 + index * 1.7)) * 0.09 : 0;
      const x = heroX - dx;
      const z = heroZ + dz;
      // V souboji běží panáčci jeden po druhém k čelu zlobra (doprostřed trati) a znovu – úbytek ukazuje čítač.
      const charge = fighting && bossAlive ? (clock.current * 1.6 + index * 0.37) % 1 : 0;
      scratch.members.add(scratch.at.set(x + (0 - x) * charge, hop, z + Math.max(0, front - z) * charge), FORWARD, ONE);
    }
    place(members.current, scratch.members.matrices, scratch.members.count);
    place(posts.current, scratch.posts.matrices, scratch.posts.count);
    place(pads.grow.current, scratch.grow.matrices, scratch.grow.count);
    place(pads.shrink.current, scratch.shrink.matrices, scratch.shrink.count);
    place(saws.current, scratch.saws.matrices, scratch.saws.count);
    if (crowdTag.current !== null) crowdTag.current.position.set(heroX, HERO.h + 0.55, heroZ - 0.6);
    if (crowdText.current !== null) {
      const text = String(Math.max(0, crowd));
      if (crowdText.current.textContent !== text) crowdText.current.textContent = text;
    }

    // Zlobr: dokud žije; síla na jeho hrudi je jeho HP (štítek DOM skryje scéna sama, `Html` viditelnost skupiny nečte).
    const near = bossAlive && boss.z - heroZ < 70;
    if (bossGroup.current !== null) {
      bossGroup.current.visible = near;
      bossGroup.current.rotation.z = fighting ? Math.sin(clock.current * 18) * 0.03 : 0;
    }
    if (bossText.current !== null) {
      const text = String(bodyHp(state, fight.boss));
      if (bossText.current.textContent !== text) bossText.current.textContent = text;
      bossText.current.style.visibility = near ? 'visible' : 'hidden';
    }

    // Kamera za davem a nad ním, jede s ním (běží stálou rychlostí, vyhlazení by ho jen posunulo); na výšku rozhoduje šíře trati.
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    const distance = Math.max(CAMERA.near, Math.min(CAMERA.far, CAMERA.fit / (tan * camera.aspect)));
    const lookZ = Math.min(heroZ, stopM) + CAMERA.ahead;
    camera.position.set(0, distance * Math.sin(CAMERA.elevation), lookZ - distance * Math.cos(CAMERA.elevation));
    camera.lookAt(scratch.look.set(0, 0, lookZ));
    const host = surface.current;
    if (host === null) return;
    camera.updateMatrixWorld();
    // Prst: levá půlka plátna je pruh −1 jádra, pravá +1 – všechny hranice pruhů leží na středu trati u hrdiny.
    const middle = ((scratch.probe.set(0, 0, heroZ).project(camera).x + 1) / 2).toFixed(4);
    const edges = `${middle},${middle},${middle},${middle}`;
    if (host.dataset.laneEdges !== edges) host.dataset.laneEdges = edges;
    host.dataset.playerX = scratch.probe.set(heroX, HERO.h, heroZ).project(camera).x.toFixed(3);
  });

  return (
    <>
      <FieldGround look={look} area={land} y={-0.05} />
      <HorizonBackdrop look={look} seed={world.seed} clear={0} beyond={30} />
      {/* Trať: krémový pás s inkoustovou obrubou a čárou mezi pruhy. */}
      <mesh position={[0, -0.01, (end - LEAD_IN) / 2]} receiveShadow>
        <boxGeometry args={[2 * ROAD_HALF, 0.04, end + LEAD_IN]} />
        <meshStandardMaterial color={color.cream} roughness={0.9} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={side} position={[side * (ROAD_HALF + 0.12), 0.04, (end - LEAD_IN) / 2]} receiveShadow>
          <boxGeometry args={[0.24, 0.12, end + LEAD_IN]} />
          <meshStandardMaterial color={color['ink-soft']} roughness={0.8} />
        </mesh>
      ))}
      <mesh position={[0, 0.012, stopM / 2]}>
        <boxGeometry args={[0.08, 0.01, stopM + LEAD_IN]} />
        <meshStandardMaterial color={color['cream-deep']} />
      </mesh>
      <Instances box={[POST.r * 2, POST.h, POST.r * 2]} capacity={3 * SLOTS} tint={color.ink} holder={posts} />
      <Instances box={[GATE_W, 0.02, PAD_D]} capacity={2 * SLOTS} tint={color['sky-deep']} holder={pads.grow} item="gate" />
      <Instances box={[GATE_W, 0.02, PAD_D]} capacity={2 * SLOTS} tint={color.tomato} holder={pads.shrink} item="gate" />
      {signMaterials.map((material, index) => (
        <mesh
          key={index}
          ref={(mesh) => {
            signs.current[index] = mesh;
          }}
          geometry={signGeometry}
          material={material}
          visible={false}
        />
      ))}
      <Instances model={sawModel} box={[SAW, SAW, 0.3]} capacity={Math.max(1, obstacles.length)} tint={color.tomato} holder={saws} item="obstacle" centred />
      <Instances model={memberModel} box={[MEMBER.w, MEMBER.h, MEMBER.d]} capacity={SHOWN} tint={color['sky-deep']} holder={members} item="crowd" character />
      <group ref={crowdTag}>
        <Html center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={crowdText} className="sp-world-tag sp-world-tag--goal" data-testid="crowd-count">
            {CROWD.start}
          </span>
        </Html>
      </group>
      <group ref={hero} userData={{ frame: 'hero' }}>
        {heroRig !== undefined ? (
          <RiggedModel character={heroRig} h={HERO.h} clip={() => (moving.current ? 'run' : 'idle')} fallback={color['sky-deep']} />
        ) : (
          <FittedModel id={cast.player} w={HERO.w} h={HERO.h} d={HERO.d} fallback={color['sky-deep']} character />
        )}
      </group>
      <group ref={bossGroup} position={[0, 0, boss.z]} userData={{ frame: 'target', item: 'boss' }}>
        {/* Zlobr kouká proti davu. */}
        <group rotation={[0, Math.PI, 0]}>
          <FittedModel id={bossModel} w={boss.w * 0.8} h={boss.h} d={boss.d} fallback={color['mint-deep']} character />
        </group>
        <Html position={[0, boss.h * 0.6, -boss.d / 2]} center pointerEvents="none" zIndexRange={[10, 0]}>
          <span ref={bossText} className="sp-world-tag" data-testid="crowd-boss">
            {bossStart}
          </span>
        </Html>
      </group>
      {/* Hrad za zlobrem: zeď a dvě věže v barvách kitu. */}
      <group position={[0, 0, boss.z + boss.d / 2 + 4]}>
        <mesh position={[0, 1.6, 0]} castShadow receiveShadow>
          <boxGeometry args={[2 * ROAD_HALF + 4, 3.2, 1.2]} />
          <meshStandardMaterial color={color['cream-deep']} roughness={0.85} />
        </mesh>
        {[-1, 1].map((side) => (
          <group key={side} position={[side * (ROAD_HALF + 2.4), 0, 0]}>
            <mesh position={[0, 2.4, 0]} castShadow>
              <boxGeometry args={[1.8, 4.8, 1.8]} />
              <meshStandardMaterial color={color['cream-deep']} roughness={0.85} />
            </mesh>
            <mesh position={[0, 5.5, 0]} castShadow>
              <coneGeometry args={[1.4, 1.6, 4]} />
              <meshStandardMaterial color={color['tomato-deep']} roughness={0.7} />
            </mesh>
          </group>
        ))}
      </group>
      <GhostSlot ghost={ghost} session={session} place={worldPlacement} />
    </>
  );
}
