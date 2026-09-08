'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useRef, useState, type RefObject } from 'react';

import FollowCamera, { type CameraMode } from '@/components/viewer/FollowCamera';
import Lighting, { VIEWER_GL, VIEWER_SHADOWS } from '@/components/viewer/Lighting';
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
      /**
       * Kolik snímků plátno nakreslilo **se světem na scéně** (P15 T39).
       *
       * `entities().length > 0` říká, že svět vznikl v paměti — ne že došel na
       * GPU. Rozpočet „od věty po první snímek" se o ten rozdíl opírá celý,
       * takže se nesmí měřit proti přítomnosti dat.
       *
       * **Počítá se od nuly jen pro první svět stránky.** Druhý prompt čítač
       * nenuluje: měřit se má studený start, a ten nastane jednou za načtení.
       */
      worldFrames: () => number;
      /**
       * Kde stojí kamera ve světových souřadnicích.
       *
       * Embed má totéž pod `window.__viewer`, úvodní stránka do T5 neměla nic —
       * a přepínač volného režimu je právě tady, takže jinak se z prohlížeče
       * nedá zeptat, jestli s kamerou tažení vůbec pohnulo.
       */
      camera: () => { x: number; y: number; z: number };
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
 * Světlo, stíny, mlha a tone mapping jsou od T6 sdílené s `Viewer.tsx`
 * (`viewer/Lighting.tsx`). Úvodní stránka a embed musí vypadat stejně — dokud
 * měla každá vlastní dvojici světel, lišily se a nikdo to nehlídal.
 */

/**
 * Počítadlo snímků **uvnitř světa**. Mountuje se jen s ním, takže první
 * započtený snímek je doopravdy první snímek, na kterém svět byl.
 *
 * Kdyby stálo vedle světa, počítalo by i prázdnou mřížku úvodní obrazovky
 * a rozpočet „od věty po první snímek" by vyšel na nulu.
 */
function DrawnFrames({ counter }: { readonly counter: RefObject<number> }) {
  useFrame(() => {
    counter.current += 1;
  });
  return null;
}

export default function Stage({
  world = null,
  look = null,
  inputs,
  runnerRef: shared,
  cameraMode = 'follow',
}: {
  readonly world?: WorldDocRuntime | null;
  /**
   * Část `look` téže emise, ze které je svět. Vybírá výtvarnou rodinu kulisy —
   * viz `WorldScene`. Plátno ji jen podává dál.
   */
  readonly look?: unknown;
  /** Vstupy jednoho tiku; bez něj si svět přehrává vlastního svědka. */
  readonly inputs?: (tick: number) => readonly TraceInput[];
  /**
   * Reference na běh **ven**. Stránka z ní čte `runState`, `tick` a rozvrh stavby,
   * ze kterých skládá fázi hry. Bez sdílení by musela mít vlastní běh — a hrálo by
   * se pak něco jiného, než co je na plátně vidět.
   */
  readonly runnerRef?: RunnerRef;
  /**
   * Sledovací, nebo volný. Stav drží stránka, protože přepínač stojí v jejím
   * herním HUD — plátno o něm jen ví, aby se kamera měla podle čeho zařídit.
   */
  readonly cameraMode?: CameraMode;
}) {
  const [, setReady] = useState(false);
  const own = useRef<RunnerRef['current']>(null);
  const runnerRef = shared ?? own;
  const worldFrames = useRef(0);

  return (
    <Canvas
      data-testid="stage-canvas"
      shadows={VIEWER_SHADOWS}
      gl={VIEWER_GL}
      camera={{ position: [7, 7, 9], fov: 45 }}
      onCreated={({ gl, camera }) => {
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
          worldFrames: () => worldFrames.current,
          camera: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }),
        };
        setReady(true);
      }}
    >
      <Lighting />
      {world === null ? (
        <gridHelper args={[12, 12, '#1d2b2f', '#162023']} position={[0, -1.2, 0]} />
      ) : (
        <>
          <DrawnFrames counter={worldFrames} />
          <WorldScene world={world} look={look} runnerRef={runnerRef} inputs={inputs} />
          <FollowCamera runnerRef={runnerRef} mode={cameraMode} />
        </>
      )}
    </Canvas>
  );
}
