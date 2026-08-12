'use client';

import { Canvas } from '@react-three/fiber';
import { useState } from 'react';

import type { TraceInput } from '@/sim/interpreter';
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
    };
  }
}

/**
 * Žádný `<Environment preset>` z drei — TOOLING.md past #2: `useEnvironment.js`
 * má zadrátovaný `CUBEMAP_ROOT` na raw.githack.com a stahoval by HDRI za běhu,
 * čímž rozbije jak "žádný loading screen", tak service worker. Světlo je tady
 * ruční a lokální.
 */
export default function Stage() {
  const [ready, setReady] = useState(false);

  return (
    <Canvas
      data-testid="stage-canvas"
      gl={{ antialias: false, powerPreference: 'high-performance' }}
      camera={{ position: [3, 3, 4], fov: 45 }}
      onCreated={({ gl }) => {
        const ctx = gl.getContext();
        // Playwright to čte v e2e/smoke.spec.ts. Je to jediný způsob, jak z
        // prohlížeče dostat odpověď na "je kontext OPRAVDU WebGL2", protože
        // existence <canvas> sama o sobě nedokazuje vůbec nic.
        window.__worldsmith = {
          webgl2: ctx instanceof WebGL2RenderingContext,
          renderer: 'three',
          verify: verifyWitness,
        };
        setReady(true);
      }}
    >
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 6, 3]} intensity={1.4} />
      <mesh rotation={[0.4, 0.8, 0]}>
        <boxGeometry args={[1.4, 1.4, 1.4]} />
        <meshStandardMaterial color={ready ? '#2f9e8f' : '#3a4a4e'} flatShading />
      </mesh>
      <gridHelper args={[12, 12, '#1d2b2f', '#162023']} position={[0, -1.2, 0]} />
    </Canvas>
  );
}
