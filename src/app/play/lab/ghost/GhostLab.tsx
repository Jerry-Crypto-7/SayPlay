'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';

import { colorHex } from '@/brand/tokens';
import { Ghost, worldPlacement } from '@/components/play/arcade/Ghost';
import { type GhostEnd, type GhostReplay, fetchGhost } from '@/components/play/arcade/ghost-source';
import { type ArcadeSession, createArcadeSession } from '@/components/play/arcade/session';
import { ARCADE_LIMITS, type ArcadeWorld, HEADER } from '@/play/arcade/contract';

type LabState =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly session: ArcadeSession; readonly ghost: GhostReplay }
  | { readonly state: 'no-ghost' }
  | { readonly state: 'failed'; readonly error: string };

export interface GhostLabProbe {
  /** Póza ducha (jednotky jádra) v ticích, na které připadl snímek. */
  trace(): Record<number, readonly [number, number, number]>;
  /** Dotočí ducha na konec záznamu a vrátí, kde a s jakým hashem skončil. */
  finish(): GhostEnd | null;
}

declare global {
  interface Window {
    __ghostLab?: GhostLabProbe;
  }
}

/** Hodiny hráče – jako `World`, jen bez kreslení těl. Snímek běží před duchem. */
function Clock({ session }: { readonly session: ArcadeSession }) {
  useFrame((_, delta) => {
    session.advance(delta * 1000);
  });
  return null;
}

/** Po duchovi: zapíše jeho pózu v tiku hráče a kamerou ho sleduje. */
function Trace({ session, ghost }: { readonly session: ArcadeSession; readonly ghost: GhostReplay }) {
  const camera = useThree((three) => three.camera);
  const trace = useRef(new Map<number, readonly [number, number, number]>());
  useEffect(() => {
    const probe: GhostLabProbe = {
      trace: () => Object.fromEntries(trace.current),
      finish: () => {
        ghost.poseAt(ARCADE_LIMITS.maxTicks);
        return ghost.end();
      },
    };
    window.__ghostLab = probe;
    return () => {
      if (window.__ghostLab === probe) delete window.__ghostLab;
    };
  }, [ghost]);
  useFrame(() => {
    const tick = session.state()[HEADER.tick] as number;
    const pose = ghost.poseAt(tick);
    if (pose === null) return;
    trace.current.set(tick, [pose.x, pose.y, pose.z]);
    const [x, y, z] = worldPlacement(pose);
    camera.position.set(x + 3, y + 2.5, z - 6);
    camera.lookAt(x, y + 1, z);
  });
  return null;
}

/** Zkušební scéna ducha (P37C T3): hráčem je ukázka robota, duch přehrává uloženou výzvu. */
export function GhostLab({ game, dare }: { readonly game: string; readonly dare: string }) {
  const [lab, setLab] = useState<LabState>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      const response = await fetch(`/api/play/games/${game}`);
      if (!response.ok) throw new Error(`game read ${String(response.status)}`);
      const { arcade } = (await response.json()) as { arcade?: ArcadeWorld };
      if (arcade === undefined) throw new Error('not an arcade game');
      const ghost = await fetchGhost(game, dare, arcade);
      if (!live) return;
      if (ghost === null) return setLab({ state: 'no-ghost' });
      const session = createArcadeSession(arcade);
      session.startDemo();
      setLab({ state: 'ready', session, ghost });
    })().catch((error: unknown) => live && setLab({ state: 'failed', error: String(error) }));
    return () => {
      live = false;
    };
  }, [game, dare]);

  return (
    <main data-testid="ghost-lab" data-state={lab.state} style={{ position: 'relative', height: '100vh' }}>
      {lab.state === 'ready' ? (
        <Canvas camera={{ fov: 55, position: [3, 2.5, -6] }}>
          <color attach="background" args={[colorHex.cream]} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[4, 8, -2]} intensity={1.6} />
          <mesh rotation-x={-Math.PI / 2} position={[0, 0, 150]}>
            <planeGeometry args={[30, 400]} />
            <meshStandardMaterial color={colorHex['cream-deep']} />
          </mesh>
          <Clock session={lab.session} />
          <Ghost source={lab.ghost} session={lab.session} label="friend" />
          <Trace session={lab.session} ghost={lab.ghost} />
        </Canvas>
      ) : lab.state === 'failed' ? (
        lab.error
      ) : lab.state === 'no-ghost' ? (
        'This dare has no ghost.'
      ) : (
        'Loading the ghost…'
      )}
    </main>
  );
}
