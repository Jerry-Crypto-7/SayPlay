'use client';

import { Canvas } from '@react-three/fiber';
import { useRef, useState } from 'react';

import FollowCamera from '@/components/viewer/FollowCamera';
import type { ProjectedEntity } from '@/components/viewer/projection';
import WorldScene, { type RunnerRef } from '@/components/viewer/WorldScene';
import type { TraceInput, WorldDocRuntime } from '@/sim/interpreter';
import { verifyWitness, type VerifiableWorld, type VerifyResult } from '@/verify/witness';

declare global {
  interface Window {
    __worldsmith?: {
      webgl2: boolean;
      renderer: string;
      /**
       * Verifikátor svědka spuštěný **v prohlížeči**. Není to testovací pomůcka:
       * replay musí dát tentýž hash v Node i v prohlížeči, jinak certifikát
       * vydaný na serveru o hře v prohlížeči netvrdí nic. `e2e/witness-replay`
       * porovnává obojí a je to jediná cesta, jak se na to zeptat skutečného
       * runtimu místo jeho napodobeniny.
       */
      verify: (doc: VerifiableWorld, witness: readonly TraceInput[]) => VerifyResult;
      /**
       * Entity světa, který plátno zrovna hraje. Prázdné pole znamená, že žádný
       * svět nedrží — úvodní obrazovka před prvním promptem.
       */
      entities: () => readonly ProjectedEntity[];
      /** Kolik tiků svět odkrokoval. */
      tick: () => number;
    };
  }
}

/**
 * Plátno úvodní stránky.
 *
 * Do 19. 8. 2026 tu byla **rotující krychle** a nic jiného; svět, který si
 * uživatel vyžádal, se do 3D nepromítal vůbec. Krychle je pryč a na jejím místě
 * je běžící simulace — přesně ta, kterou kreslí `Viewer`, protože scéna i kamera
 * jsou sdílené komponenty. Druhý systém vykreslování by znamenal druhé místo,
 * kde se to rozbije.
 *
 * Bez světa se nekreslí náhražka ani ukázková scéna, jen prázdná mřížka: dokud
 * uživatel nenapsal prompt, nemá plátno co ukazovat a předstírat obsah by bylo
 * horší než přiznat prázdno.
 *
 * Žádný `<Environment preset>` z drei — TOOLING.md past #2: `useEnvironment.js`
 * má zadrátovaný `CUBEMAP_ROOT` na raw.githack.com a stahoval by HDRI za běhu,
 * čímž rozbije jak „žádný loading screen", tak service worker. Světlo je tady
 * ruční a lokální.
 */
export default function Stage({ world = null }: { readonly world?: WorldDocRuntime | null }) {
  const [, setReady] = useState(false);
  const runnerRef = useRef<RunnerRef['current']>(null);

  return (
    <Canvas
      data-testid="stage-canvas"
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      camera={{ position: [7, 7, 9], fov: 45 }}
      onCreated={({ gl }) => {
        const ctx = gl.getContext();
        // Playwright to čte v e2e/smoke.spec.ts. Je to jediný způsob, jak z
        // prohlížeče dostat odpověď na „je kontext OPRAVDU WebGL2", protože
        // existence <canvas> sama o sobě nedokazuje vůbec nic.
        window.__worldsmith = {
          webgl2: ctx instanceof WebGL2RenderingContext,
          renderer: 'three',
          verify: verifyWitness,
          // Přes referenci, ne přes zachycenou hodnotu: běh vzniká až se světem,
          // tedy dlouho po vytvoření plátna.
          entities: () => runnerRef.current?.entities() ?? [],
          tick: () => runnerRef.current?.tick() ?? 0,
        };
        setReady(true);
      }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 6, 3]} intensity={1.4} />
      {world === null ? (
        <gridHelper args={[12, 12, '#1d2b2f', '#162023']} position={[0, -1.2, 0]} />
      ) : (
        <>
          <WorldScene world={world} runnerRef={runnerRef} />
          <FollowCamera runnerRef={runnerRef} />
        </>
      )}
    </Canvas>
  );
}
