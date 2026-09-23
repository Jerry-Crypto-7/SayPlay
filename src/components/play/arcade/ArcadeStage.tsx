'use client';

/**
 * Plátno arkády (P25A T6, P25C T6, P25F T6). Smyčka `useFrame` posouvá hodiny relace
 * (pevný krok v `session.ts`) a kreslí těla interpolovaná mezi posledními
 * dvěma tiky. Scéna podle ovládání: běžec a závod (`steer/`) mají kameru za
 * a nad hráčem, plošinovka a poletování boční kameru (trať jde zleva
 * doprava), aréna (`arena/`) vlastní svět s kamerou shora. Vstup se
 * jen zapíše do relace – padne do nejbližšího tiku, takže záznam jde přehrát.
 *
 * Modely: `/assets/worldstream/game/<id>-lod1.glb` podle id těla (`hurdle`,
 * `coin`, …); když katalog id nemá (404), kreslí se barevný kvádr. Tělesa,
 * pro která model v katalogu není (plošiny, hroty, trubky, ptáček), se
 * kreslí rovnou primitivem a nestahují se.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box3, type Group, type Object3D, type PerspectiveCamera, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { AXIS_MAX, BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { FLAP } from '@/play/arcade/pieces/flap';
import { PLATFORM } from '@/play/arcade/pieces/platform';
import { RUNNER } from '@/play/arcade/pieces/runner';
import type { SteerCourse } from '@/play/arcade/pieces/steer';

import { ArenaWorld, useArenaInput } from './arena/ArenaScene';
import type { ArcadeSession } from './session';
import { SteerBackdrop, placeChase, useSteerInput } from './steer/SteerScene';

const MODEL_BASE = '/assets/worldstream/game/';

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
};

/** Id modelu, který katalog nemá – kreslí se primitivem (objednávka modelů pro P25F je ve Findings plánu). */
const PRIMITIVE = new Set(['platform', 'platform-moving', 'spikes', 'pipe', 'ceiling', 'bird']);

/** Id těla → id modelu v katalogu. Hráč dostane model hrdiny z popisku role. */
function modelIdOf(view: BodyView, playerModel: string): string {
  if (view.role === ROLE.player) return playerModel;
  if (view.kind === 'finish') return 'finish-flag';
  return view.kind;
}

const modelCache = new Map<string, Promise<Object3D | null>>();

function loadModel(id: string): Promise<Object3D | null> {
  let pending = modelCache.get(id);
  if (pending === undefined) {
    pending = new GLTFLoader()
      .loadAsync(`${MODEL_BASE}${id}-lod1.glb`)
      .then((gltf) => gltf.scene as Object3D)
      .catch(() => null);
    modelCache.set(id, pending);
  }
  return pending;
}

/** Model vepsaný do kvádru těla (metry), postavený na zem, střed v ose. */
function FittedModel({ id, w, h, d, fallback }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number; readonly fallback: string }) {
  const [model, setModel] = useState<Object3D | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadModel(id).then((loaded) => {
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
    const scale = Math.min(w / Math.max(size.x, 1e-3), h / Math.max(size.y, 1e-3), d / Math.max(size.z, 1e-3)) || 1;
    copy.scale.setScalar(scale);
    const center = box.getCenter(new Vector3());
    copy.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    return copy;
  }, [model, w, h, d]);
  if (fitted !== null) return <primitive object={fitted} />;
  return (
    <mesh position={[0, h / 2, 0]}>
      <boxGeometry args={[w, h, d]} />
      <meshStandardMaterial color={fallback} roughness={0.6} />
    </mesh>
  );
}

