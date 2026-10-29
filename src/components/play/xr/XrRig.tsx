'use client';

import { useFrame, useThree } from '@react-three/fiber';
import { useXR } from '@react-three/xr';
import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from 'react';
import { ACESFilmicToneMapping, type ArrayCamera, Box3, DynamicDrawUsage, type Group, InstancedMesh, Material, Matrix4, type Mesh, Object3D, type SkinnedMesh, Sphere, Vector3 } from 'three';

import { BODY, HEADER, UNIT, bodyBase } from '@/play/arcade/contract';
import { type Point, deskOfWorld, onDesk } from '@/play/xr/diorama-scale';
import { REACH, type XrControl, type XrMotion } from '@/play/xr/input-map';
import { genreOfWorld, modeOf } from '@/play/xr/modes';
import { cutOf } from '@/play/xr/quality';

import { frameOf } from '../arcade/ArcadeStage';
import type { ArcadeSession } from '../arcade/session';
import { Diorama, type DeskReport, heroNodeOf } from './Diorama';
import { useXrGame, useXrHud } from './xr-context';
import { closeXrLobby, lobbyShown, useXrLobby } from './xr-lobby';
import { MOTION_PRIORITY, XrAim } from './XrAim';
import { XrAudio } from './XrAudio';
import { XrFeed } from './XrFeed';
import { XrHaptics } from './XrHaptics';
import { XrHud } from './XrHud';
import { XrInput, xrControlOf } from './XrInput';
import { XrLobby } from './XrLobby';
import type { PanelAim } from './XrPanel';
import { type RoomReport, XrRoom } from './XrRoom';
import { XrSwing } from './XrSwing';

/**
 * Hráč ve VR (P65 T1). Kameru vlastní hlava: kamery žánrů dál nastavují kameru R3F, jenže tou je v relaci kamera
 * brýlí a její pozici každý snímek přepíše póza hlavy. Svět se otočí o půl kruhu, aby hráč stál tam, kde ve 2D
 * stojí kamera (za hrdinou, na straně −z). Jak se žánr hraje, říká tabulka režimů (`xr/modes.ts`, P67 T6):
 * VR-nativní žánry (T3) svět nezmenší, nebo ho dají do dosahu ruky (`placementOf`); aréna, obrana a chytání stojí
 * kolem hráče (`XrRoom`); ostatní se hrají jako diorama na desce před hráčem (T4, `Diorama`). Zvuk události zní
 * z místa těla přes matici obalu (`XrAudio`) a ovladače vibrují podle tabulky událostí (`XrHaptics`, P67 T8).
 * Mimo relaci je obal identita, takže 2D se nemění a vstup do VR scénu nepřestaví.
 * `DIORAMA` je jen poloha, než relace dostane hru (pak měřítko spočte `Diorama` z velikosti hřiště).
 */
export const DIORAMA = { scale: 1 / 15, at: [0, 0.8, -0.9], turn: Math.PI } as const;

const ORIGIN = [0, 0, 0] as const;

/**
 * Ve VR se scéna kreslí naposled sama, po skládači postprocessingu (`look/rig/Post.tsx`, soubor P62): skládač
 * kreslí přes celoobrazovkový trojúhelník, takže do obou očí dá tentýž obraz, a stereo se rozpadne. Vyšší priorita
 * než skládač (1) = kreslí se po něm, `autoClear` jeho výsledek smaže. Tónuje se jako bez skládače (`StyleRig`).
 * simplified: skládač dál kreslí naprázdno a stojí GPU; vypnout ho ve VR jde jen v `Post.tsx` (nález v `docs/vr/README.md`).
 */
const XR_RENDER_PRIORITY = 100;

function DirectRender({ calls }: { readonly calls: RefObject<number> }) {
  useFrame(({ gl, scene, camera }) => {
    const before = { autoClear: gl.autoClear, toneMapping: gl.toneMapping };
    gl.autoClear = true;
    gl.toneMapping = ACESFilmicToneMapping;
    gl.render(scene, camera);
    calls.current = gl.info.render.calls;
    gl.autoClear = before.autoClear;
    gl.toneMapping = before.toneMapping;
  }, XR_RENDER_PRIORITY);
  return null;
}

