'use client';

/**
 * Sdílený svět tratí (P32-0 T5, přesunuto beze změny z `ArcadeStage.tsx`):
 * smyčka `useFrame` posouvá hodiny relace (pevný krok v `session.ts`) a kreslí
 * těla interpolovaná mezi posledními dvěma tiky. Běžec a závod (`steer/`) mají
 * kameru za a nad hráčem, plošinovka a poletování boční kameru (trať jde zleva
 * doprava), střelnice a hřiště hodu vlastní rig s kamerou a vstupem
 * (`shooter/`, `throw/`, P25G).
 *
 * Běžec a plošinovka ho berou přes vlastní obal (`runner/RunnerWorld.tsx`,
 * `platform/PlatformWorld.tsx`); poletování, střelnice, hod a závod ho kreslí
 * přímo.
 *
 * Modely: `/assets/worldstream/game/<id>-lod1.glb` podle id těla (`hurdle`,
 * `coin`, …); když katalog id nemá (404), kreslí se barevný kvádr. Tělesa,
 * pro která model v katalogu není (plošiny, hroty, trubky, ptáček), se
 * kreslí rovnou primitivem a nestahují se.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box3, type Group, type Object3D, type PerspectiveCamera, Vector3 } from 'three';

import { BODY, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { type PropRole, fitScale, riggedCharacter } from '@/play/arcade/models';
import { type ClipState, type Pose, clipOf, posesOf, viewOf } from '@/play/arcade/motion';
import { FLAP } from '@/play/arcade/pieces/flap';
import { PLATFORM } from '@/play/arcade/pieces/platform';
import { RUNNER } from '@/play/arcade/pieces/runner';
import { type SteerCourse, centerAt } from '@/play/arcade/pieces/steer';

import { type BodyView, bodiesOf, bodiesStale } from './bodies';
import { UNDER_PANORAMA } from './look/under-panorama';
import { applyIntro, introLeft, useIntroClock } from './look/intro';
import { loadBodyModel } from './look/load';
import { Scenery } from './look/Scenery';
import { RiggedModel } from './RiggedModel';
import type { ArcadeSession } from './session';
import { SHOT_PRIMITIVES, ShotPrimitive } from './shooter/primitives';
import { ShooterRig } from './shooter/ShooterRig';
import { SteerBackdrop, placeChase } from './steer/SteerScene';
import { ThrowRig } from './throw/ThrowRig';

/** Barva náhradního kvádru podle id těla; nic fialového. */
const FALLBACK_COLOR: Readonly<Record<string, string>> = {
  player: '#2563eb',
  hurdle: '#f59e0b',
  'slide-bar': '#ea580c',
  cone: '#f97316',
  crate: '#a16207',
  coin: '#facc15',
  finish: '#14b8a6',
  checkpoint: '#0ea5e9',
  turbo: '#22d3ee',
  enemy: '#dc2626',
  chaser: '#b91c1c',
};

/** Jména rolí podle čísla – scéna je zapíše do `data-drawn`, ať e2e vidí, co kreslí. */
const ROLE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(ROLE).map(([name, code]) => [code, name]));

/** Id modelu, který katalog nemá – kreslí se primitivem (objednávka modelů pro P25F je ve Findings plánu). */
const PRIMITIVE = new Set(['platform', 'platform-moving', 'spikes', 'pipe', 'ceiling', 'bird', ...SHOT_PRIMITIVES]);

/** Modely z popisků rolí (`@/play/arcade/models`): hrdina, nepřítel střelnice a rekvizity. */
export interface Cast {
  readonly player: string;
  readonly enemy: string;
  /** Pronásledovatel doplňku `+chaser`. */
  readonly chaser: string;
  readonly props: Partial<Record<PropRole, string>>;
}

/** Překážky běžce, které smí nést model z popisku; skluzová laťka tvarem říká „podlez“, tu ne. */
const SWAPPABLE_OBSTACLES: ReadonlySet<string> = new Set(['hurdle', 'cone', 'crate']);