/** Tělesa bez modelu: plošina (hlína + tráva), řada hrotů, trubka, strop, ptáček. */
function Primitive({ id, w, h, d }: { readonly id: string; readonly w: number; readonly h: number; readonly d: number }) {
  if (id === 'platform' || id === 'platform-moving') {
    const top = Math.min(0.25, h / 3);
    return (
      <>
        <mesh position={[0, (h - top) / 2, 0]}>
          <boxGeometry args={[w, h - top, d]} />
          <meshStandardMaterial color={id === 'platform' ? '#92400e' : '#475569'} roughness={0.9} />
        </mesh>
        <mesh position={[0, h - top / 2, 0]}>
          <boxGeometry args={[w, top, d]} />
          <meshStandardMaterial color={id === 'platform' ? '#16a34a' : '#f59e0b'} roughness={0.8} />
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

interface BodyView {
  readonly index: number;
  readonly kind: string;
  readonly role: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

function bodiesOf(session: ArcadeSession): readonly BodyView[] {
  const state = session.state();
  const count = state[HEADER.bodyCount] as number;
  const views: BodyView[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = bodyBase(index);
    views.push({
      index,
      kind: session.world.kinds[state[base + BODY.kind] as number] ?? 'crate',
      role: state[base + BODY.role] as number,
      w: (state[base + BODY.w] as number) / UNIT,
      h: (state[base + BODY.h] as number) / UNIT,
      d: (state[base + BODY.d] as number) / UNIT,
    });
  }
  return views;
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

function World({ session, control, playerModel, surface }: { readonly session: ArcadeSession; readonly control: string; readonly playerModel: string; readonly surface: React.RefObject<HTMLDivElement | null> }) {
  const views = useMemo(() => bodiesOf(session), [session]);
  const groups = useRef<(Group | null)[]>([]);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const followY = useRef<number | null>(null);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    const state = session.state();
    const prev = session.prev();
    for (const view of views) {
      const group = groups.current[view.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(view.index);
      group.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      // Kamera běžce kouká po +z, takže +x jádra by vyšlo na obrazovce vlevo a „LEFT“ (x − 1) by hráče poslal doprava.
      group.position.set(
        -lerp(prev[base + BODY.x] as number, state[base + BODY.x] as number, alpha) / UNIT,
        lerp(prev[base + BODY.y] as number, state[base + BODY.y] as number, alpha) / UNIT,
        lerp(prev[base + BODY.z] as number, state[base + BODY.z] as number, alpha) / UNIT,
      );
      // Skluz snižuje tělo – model se přikrčí stejně.
      if (view.role === ROLE.player) group.scale.y = (state[base + BODY.h] as number) / UNIT / view.h;
      if (view.role === ROLE.collectible) group.rotation.y += delta * 3;
    }
    const player = groups.current[state[HEADER.player] as number];
    if (player !== null && player !== undefined) {
      const { x, y, z } = player.position;
      if (control === 'platform') {
        // Kamera za výškou hráče jen dojíždí, ať skok netřese obrazem.
        followY.current = followY.current === null ? y : lerp(followY.current, y, Math.min(1, delta * 4));
        placeSide(camera, look, z, followY.current + 1.2, 16, 7, 18, 0.4);
      } else if (control === 'flap') {
        // Ptáček blíž středu: v levém horním rohu by ho na počítači zakryl HUD.
        placeSide(camera, look, z, FLAP.ceiling / UNIT / 2, 14, FLAP.ceiling / UNIT + 1, 26, 0.1);
      } else if (control === 'steer') {
        placeChase(camera, look, x, z);
      } else {
        camera.position.set(x * 0.6, 3.4, z - 6.5);
        look.set(x * 0.4, 1.1, z + 9);
        camera.lookAt(look);
      }
      camera.updateMatrixWorld();
      // Kde je hráč na obrazovce (−1 vlevo … 1 vpravo) – e2e tím hlídá směr, z obrázku se to nepřečte.
      if (surface.current !== null) surface.current.dataset.playerX = projected.copy(player.position).project(camera).x.toFixed(3);
    }
  });

  return (
    <>
      {control === 'steer' ? (
        <SteerBackdrop course={session.world.control.params.course as SteerCourse | undefined} length={session.world.length / UNIT} />
      ) : (
        <Backdrop control={control} length={session.world.length / UNIT} />
      )}
      {views.map((view) =>
        // Branka poletování je neviditelná: jen počítá průlet mezerou.
        view.kind === 'gate' ? null : (
          <group key={view.index} ref={(group) => { groups.current[view.index] = group; }}>
            {PRIMITIVE.has(modelIdOf(view, playerModel)) ? (
              <Primitive id={modelIdOf(view, playerModel)} w={view.w} h={view.h} d={view.d} />
            ) : (
              <FittedModel id={modelIdOf(view, playerModel)} w={view.w} h={view.h} d={view.d} fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'} />
            )}
          </group>
        ),
      )}
    </>
  );
}

/** Podklad scény: dráha běžce, voda pod plošinami, tráva pod trubkami. */
function Backdrop({ control, length }: { readonly control: string; readonly length: number }) {
  const span = length + 60;
  if (control === 'platform') {
    return (
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, PLATFORM.fallBelowY / UNIT - 0.4, span / 2 - 30]}>
        <planeGeometry args={[80, span]} />
        <meshStandardMaterial color="#0284c7" roughness={0.3} />
      </mesh>
    );
  }
  if (control === 'flap') {
    // Úzký pás země: z boku je to proužek pod trubkami a za ním obloha. Široká
    // plocha by z výšky kamery zabrala spodní půlku obrazu a spolkla dolní trubky.
    return (
      <mesh position={[0, -0.4, span / 2 - 30]}>
        <boxGeometry args={[3, 0.8, span]} />
        <meshStandardMaterial color="#a16207" roughness={1} />
      </mesh>
    );
  }
  const trackLength = length + 20;
  const trackWidth = (RUNNER.lanes * RUNNER.laneWidth) / UNIT;
  const laneWidth = RUNNER.laneWidth / UNIT;
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, trackLength / 2 - 10]}>
        <planeGeometry args={[trackWidth + 0.6, trackLength]} />
        <meshStandardMaterial color="#334155" roughness={0.9} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.03, trackLength / 2 - 10]}>
        <planeGeometry args={[80, trackLength + 80]} />
        <meshStandardMaterial color="#15803d" roughness={1} />
      </mesh>
      {[-0.5, 0.5].map((edge) => (
        <mesh key={edge} rotation={[-Math.PI / 2, 0, 0]} position={[edge * laneWidth, 0, trackLength / 2 - 10]}>
          <planeGeometry args={[0.08, trackLength]} />
          <meshBasicMaterial color="#e2e8f0" />
        </mesh>
      ))}
    </>
  );
}