/** Vrstva, kterou kamera nevidí: sem jdou uzly, které profil Questu 2 nekreslí (`XrCull`). */
const CULLED_LAYER = 31;
/** Jak často (snímky) se znovu skládají skupiny stejných sítí ke sloučení – jako řez dioramy (`Diorama`, `SWEEP_EVERY`). */
const CULL_SWEEP = 10;
/** Rezerva poloměru (m): matice sítí jsou ze snímku předtím, trať se mezitím posune (~2 cm na 1:12). */
const DESK_MARGIN = 0.05;
/** Od kolika stejných sítí (geometrie i materiál) je kreslí jedna instancovaná síť. */
const BATCH_FROM = 4;
/** Materiály three bez vlastního shaderu: instancování jim přidá jen matici instance. */
const PLAIN_MATERIALS: ReadonlySet<string> = new Set(['MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial', 'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshToonMaterial']);

const isShown = (node: Object3D, root: Object3D): boolean => {
  for (let at: Object3D | null = node; at !== null && at !== root; at = at.parent) if (!at.visible) return false;
  return true;
};

/**
 * Smí síť kreslit jedna instancovaná síť se stejnými? Jen neprůhledný materiál three bez úprav shaderu a bez vlastní
 * práce před kreslením – průhlednost se třídí po sítích a úprava shaderu nemusí s maticí instance počítat.
 */
function batchable(mesh: Mesh): boolean {
  const { material } = mesh;
  return (
    !Array.isArray(material) &&
    PLAIN_MATERIALS.has(material.type) &&
    !material.transparent &&
    material.onBeforeCompile === Material.prototype.onBeforeCompile &&
    mesh.onBeforeRender === Object3D.prototype.onBeforeRender &&
    Object.keys(mesh.geometry.morphAttributes).length === 0
  );
}

/** Stejné sítě kreslené jednou instancovanou (`instanced`), `drawn` = které v tomto snímku. */
interface Batch {
  readonly instanced: InstancedMesh;
  members: readonly Mesh[];
  drawn: Mesh[];
  frame: number;
}

/**
 * Srážení profilu Questu 2 (P65 T6): co scéna má, ale VR nekreslí, a co kreslí levněji.
 *
 * - **Podle značek** (`cutOf`): vegetace, obrysy nepřátel, prstenec arény.
 * - **Mimo desku** (diorama): síť, jejíž obalová koule leží celá mimo prostor nad deskou, by roviny řezu stejně
 *   ořízly – trať běžce i závodu je delší než stůl a kulisy podél ní stály většinu volání.
 * - **Sloučení:** aspoň `BATCH_FROM` sítí se stejnou geometrií a materiálem (díly postav nepřátel, řady kulis)
 *   kreslí jedna instancovaná síť. Matice dílů se do ní přepíšou až při kreslení, kdy jsou z tohoto snímku.
 *
 * Skrývá se vrstvou, ne `visible`: to přepínají scény samy (okno kulis v `StyleRig`, mrtvá těla) a přepsaly by to.
 * Instancované a riggované sítě zůstávají, jak jsou: jejich koule nekryje instance ani pózu.
 */