/** Id těla → id modelu v katalogu. Hráč, nepřítel, mince, překážka a terč berou model z popisku role, když ho katalog má. */
function modelIdOf(view: BodyView, cast: Cast): string {
  if (view.role === ROLE.player) return cast.player;
  if (view.kind === 'finish') return 'finish-flag';
  if (view.kind === 'enemy') return cast.enemy;
  // Soupeř závodu (P27A T4): vozidlo z popisku role `rival`, jinak auto soupeře.
  if (view.kind === 'rival-car') return cast.props.rival ?? view.kind;
  if (view.role === ROLE.chaser) return cast.chaser;
  if (view.role === ROLE.collectible && view.kind === 'coin') return cast.props.coin ?? view.kind;
  if (view.role === ROLE.obstacle && SWAPPABLE_OBSTACLES.has(view.kind)) return cast.props.obstacle ?? view.kind;
  // P30B T4: mantinel závodu z popisku role `barrier` („crocodiles“ podél řeky).
  if (view.role === ROLE.obstacle && view.kind === 'tire-barrier') return cast.props.barrier ?? view.kind;
  // P28D T3: kostky věže hodu jsou terč – „cardboard boxes“ postaví věž z krabic.
  if (view.role === ROLE.target && (view.kind === 'target' || view.kind === 'wood-block')) return cast.props.target ?? view.kind;
  return view.kind;
}

/**
 * Model vepsaný do kvádru těla (metry), postavený na zem, střed v ose; postava výškou těla (`fitScale`).
 * `fill` kvádr vyplní v každé ose zvlášť – díl věže, kterému jádro mění šířku (P30B T4).
 * Model je slitý do jedné sítě (`loadBodyModel`) a jeho matice jsou zmrazené: hýbe se
 * jen skupina těla a póza nad ním, přepočet vnitřku modelu každý snímek by byl zbytečný.
 */
export function FittedModel({ id, w, h, d, fallback, character = false, fill = false }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly fallback: string; readonly character?: boolean; readonly fill?: boolean }) {
  const [model, setModel] = useState<Object3D | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadBodyModel(id).then((loaded) => {
      if (live) setModel(loaded);
    });
    return () => {
      live = false;
    };
  }, [id]);
  const fitted = useMemo(() => {
    if (model === null || model === undefined) return null;
    const copy = model.clone(true);
    const box = new Box3().setFromObject(copy);
    const size = box.getSize(new Vector3());
    const along = (length: number): number => Math.max(length, 1e-3);
    const uniform = fitScale(size, { x: w, y: h, z: d }, character);
    const scale = fill ? new Vector3(w / along(size.x), h / along(size.y), d / along(size.z)) : new Vector3(uniform, uniform, uniform);
    copy.scale.copy(scale);
    const center = box.getCenter(new Vector3());
    copy.position.set(-center.x * scale.x, -box.min.y * scale.y, -center.z * scale.z);
    copy.traverse((node) => {
      node.updateMatrix();
      node.matrixAutoUpdate = false;
    });
    return copy;
  }, [model, w, h, d, character, fill]);
  if (fitted !== null) return <primitive object={fitted} />;
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={fallback} roughness={0.6} />
    </mesh>
  );
}

/**
 * Tělesa bez modelu: plošina (hlína + tráva, nebo hmota sady), řada hrotů,
 * trubka, strop, ptáček. Pohyblivá plošina si barvu nechává: hráč z ní čte pohyb.
 */
function Primitive({ id, w, h, d, block }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly block?: Look['block'] }) {
  if (SHOT_PRIMITIVES.has(id)) return <ShotPrimitive id={id} w={w} h={h} d={d} block={block?.[1]} />;
  if (id === 'platform' || id === 'platform-moving') {
    const top = Math.min(0.25, h / 3);
    const [side, surface] = id === 'platform' ? (block ?? ['#92400e', '#16a34a']) : ['#475569', '#f59e0b'];
    return (
      <>
        <mesh position={[0, (h - top) / 2, 0]}>
          <boxGeometry args={[w, h - top, d]} />
          <meshStandardMaterial color={side} roughness={0.9} />
        </mesh>
        <mesh position={[0, h - top / 2, 0]}>
          <boxGeometry args={[w, top, d]} />
          <meshStandardMaterial color={surface} roughness={0.8} />
        </mesh>
      </>
    );
  }
  if (id === 'spikes') {
    const count = Math.max(1, Math.round(d / 0.45));
    const radius = d / count / 2;
    return (
      <>
        {Array.from({ length: count }, (_, i) => (
          <mesh key={i} position={[0, h / 2, -d / 2 + radius * (2 * i + 1)]}>
            <coneGeometry args={[radius, h, 8]} />
            <meshStandardMaterial color="#dc2626" roughness={0.4} metalness={0.3} />
          </mesh>
        ))}
      </>
    );
  }
  if (id === 'bird') {
    const r = Math.min(w, h, d) / 2;
    return (
      <>
        <mesh position={[0, r, 0]}>
          <sphereGeometry args={[r, 16, 12]} />
          <meshStandardMaterial color="#facc15" roughness={0.5} />
        </mesh>
        <mesh position={[0, r, r * 1.1]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[r * 0.35, r * 0.7, 8]} />
          <meshStandardMaterial color="#ea580c" />
        </mesh>
        <mesh position={[-r * 0.8, r * 1.3, r * 0.45]}>
          <sphereGeometry args={[r * 0.18, 8, 6]} />
          <meshBasicMaterial color="#0f172a" />
        </mesh>
      </>
    );
  }
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={id === 'pipe' ? '#16a34a' : '#334155'} roughness={0.6} />
    </mesh>
  );
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/**
 * Boční kamera: stojí na −x a kouká po +x, takže +z jádra jde na obrazovce
 * doprava. Vzdálenost se řídí poměrem stran – na výšku (mobil) ustoupí,
 * aby bylo vidět aspoň `ahead` metrů trati. `lead` = o kolik poloviny šířky
 * obrazu je hráč vlevo od středu (0,4 → levá třetina).
 */