const SWIPE_PX = 30;
const JUMP_KEYS = new Set([' ', 'arrowup', 'w']);

/** Běžec: ťuk/klik/mezerník = skok, šipky/A-D a swipe = pruh, šipka dolů / swipe dolů = skluz. */
function useRunnerInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const button =
        JUMP_KEYS.has(key) ? BUTTON.TAP
        : key === 'arrowleft' || key === 'a' ? BUTTON.LEFT
        : key === 'arrowright' || key === 'd' ? BUTTON.RIGHT
        : key === 'arrowdown' || key === 's' ? BUTTON.DOWN
        : 0;
      if (button === 0) return;
      event.preventDefault();
      session.press(button);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, active]);

  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    let start: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      start = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      if (start === null) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      start = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) session.press(BUTTON.TAP);
      else if (Math.abs(dx) > Math.abs(dy)) session.press(dx < 0 ? BUTTON.LEFT : BUTTON.RIGHT);
      else session.press(dy > 0 ? BUTTON.DOWN : BUTTON.TAP);
    };
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
    };
  }, [session, target, active]);
}

/**
 * Plošinovka: šipky/A-D drží osu, mezerník/šipka nahoru/W = skok. Dotyk:
 * levá čtvrtina drží vlevo, druhá vpravo, pravá polovina = skok – palec
 * vlevo běží, palec vpravo skáče (víc prstů najednou).
 */
function usePlatformInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const keys = new Set<'left' | 'right'>();
    const pointers = new Map<number, 'left' | 'right'>();
    const sync = (): void => {
      const held = new Set([...keys, ...pointers.values()]);
      session.hold(((held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0)) * AXIS_MAX);
    };
    const sideOf = (key: string): 'left' | 'right' | null => (key === 'arrowleft' || key === 'a' ? 'left' : key === 'arrowright' || key === 'd' ? 'right' : null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      const side = sideOf(key);
      if (side !== null) {
        event.preventDefault();
        keys.add(side);
        sync();
      } else if (JUMP_KEYS.has(key) && !event.repeat) {
        event.preventDefault();
        session.press(BUTTON.TAP);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const side = sideOf(event.key.toLowerCase());
      if (side === null) return;
      keys.delete(side);
      sync();
    };
    const onDown = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const at = (event.clientX - box.left) / Math.max(1, box.width);
      if (at >= 0.5) session.press(BUTTON.TAP);
      else {
        pointers.set(event.pointerId, at < 0.25 ? 'left' : 'right');
        sync();
      }
    };
    const onUp = (event: PointerEvent) => {
      if (pointers.delete(event.pointerId)) sync();
    };
    const release = (): void => {
      keys.clear();
      pointers.clear();
      sync();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [session, target, active]);
}

/** Poletování: mezerník/šipka nahoru/W nebo dotyk kdekoli = mávnutí (hned při stisku). */
function useFlapInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || !JUMP_KEYS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      session.press(BUTTON.TAP);
    };
    const onDown = () => session.press(BUTTON.TAP);
    window.addEventListener('keydown', onKey);
    element.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', onDown);
    };
  }, [session, target, active]);
}

export default function ArcadeStage({ session, playerModel }: { readonly session: ArcadeSession; readonly playerModel: string }) {
  const surface = useRef<HTMLDivElement | null>(null);
  const control = session.world.control.id;
  useRunnerInput(session, surface, control === 'runner');
  usePlatformInput(session, surface, control === 'platform');
  useFlapInput(session, surface, control === 'flap');
  useSteerInput(session, surface, control === 'steer');
  useArenaInput(session, surface, control === 'move_free');
  return (
    <div ref={surface} className="play-stage" data-testid="arcade-stage" data-control={control} style={{ touchAction: 'none' }}>
      <Canvas camera={{ position: [0, 3.4, -6.5], fov: 60 }} dpr={[1, 2]}>
        <color attach="background" args={['#bae6fd']} />
        <fog attach="fog" args={['#bae6fd', 30, 90]} />
        <hemisphereLight args={['#e0f2fe', '#166534', 0.9]} />
        {/* Boční scény svítí ze strany kamery (−x). */}
        <directionalLight position={[control === 'runner' ? 6 : -6, 12, -4]} intensity={1.6} />
        {control === 'move_free' ? (
          <ArenaWorld session={session} half={Number(session.world.control.params.half)} surface={surface} />
        ) : (
          <World session={session} control={control} playerModel={playerModel} surface={surface} />
        )}
      </Canvas>
    </div>
  );
}