function XrCull({ world, desk, diorama }: { readonly world: RefObject<Group | null>; readonly desk: RefObject<DeskReport | null>; readonly diorama: boolean }) {
  const root = useRef<Group>(null);
  // Skrytý uzel → jeho původní maska vrstev.
  const hidden = useMemo(() => new Map<Object3D, number>(), []);
  const batches = useMemo(() => new Map<string, Batch>(), []);
  const at = useMemo(() => ({ frames: 0, placed: [] as Mesh[], sphere: new Sphere(), inverse: new Matrix4(), matrix: new Matrix4() }), []);
  useEffect(
    () => () => {
      for (const [node, mask] of hidden) node.layers.mask = mask;
      hidden.clear();
      for (const batch of batches.values()) {
        batch.instanced.removeFromParent();
        batch.instanced.dispose();
      }
      batches.clear();
    },
    [hidden, batches],
  );

  /** Instancovaná síť pro skupinu; geometrie a materiál jsou scény, ta je i uvolní. */
  const batchOf = (key: string, members: readonly Mesh[]): Batch => {
    const kept = batches.get(key);
    if (kept !== undefined && kept.instanced.instanceMatrix.count >= members.length) {
      kept.members = members;
      return kept;
    }
    kept?.instanced.removeFromParent();
    kept?.instanced.dispose();
    const { geometry, material } = members[0]!;
    const instanced = new InstancedMesh(geometry, material, members.length * 2);
    instanced.instanceMatrix.setUsage(DynamicDrawUsage);
    instanced.frustumCulled = false;
    instanced.matrixAutoUpdate = false;
    instanced.count = 0;
    const batch: Batch = { instanced, members, drawn: [], frame: -1 };
    // Obě oči kreslí v jednom `render`: matice jednou za snímek, až po přepočtu světových matic scény.
    instanced.onBeforeRender = (renderer) => {
      if (batch.frame === renderer.info.render.frame) return;
      batch.frame = renderer.info.render.frame;
      at.inverse.copy(instanced.matrixWorld).invert();
      batch.drawn.forEach((member, index) => instanced.setMatrixAt(index, at.matrix.multiplyMatrices(at.inverse, member.matrixWorld)));
      instanced.count = batch.drawn.length;
      instanced.instanceMatrix.needsUpdate = true;
    };
    root.current?.add(instanced);
    batches.set(key, batch);
    return batch;
  };

  useFrame(() => {
    const group = world.current;
    if (group === null) return;
    const hide = (node: Object3D) => {
      if (hidden.has(node)) return;
      hidden.set(node, node.layers.mask);
      node.layers.set(CULLED_LAYER);
    };
    const show = (node: Object3D) => {
      const mask = hidden.get(node);
      if (mask === undefined) return;
      node.layers.mask = mask;
      hidden.delete(node);
    };
    const pose = diorama ? desk.current : null;
    const inside = (mesh: Mesh): boolean => {
      if (pose === null) return true;
      const { geometry } = mesh;
      if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
      const sphere = at.sphere.copy(geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld);
      return onDesk(deskOfWorld(pose, sphere.center), sphere.radius + DESK_MARGIN);
    };

    // Svět se prochází každý snímek: scéna sítě i staví znovu (prstenec arény po změně volných míst) a nová síť
    // by do dalšího průchodu stála celé volání. Skupiny sloučení se skládají jen občas, nové díly do té doby
    // kreslí každý sám.
    // simplified: průchod je O(uzlů) za snímek (aréna ~400, běžec ~850); nad několika tisíci uzlů sledovat přidané.
    at.frames += 1;
    const regroup = at.frames % CULL_SWEEP === 1;
    const seen = new Set<Object3D>();
    const batched = new Set<Mesh>();
    if (!regroup) for (const batch of batches.values()) for (const member of batch.members) batched.add(member);
    const alike = new Map<string, Mesh[]>();
    at.placed = [];
    const walk = (node: Object3D, cut: boolean) => {
      const off = cut || cutOf(node) !== null;
      const mesh = node as Mesh;
      if (off) {
        hide(node);
        seen.add(node);
      } else if (batched.has(mesh)) {
        seen.add(mesh);
      } else if (mesh.isMesh === true && (node as InstancedMesh).isInstancedMesh !== true && (node as SkinnedMesh).isSkinnedMesh !== true) {
        if (regroup && batchable(mesh)) {
          const key = `${mesh.geometry.uuid}|${(mesh.material as Material).uuid}`;
          alike.set(key, [...(alike.get(key) ?? []), mesh]);
        } else if (diorama) {
          at.placed.push(mesh);
          seen.add(mesh);
        }
      }
      for (const child of node.children) walk(child, off);
    };
    walk(group, false);
    if (regroup) {
      for (const [key, members] of alike) {
        if (members.length >= BATCH_FROM) batchOf(key, members);
        else if (diorama) at.placed.push(...members);
        if (diorama || members.length >= BATCH_FROM) for (const member of members) seen.add(member);
      }
      for (const [key, batch] of batches) {
        if ((alike.get(key)?.length ?? 0) >= BATCH_FROM) continue;
        batch.instanced.removeFromParent();
        batch.instanced.dispose();
        batches.delete(key);
      }
    }
    // Uzel, který ze scény zmizel nebo přestal splňovat pravidlo, se vrátí.
    for (const node of [...hidden.keys()]) if (!seen.has(node)) show(node);

    for (const mesh of at.placed) {
      if (inside(mesh)) show(mesh);
      else hide(mesh);
    }
    for (const batch of batches.values()) {
      batch.drawn = [];
      for (const member of batch.members) {
        hide(member);
        if (member.parent !== null && isShown(member, group) && inside(member)) batch.drawn.push(member);
      }
    }
  }, XR_RENDER_PRIORITY - 1);
  return <group ref={root} />;
}