function placeSide(camera: PerspectiveCamera, look: Vector3, z: number, y: number, ahead: number, tall: number, far: number, lead: number): void {
  const tan = Math.tan((camera.fov * Math.PI) / 360);
  const dist = clamp(Math.max(ahead / (2 * tan * camera.aspect), tall / (2 * tan)), 10, far);
  const shift = dist * tan * camera.aspect * lead;
  camera.position.set(-dist, y, z + shift);
  look.set(0, y, z + shift);
  camera.lookAt(look);
}

/**
 * Boční kamera na výšku (P30B T5): kolmý záběr je úzký – hrdina přes 4 % výšky
 * a zároveň ~11 m trati před ním se do něj nevejdou. Kamera se proto natočí
 * o `yaw` po trati: hrdina je jí blíž (větší), trať před ním se zkrátí
 * perspektivou. `dist` = vzdálenost k bodu pohledu, `lead` = o kolik metrů
 * před hrdinou kamera míří.
 */
function placeAngled(camera: PerspectiveCamera, look: Vector3, z: number, y: number, dist: number, yaw: number, lead: number): void {
  look.set(0, y, z + lead);
  camera.position.set(-dist * Math.cos(yaw), y, z + lead - dist * Math.sin(yaw));
  camera.lookAt(look);
}

const DEG = Math.PI / 180;

/**
 * Rezerva k vzdálené rovině, kterou `FarAtFog` (`look/rig/StyleRig.tsx`) staví na konec mlhy:
 * kamera se dorovná až po tělech a největší tělo je kolem 10 m.
 */
const FAR_MARGIN_M = 12;

/** Role, které sonda záběru bere jako cíl nebo hrozbu; mantinely závodu jsou kulisa, ne cíl. */
const FRAME_TARGET_ROLES: ReadonlySet<number> = new Set([ROLE.obstacle, ROLE.collectible, ROLE.chaser, ROLE.hazard, ROLE.enemy, ROLE.target]);
const frameTagOf = (view: BodyView): 'hero' | 'target' | undefined =>
  view.role === ROLE.player ? 'hero' : FRAME_TARGET_ROLES.has(view.role) && view.kind !== 'tire-barrier' ? 'target' : undefined;

/**
 * Role věty, jejíž popisek tělo kreslí (P30B T5) – totéž rozhodnutí jako `modelIdOf`
 * a `arcadeScene` v `fidelity/chain.ts`. Nota, díl věže a soupeř souboje mají vlastní scény.
 */
function itemTagOf(view: BodyView): 'enemy' | 'chaser' | PropRole | undefined {
  if (view.role === ROLE.player) return undefined;
  if (view.kind === 'enemy') return 'enemy';
  if (view.kind === 'rival-car') return 'rival';
  if (view.role === ROLE.chaser) return 'chaser';
  if (view.role === ROLE.collectible && view.kind === 'coin') return 'coin';
  if (view.role === ROLE.obstacle && SWAPPABLE_OBSTACLES.has(view.kind)) return 'obstacle';
  if (view.role === ROLE.obstacle && view.kind === 'tire-barrier') return 'barrier';
  if (view.role === ROLE.target && (view.kind === 'target' || view.kind === 'wood-block')) return 'target';
  return undefined;
}

