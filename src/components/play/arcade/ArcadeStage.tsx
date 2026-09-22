'use client';

/**
 * Plátno běžce (P25A T6). Smyčka `useFrame` posouvá hodiny relace (pevný
 * krok v `session.ts`) a kreslí těla interpolovaná mezi posledními dvěma
 * tiky; kamera jede za a nad hráčem. Vstup se jen zapíše do relace –
 * padne do nejbližšího tiku, takže záznam jde přehrát.
 *
 * Modely: `/assets/worldstream/game/<id>-lod1.glb` podle id těla (`hurdle`,
 * `coin`, …); když katalog id nemá (404), kreslí se barevný kvádr. Modely
 * z P25B se tak po sloučení chytí bez změny kódu.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Box3, type Group, type Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import { RUNNER } from '@/play/arcade/pieces/runner';

import type { ArcadeSession } from './session';

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
};

/** Id těla → id modelu v katalogu. Hráč dostane model hrdiny z popisku role. */
function modelIdOf(kind: string, playerModel: string): string {
  if (kind === 'player') return playerModel;
  if (kind === 'finish') return 'finish-flag';
  return kind;
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

function World({ session, playerModel }: { readonly session: ArcadeSession; readonly playerModel: string }) {
  const views = useMemo(() => bodiesOf(session), [session]);
  const groups = useRef<(Group | null)[]>([]);
  const camera = useThree((three) => three.camera);
  const look = useMemo(() => new Vector3(), []);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    const state = session.state();
    const prev = session.prev();
    for (const view of views) {
      const group = groups.current[view.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(view.index);
      group.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      group.position.set(
        lerp(prev[base + BODY.x] as number, state[base + BODY.x] as number, alpha) / UNIT,
        lerp(prev[base + BODY.y] as number, state[base + BODY.y] as number, alpha) / UNIT,
        lerp(prev[base + BODY.z] as number, state[base + BODY.z] as number, alpha) / UNIT,
      );
      // Skluz snižuje tělo – model se přikrčí stejně.
      if (view.role === ROLE.player) group.scale.y = (state[base + BODY.h] as number) / UNIT / view.h;
      if (view.role === ROLE.collectible) group.rotation.y += delta * 3;
    }
    const player = groups.current[state[HEADER.player] as number];
    if (player !== null && player !== undefined) {
      const { x, z } = player.position;
      camera.position.set(x * 0.6, 3.4, z - 6.5);
      look.set(x * 0.4, 1.1, z + 9);
      camera.lookAt(look);
    }
  });

  const trackLength = session.world.length / UNIT + 20;
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
      {views.map((view) => (
        <group key={view.index} ref={(group) => { groups.current[view.index] = group; }}>
          <FittedModel id={modelIdOf(view.kind, playerModel)} w={view.w} h={view.h} d={view.d} fallback={FALLBACK_COLOR[view.kind] ?? '#94a3b8'} />
        </group>
      ))}
    </>
  );
}

const SWIPE_PX = 30;

/** Ťuk/klik/mezerník = skok, šipky/A-D a swipe = pruh, šipka dolů / swipe dolů = skluz. */
function useArcadeInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const key = event.key.toLowerCase();
      const button =
        key === ' ' || key === 'arrowup' || key === 'w' ? BUTTON.TAP
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
  }, [session]);

  useEffect(() => {
    const element = target.current;
    if (element === null) return;
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
  }, [session, target]);
}

export default function ArcadeStage({ session, playerModel }: { readonly session: ArcadeSession; readonly playerModel: string }) {
  const surface = useRef<HTMLDivElement | null>(null);
  useArcadeInput(session, surface);
  return (
    <div ref={surface} className="play-stage" data-testid="arcade-stage" style={{ touchAction: 'none' }}>
      <Canvas camera={{ position: [0, 3.4, -6.5], fov: 60 }} dpr={[1, 2]}>
        <color attach="background" args={['#bae6fd']} />
        <fog attach="fog" args={['#bae6fd', 30, 90]} />
        <hemisphereLight args={['#e0f2fe', '#166534', 0.9]} />
        <directionalLight position={[6, 12, -4]} intensity={1.6} />
        <World session={session} playerModel={playerModel} />
      </Canvas>
    </div>
  );
}