/** Co e2e o VR čte (`e2e/vr-enter.spec.ts`). */
export interface XrReport {
  readonly presenting: boolean;
  /** Pohledy kamery brýlí – v relaci dvě oči. */
  readonly eyes: number;
  /** Draw cally posledního snímku ve VR. */
  readonly calls: number;
  /** Kolik snímků plátno dosud nakreslilo (`info.render.frame`) – měření přechodu feedu (P67 T4). */
  readonly frames: number;
  /** Osa míření z paprsku a osa pruhu pod rukou v posledním snímku (T3, `vr-native.spec.ts`); `null` = žádná. */
  readonly aim: number | null;
  readonly laneAxis: number | null;
  /** Pravá ruka v ose x jádra (jednotky) u chytání (P67 T6, `vr-room.spec.ts`); `null` = žádná. */
  readonly handX: number | null;
  /** Hráčovo tělo ve stavu hry (jednotky jádra) – „hrdina se pohnul“ (T4, `vr-diorama.spec.ts`); `null` = bez hry. */
  readonly heroAt: Point | null;
  /** Kreslený hrdina ve skutečném prostoru (m, `local-floor`); `null` = mimo relaci nebo bez hrdiny. */
  readonly heroWorld: Point | null;
  /** Svět kolem hráče (P67 T6): měřítko, bod scény pod hráčem, póza; `null` = jiný režim nebo mimo relaci. */
  readonly room: RoomReport | null;
  /** Sada prostředí, v jejíchž barvách je podlaha okolí (`XrSky`); `null` = okolí se nekreslí. */
  readonly sky: string | null;
  /** Střed kresleného hrdiny promítnutý kamerou každého oka (NDC −1…1, +y nahoru); `behind` = za okem. */
  readonly heroView: readonly ({ readonly x: number; readonly y: number; readonly behind: boolean } | null)[] | null;
  /** Kreslený hrdina v osách desky dioramy (m: x doprava, y nad deskou, z k hráči); `null` = bez dioramy. */
  readonly heroOnDesk: Point | null;
  /** Deska dioramy (poloha, otočení, měřítko světa); `null` = VR-nativní žánr nebo mimo relaci. */
  readonly desk: DeskReport | null;
  /** 3D panely HUD v relaci (T5, `vr-hud.spec.ts`). */
  readonly panels: readonly PanelReport[];
}

/** Panel HUD, jak ho vidí hráč: co na něm stojí, kde jsou tlačítka a kam padne do obrazu každého oka. */
export interface PanelReport {
  /** `hud`, `result`, `notice`, VR lobby `lobby` a jeho `keyboard` (P67 T2). */
  readonly id: string;
  /** Řádky textu a počítadla („0/3 keys“). */
  readonly text: readonly string[];
  /** Popisky počítadel jako v DOM HUD (`hud-counter-…`). */
  readonly labels: readonly string[];
  /** Tlačítka, jejich středy ve skutečném prostoru (m) – kam e2e namíří paprsek – a stav (`aimed` = paprsek na něm). */
  readonly buttons: readonly { readonly id: string; readonly label: string; readonly at: Point; readonly state: 'rest' | 'aimed' | 'pressed' }[];
  /** Obdélník panelu v obraze každého oka (NDC −1…1); `behind` = některý roh je za okem. */
  readonly eyes: readonly ({ readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number; readonly behind: boolean } | null)[];
  /** Nejmenší text panelu jako úhel od očí (rad): text kitu 13 px na 1 m = 0,026. */
  readonly smallest: number;
}

/** Panely HUD ve scéně (`userData.xrPanel` z `XrPanel`) promítnuté do očí. */
function panelsOf(scene: Object3D, xr: ArrayCamera): PanelReport[] {
  const panels: PanelReport[] = [];
  // Mezi očima z matic posledního snímku; `getWorldPosition` by kameru XR přeskládal.
  const head = new Vector3();
  for (const eye of xr.cameras) head.add(new Vector3().setFromMatrixPosition(eye.matrixWorld).divideScalar(xr.cameras.length));
  scene.traverse((node) => {
    const id = node.userData.xrPanel as string | undefined;
    if (id === undefined) return;
    const buttons: PanelReport['buttons'][number][] = [];
    node.traverse((child) => {
      if (child.userData.xrButton === undefined) return;
      const at = child.getWorldPosition(new Vector3());
      buttons.push({ id: child.userData.xrButton as string, label: child.userData.label as string, at: { x: at.x, y: at.y, z: at.z }, state: child.userData.state as PanelReport['buttons'][number]['state'] });
    });
    const center = new Box3().setFromObject(node).getCenter(new Vector3());
    panels.push({
      id,
      text: node.userData.text as string[],
      labels: node.userData.labels as string[],
      buttons,
      eyes: xr.cameras.map((eye) => {
        const box = frameOf(node, eye, 1, 1);
        return box === null ? null : { minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY, behind: box.behind };
      }),
      smallest: ((node.userData.minText as number) * node.getWorldScale(new Vector3()).x) / head.distanceTo(center),
    });
  });
  return panels;
}