export interface WorldProps {
  readonly session: ArcadeSession;
  readonly control: string;
  readonly cast: Cast;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly scene: Look;
  readonly enabled: boolean;
  /** Podklad místo výchozího (`Backdrop`): údolí běžce kreslí `RunnerWorld` (P32A T3). */
  readonly backdrop?: React.ReactNode;
}

const PICKUP_MS = 200;

/** Role, jejichž model se hýbe podle stavu těla (P26B); plošiny, auta a překážky jedou bez pózy. */
const POSED_ROLES: ReadonlySet<number> = new Set([ROLE.player, ROLE.enemy, ROLE.chaser]);

/** Póza na vnitřní skupinu modelu: poskok, předklon, zmáčknutí (objem drží), bliknutí po zásahu. */
function applyPose(group: Group, pose: Pose): void {
  group.position.y = pose.bob;
  group.rotation.x = pose.lean;
  const wide = 1 + pose.squash / 2;
  group.scale.set(wide, 1 - pose.squash, wide);
  group.visible = pose.flash === 0 || Math.floor(pose.flash * 6) % 2 === 0;
}

export function World({ session, control, cast, surface, scene, enabled, backdrop }: WorldProps) {
  // Střely a hody přidává jádro za běhu (`spawn`) – seznam se staví znovu, když se změní.
  const [views, setViews] = useState(() => bodiesOf(session));
  const groups = useRef<(Group | null)[]>([]);
  const posed = useRef<(Group | null)[]>([]);
  const poses = useRef<(Pose | null)[]>([]);
  /** Riggovaná postava po indexu těla (P26B T5) a klip, který jí scéna v tomhle snímku volí. */
  const rigged = useMemo(() => views.map((view) => riggedCharacter(modelIdOf(view, cast))), [views, cast]);
  const clips = useRef<ClipState[]>([]);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const followY = useRef<number | null>(null);
  // Sebrané tělo (bod + zmizení v jednom tiku) → čas sebrání; ještě PICKUP_MS se nafoukne a splaskne (P28C T3).
  const fading = useRef(new Map<number, number>());
  useEffect(
    () =>
      session.onEvents((events) => {
        if (!events.some((event) => event.kind === 'score')) return;
        const now = performance.now();
        for (const event of events) if (event.kind === 'despawn') fading.current.set(event.body, now);
      }),
    [session],
  );
  const introClock = useIntroClock();

  // Role těl, pro která scéna postavila model – doplněk, který jádro hraje a scéna nekreslí, e2e takhle pozná.
  useEffect(() => {
    if (surface.current !== null) surface.current.dataset.drawn = [...new Set(views.filter((view) => view.kind !== 'gate').map((view) => ROLE_NAMES[view.role]))].join(' ');
  }, [views, surface]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (bodiesStale(views, session)) setViews(bodiesOf(session));
    const state = session.state();
    const prev = session.prev();
    // Póza jen čte stav; tik s podílem rozběhnutého kroku, ať poskok neskáče po 1/60 s.
    const tick = (state[HEADER.tick] as number) + alpha;
    posesOf(state, prev, poses.current, tick);
    let shots = 0;
    for (const view of views) {
      const inner = posed.current[view.index];
      const pose = poses.current[view.index];
      if (inner !== null && inner !== undefined && pose !== null && pose !== undefined) applyPose(inner, pose);
      if (rigged[view.index] !== undefined && pose !== null && pose !== undefined) clips.current[view.index] = clipOf(viewOf(state, prev, view.index), pose, tick);
      const group = groups.current[view.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(view.index);
      const z = lerp(prev[base + BODY.z] as number, state[base + BODY.z] as number, alpha) / UNIT;
      // Tělo za koncem mlhy (`FarAtFog`) by kamera stejně ořízla; skryté vypadne i z přepočtu
      // matic, který jinak prochází celou trať každý snímek (P28E-R1). Kamera je ze snímku předtím.
      const inRange = Math.abs(z - camera.position.z) <= camera.far + FAR_MARGIN_M;
      group.visible = inRange && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      group.matrixWorldAutoUpdate = inRange;
      if (!inRange) continue;
      const fade = fading.current.get(view.index);
      if (fade !== undefined) {
        const t = (performance.now() - fade) / PICKUP_MS;
        if (t >= 1 || group.visible) {
          fading.current.delete(view.index);
          group.scale.setScalar(1);
        } else {
          group.visible = true;
          group.scale.setScalar((1 + 0.6 * Math.sin(t * Math.PI)) * (1 - t));
        }
      }
      // Kamera běžce kouká po +z, takže +x jádra by vyšlo na obrazovce vlevo a „LEFT“ (x − 1) by hráče poslal doprava.
      group.position.set(
        -lerp(prev[base + BODY.x] as number, state[base + BODY.x] as number, alpha) / UNIT,
        lerp(prev[base + BODY.y] as number, state[base + BODY.y] as number, alpha) / UNIT,
        z,
      );
      // Skluz snižuje tělo – model se přikrčí stejně.
      if (view.role === ROLE.player) group.scale.y = (state[base + BODY.h] as number) / UNIT / view.h;
      if (view.role === ROLE.collectible) group.rotation.y += delta * 3;
      if (view.role === ROLE.projectile && group.visible) shots += 1;
    }
    // Střely, které scéna opravdu kreslí (P28B T2) – e2e tak pozná střelu, kterou stav má a scéna ne.
    if (surface.current !== null && surface.current.dataset.shotsDrawn !== String(shots)) surface.current.dataset.shotsDrawn = String(shots);
    const player = groups.current[state[HEADER.player] as number];
    if (player !== null && player !== undefined) {
      const { x, y, z } = player.position;
      if (control === 'platform') {
        // Kamera za výškou hráče jen dojíždí, ať skok netřese obrazem.
        followY.current = followY.current === null ? y : lerp(followY.current, y, Math.min(1, delta * 4));
        // Na výšku mírně natočená, ať je vidět nejbližší mince či hrot ~11 m před startem
        // i vedle širokého hrdiny (P27A T6, P30B T5, `e2e/play-frame`); hrdina zůstává ~22 m od kamery.
        if (camera.aspect < 1) placeAngled(camera, look, z, followY.current + 1.2, 24, 25 * DEG, 4.5);
        else placeSide(camera, look, z, followY.current + 1.2, 16, 7, 18, 0.4);
      } else if (control === 'flap') {
        // Na počítači ptáček blíž středu (v levém horním rohu by ho zakryl HUD) a kamera
        // tak daleko, ať je vidět první trubka i mince za ní (P30B T5). Na výšku by kolmá
        // kamera ptáčka zmenšila na 3 % výšky: natočená do tří čtvrtin ho má přes 4 %
        // a první trubku i minci pořád v záběru.
        if (camera.aspect < 1) placeAngled(camera, look, z, FLAP.ceiling / UNIT / 2, 22, 50 * DEG, 5);
        else placeSide(camera, look, z, FLAP.ceiling / UNIT / 2, 30, FLAP.ceiling / UNIT + 1, 26, 0.1);
      } else if (control === 'steer') {
        // Osa trati je v jednotkách jádra a scéna ji zrcadlí (x → −x), stejně jako těla.
        const course = session.world.control.params.course as SteerCourse | undefined;
        placeChase(camera, look, x, z, course === undefined ? 0 : -centerAt(course, z * UNIT) / UNIT);
      } else if (control === 'shooter' || control === 'throw') {
        // Kameru střelnice a hřiště staví jejich scéna (`ShooterRig`, `ThrowRig`).
      } else {
        camera.position.set(x * 0.6, 3.4, z - 6.5);
        look.set(x * 0.4, 1.1, z + 9);
        camera.lookAt(look);
      }
      if (control !== 'shooter' && control !== 'throw') applyIntro(camera, look, introLeft(introClock()));
      camera.updateMatrixWorld();
      // Kde je hráč na obrazovce (−1 vlevo … 1 vpravo) – e2e tím hlídá směr, z obrázku se to nepřečte.
      if (surface.current !== null) surface.current.dataset.playerX = projected.copy(player.position).project(camera).x.toFixed(3);
    }
  });

  return (
    <>
      {backdrop ??
        (control === 'steer' ? (
          <SteerBackdrop course={session.world.control.params.course as SteerCourse | undefined} length={session.world.length / UNIT} look={scene} />
        ) : (
          <Backdrop control={control} length={session.world.length / UNIT} look={scene} />
        ))}
      {control === 'shooter' && <ShooterRig session={session} surface={surface} enabled={enabled} />}
      {control === 'throw' && <ThrowRig session={session} surface={surface} enabled={enabled} />}
      {views.map((view) =>
        // Branka poletování je neviditelná: jen počítá průlet mezerou.
        view.kind === 'gate' ? null : (
          <group key={view.index} ref={(group) => { groups.current[view.index] = group; }} userData={{ frame: frameTagOf(view), item: itemTagOf(view) }}>
            {PRIMITIVE.has(modelIdOf(view, cast)) ? (
              <Primitive id={modelIdOf(view, cast)} w={view.w} h={view.h} d={view.d} block={scene.block} />
            ) : rigged[view.index] !== undefined ? (
              // Riggovaná postava hraje klipy – poskok a zmáčknutí statických modelů by se s nimi praly.
              <RiggedModel
                character={rigged[view.index]!}
                h={view.h}
                clip={() => clips.current[view.index] ?? 'idle'}
                fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'}
                // Klip hráče čte e2e z DOM – z obrázku se nepřečte.
                onClip={view.role === ROLE.player ? (state) => { if (surface.current !== null) surface.current.dataset.animClip = state; } : undefined}
              />
            ) : (
              <group ref={(group) => { posed.current[view.index] = POSED_ROLES.has(view.role) ? group : null; }}>
                {/* Terč je tenký kotouč; model z popisku (kachna) by se vepsal do jeho tloušťky – kreslí se hloubkou jako šířkou, srážky se nemění. */}
                {/* Postava stojí ve výšce těla (P30B T3); vozidlo má tělo nízké a dlouhé, to se dál vepisuje celé. */}
                <FittedModel
                  id={modelIdOf(view, cast)}
                  w={view.w}
                  h={view.h}
                  d={view.kind === 'target' ? Math.max(view.d, view.w) : view.d}
                  fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'}
                  character={POSED_ROLES.has(view.role) && view.h >= Math.max(view.w, view.d)}
                />
              </group>
            )}
          </group>
        ),
      )}
    </>
  );
}