declare global {
  interface Window {
    __playXr?: () => XrReport;
  }
}

function XrProbe({
  presenting,
  calls,
  motion,
  game,
  desk,
  room,
}: {
  readonly presenting: boolean;
  readonly calls: RefObject<number>;
  readonly motion: RefObject<XrMotion>;
  readonly game: ArcadeSession | null;
  readonly desk: RefObject<DeskReport | null>;
  readonly room: RefObject<RoomReport | null>;
}) {
  const get = useThree((three) => three.get);
  useEffect(() => {
    const probe = (): XrReport => {
      const { gl, scene } = get();
      const state = game?.state() ?? null;
      const body = state === null ? null : bodyBase(state[HEADER.player] as number);
      const heroAt = state === null || body === null ? null : { x: state[body + BODY.x] as number, y: state[body + BODY.y] as number, z: state[body + BODY.z] as number };
      const hero = presenting ? heroNodeOf(scene) : null;
      if (presenting) scene.updateMatrixWorld();
      const at = hero?.getWorldPosition(new Vector3()) ?? null;
      let sky: string | null = null;
      if (presenting) scene.traverse((node) => (sky = (node.userData.xrSky as string | undefined) ?? sky));
      return {
        presenting,
        eyes: presenting ? gl.xr.getCamera().cameras.length : 0,
        calls: presenting ? calls.current : 0,
        frames: gl.info.render.frame,
        aim: presenting ? motion.current.aim : null,
        laneAxis: presenting ? motion.current.laneAxis : null,
        handX: presenting ? (motion.current.handX ?? null) : null,
        heroAt,
        heroWorld: at === null ? null : { x: at.x, y: at.y, z: at.z },
        room: presenting ? room.current : null,
        sky,
        heroView:
          hero === null
            ? null
            : gl.xr.getCamera().cameras.map((eye) => {
                const box = frameOf(hero, eye, 1, 1);
                return box === null ? null : { x: box.x, y: box.y, behind: box.behind };
              }),
        heroOnDesk: at === null || desk.current === null ? null : deskOfWorld(desk.current, at),
        desk: presenting ? desk.current : null,
        panels: presenting ? panelsOf(scene, gl.xr.getCamera()) : [],
      };
    };
    window.__playXr = probe;
    return () => {
      if (window.__playXr === probe) delete window.__playXr;
    };
  }, [get, presenting, calls, motion, game, desk, room]);
  return null;
}

/**
 * VR-nativní žánry (T3) stojí 1:1 na zemi: střílečka na místě kamery žánru (`ShooterRig`: 5,5 m za hrdinou,
 * bez její výšky 3,6 m – hlavu má hráč ve své výšce), hod 3 m za hrdinou čelem k hřišti (kamera hodu je boční
 * a švih dopředu by letěl doprava). Krájení a bouchání mají pruhy v dosahu ruky (`REACH`).
 */
const STAND_BACK = { 'shooter-rig': 5.5, 'throw-rig': 3 } as const;

interface Placement {
  readonly scale: number;
  readonly at: readonly [number, number, number];
}

function placementOf(control: XrControl | null, state: Int32Array): Placement {
  if (control?.swing !== undefined) return REACH;
  if (control?.input === 'shooter-rig' || control?.input === 'throw-rig') {
    const hero = bodyBase(state[HEADER.player] as number);
    // Obal otočený o půl kruhu postaví bod scény (x, 0, z) k nohám hráče, když sám stojí v (x, 0, z).
    // simplified: hrdina střílečky úkrokem posune svět po ticích bez vyhlazení; kdyby to v T8 cukalo, interpolovat.
    return { scale: 1, at: [-(state[hero + BODY.x] as number) / UNIT, 0, (state[hero + BODY.z] as number) / UNIT - STAND_BACK[control.input]] };
  }
  return DIORAMA;
}

/** Postaví svět VR-nativního žánru kolem hráče každý snímek (hrdina střílečky se hýbe); mimo relaci vrátí obal na identitu. */
function XrPlace({ world, session, control }: { readonly world: RefObject<Group | null>; readonly session: ArcadeSession | null; readonly control: XrControl | null }) {
  useFrame(() => {
    const group = world.current;
    if (group === null) return;
    const { scale, at } = session === null ? DIORAMA : placementOf(control, session.state());
    group.position.set(...at);
    group.rotation.set(0, DIORAMA.turn, 0);
    group.scale.setScalar(scale);
  }, MOTION_PRIORITY - 1);
  useEffect(
    () => () => {
      world.current?.position.set(...ORIGIN);
      world.current?.rotation.set(0, 0, 0);
      world.current?.scale.setScalar(1);
    },
    [world],
  );
  return null;
}

export function XrRig({ children }: { readonly children: ReactNode }) {
  const presenting = useXR((xr) => xr.session != null);
  const game = useXrGame();
  // Hra na obrazovce: po konci běhu ji `XrGame` neohlašuje (vstup stojí), ale stůl i výsledek (T5) na ní zůstávají.
  const hud = useXrHud();
  const shown = game ?? hud?.session ?? null;
  const control = useMemo(() => (shown === null ? null : xrControlOf(shown.world)), [shown]);
  // Režim podle žánru (P67 T6); `surround` (T7) se zatím hraje na stole.
  const entry = useMemo(() => (shown === null ? null : modeOf(genreOfWorld(shown.world))), [shown]);
  const world = useRef<Group>(null);
  const motion = useRef<XrMotion>({ aim: null, velocity: null, laneAxis: null, handX: null });
  const calls = useRef(0);
  const desk = useRef<DeskReport | null>(null);
  const roomReport = useRef<RoomReport | null>(null);
  const aim = useMemo<PanelAim>(() => new Map(), []);
  // Chytání drží pruh rukou; paprsek by spouští ťukal do jiného pruhu, než nad kterým ruka je.
  const aims = (control?.input === 'shooter-rig' || control?.input === 'lanes') && control.handLane !== true;
  const swings = control?.input === 'throw-rig' || control?.swing !== undefined;
  const room = entry?.mode === 'room';
  const diorama = shown !== null && entry?.mode !== 'native' && !room;
  // VR lobby (P67 T2): nad hrou na obrazovce místo jejího HUD; ovladače do hry nejdou, dokud je otevřené.
  const lobbyState = useXrLobby();
  const lobby = presenting && lobbyShown(lobbyState, shown);
  const playing = presenting && !lobby;
  useEffect(() => {
    if (lobbyState?.made === true && !lobbyShown(lobbyState, shown)) closeXrLobby();
  }, [lobbyState, shown]);
  return (
    <>
      <group ref={world}>{children}</group>
      {presenting && diorama && <Diorama world={world} session={shown} report={desk} />}
      {presenting && room && shown !== null && <XrRoom world={world} session={shown} pose={entry.pose} hand={control?.handLane === true} motion={motion} report={roomReport} />}
      {presenting && !diorama && !room && <XrPlace world={world} session={shown} control={control} />}
      {presenting && <DirectRender calls={calls} />}
      {presenting && shown !== null && <XrCull key={diorama ? 'desk' : 'free'} world={world} desk={desk} diorama={diorama} />}
      {playing && game !== null && control !== null && aims && <XrAim session={game} control={control} world={world} motion={motion} />}
      {playing && game !== null && swings && <XrSwing world={world} motion={motion} />}
      {playing && game !== null && <XrInput session={game} motion={motion} aim={aim} />}
      {playing && game !== null && <XrHaptics session={game} />}
      {presenting && shown !== null && <XrAudio world={world} session={shown} />}
      {presenting && shown !== null && !lobby && <XrHud diorama={diorama} desk={desk} aim={aim} />}
      {lobby && <XrLobby shown={shown} aim={aim} />}
      {playing && <XrFeed shown={shown} aim={aim} />}
      <XrProbe presenting={presenting} calls={calls} motion={motion} game={game} desk={desk} room={roomReport} />
    </>
  );
}