/** Podklad scény v barvách sady prostředí (P26 T11): dráha běžce, hladina pod plošinami, zem pod trubkami, rekvizity. */
function Backdrop({ control, length, look }: { readonly control: string; readonly length: number; readonly look: Look }) {
  const span = length + 60;
  if (control === 'platform') {
    const water = PLATFORM.fallBelowY / UNIT - 0.4;
    return (
      <>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, water, span / 2 - 30]}>
          <planeGeometry args={[80, span]} />
          <meshStandardMaterial color={look.water} roughness={0.3} />
        </mesh>
        <Scenery look={look} layout="behind" inner={11} from={-20} to={length + 20} y={water} size={1.6} />
      </>
    );
  }
  if (control === 'flap') {
    // Úzký pás země: z boku je to proužek pod trubkami a za ním obloha. Široká
    // plocha by z výšky kamery zabrala spodní půlku obrazu a spolkla dolní trubky.
    return (
      <>
        <mesh position={[0, -0.4, span / 2 - 30]}>
          <boxGeometry args={[3, 0.8, span]} />
          <meshStandardMaterial color={look.ground} roughness={1} />
        </mesh>
        {/* Boční kamera vidí kulisy za tratí malé a v mlze: dvojnásobná velikost (P28D T6). */}
        <Scenery look={look} layout="behind" inner={12} from={-20} to={length + 20} y={-0.4} size={2} />
      </>
    );
  }
  if (control === 'shooter' || control === 'throw') {
    return (
      <>
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 20]} renderOrder={UNDER_PANORAMA}>
          <planeGeometry args={[120, 120]} />
          <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
        </mesh>
        {control === 'shooter' ? <Scenery look={look} layout="sides" inner={14} from={-4} to={60} size={1.5} /> : <Scenery look={look} layout="behind" inner={13} from={-10} to={45} size={1.5} />}
      </>
    );
  }
  const trackLength = length + 20;
  const trackWidth = (RUNNER.lanes * RUNNER.laneWidth) / UNIT;
  const laneWidth = RUNNER.laneWidth / UNIT;
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, trackLength / 2 - 10]}>
        <planeGeometry args={[trackWidth + 0.6, trackLength]} />
        <meshStandardMaterial color={look.track} roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, trackLength / 2 - 10]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[80, trackLength + 80]} />
        <meshStandardMaterial color={look.ground} roughness={1} depthWrite={false} />
      </mesh>
      <Scenery look={look} layout="sides" inner={trackWidth / 2 + 2.5} from={-10} to={trackLength - 10} />
      {[-0.5, 0.5].map((edge) => (
        <mesh key={edge} rotation={[-Math.PI / 2, 0, 0]} position={[edge * laneWidth, 0, trackLength / 2 - 10]}>
          <planeGeometry args={[0.08, trackLength]} />
          <meshBasicMaterial color="#e2e8f0" />
        </mesh>
      ))}
    </>
  );
}
