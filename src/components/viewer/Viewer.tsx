'use client';

/**
 * Viewer — plátno, které přepíná světy a po každém přepnutí po sobě uklidí.
 *
 * Dvě věci, na kterých úloha stojí:
 *
 * 1. **Přepnutí neponechá živý zdroj.** Scéna se staví z kitu, drží se v jedné
 *    referenci a při výměně jde celá do `disposeSubtree`. Oracle je
 *    `renderer.info.memory` po padesáti přepnutích — proto plátno vystavuje
 *    `window.__viewer`, jinak se na ten údaj z prohlížeče nedá zeptat.
 * 2. **Průběh emise jde po SSE**, ne až s verdiktem. Fáze se vypisují tak, jak
 *    docházejí, takže obrazovka nikdy není prázdná ani při replayi svědka.
 *
 * Žádný `<Environment preset>` z drei (past #2 z `TOOLING.md`): stahoval by HDRI
 * za běhu a rozbil by „žádný loading screen" i service worker. Světlo je ruční.
 *
 * Na `src/fallback/**` se odsud nesahá a hlídá to test — fallback je samostatný
 * artefakt, který se musí dát postavit bez jádra i bez tohohle plátna.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataTexture, LinearFilter, Mesh, MeshToonMaterial, RedFormat, type Group } from 'three';

import { buildLayoutScene, layoutById } from '@/kit';

import { disposeSubtree } from './dispose';
import { streamEmission, type EmitProgress } from './sse';

declare global {
  interface Window {
    __viewer?: {
      /** Zdroje, které renderer opravdu drží. Jediný oracle úklidu, jaký z prohlížeče existuje. */
      memory: () => { geometries: number; textures: number };
      /** Přepne na layout daného indexu (modulo počet layoutů). */
      switchTo: (index: number) => void;
      /** Kolik snímků plátno vykreslilo. Test podle toho pozná, že přepnutí došlo na GPU. */
      frames: () => number;
      layouts: readonly string[];
    };
  }
}

/**
 * Toon rampa jako skutečná textura.
 *
 * Není to ozdoba: bez ní nese scéna nula textur a padesátinásobné přepnutí by
 * o jejich úklidu netvrdilo nic — a přitom je to právě zapomenutá textura, na
 * kterou má ten oracle mířit. Čtyři stupně jsou ruční, generují se kódem
 * a nic se nestahuje.
 */
function toonRamp(): DataTexture {
  const levels = new Uint8Array([40, 110, 190, 255]);
  const texture = new DataTexture(levels, levels.length, 1, RedFormat);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** Scéna z kitu s vlastní rampou. Neznámý layout je vada dat, ne stav k vykreslení. */
function buildWorld(layoutId: string): Group {
  const layout = layoutById(layoutId);
  if (layout === undefined) {
    throw new Error(`viewer odkazuje na neznámý layout ${layoutId}`);
  }

  const group = buildLayoutScene(layout);
  const ramp = toonRamp();
  group.traverse((object) => {
    const material = (object as Mesh).material;
    if (material instanceof MeshToonMaterial) {
      material.gradientMap = ramp;
      material.needsUpdate = true;
    }
  });

  return group;
}

function World({ layoutId }: { layoutId: string }) {
  const scene = useMemo(() => buildWorld(layoutId), [layoutId]);

  // Úklid patří sem, ne k `<primitive>`: R3F objekty, které nevyrobil sám,
  // vědomě neodkládá — jsou cizí a mohly by se používat dál.
  useEffect(() => () => void disposeSubtree(scene), [scene]);

  return <primitive object={scene} />;
}

function Bridge({ onSwitch, layouts }: { onSwitch: (index: number) => void; layouts: readonly string[] }) {
  const gl = useThree((state) => state.gl);
  const frames = useRef(0);

  useFrame(() => {
    frames.current += 1;
  });

  useEffect(() => {
    window.__viewer = {
      memory: () => ({ geometries: gl.info.memory.geometries, textures: gl.info.memory.textures }),
      switchTo: onSwitch,
      frames: () => frames.current,
      layouts,
    };
    return () => {
      delete window.__viewer;
    };
  }, [gl, onSwitch, layouts]);

  return null;
}

const PROGRESS: React.CSSProperties = {
  position: 'absolute',
  left: '0.9rem',
  bottom: '0.9rem',
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  gap: '0.6rem',
  fontFamily: 'system-ui, sans-serif',
  fontSize: '0.8rem',
  color: '#dfeae8',
  textShadow: '0 1px 3px rgba(0,0,0,0.75)',
  pointerEvents: 'none',
};

export default function Viewer({
  layouts,
  promptId = null,
}: {
  readonly layouts: readonly string[];
  /** Když je zadaný, viewer si vyžádá emisi a vypisuje její průběh. */
  readonly promptId?: string | null;
}) {
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState<readonly EmitProgress[]>([]);

  const switchTo = useCallback(
    (next: number) => setIndex(((next % layouts.length) + layouts.length) % layouts.length),
    [layouts.length],
  );

  useEffect(() => {
    if (promptId === null) return;
    const abort = new AbortController();
    setProgress([]);
    streamEmission(promptId, {
      signal: abort.signal,
      onProgress: (step) => setProgress((seen) => [...seen, step]),
    }).catch(() => {
      // Přerušení odchodem ze stránky není stav k vykreslení. Vada emise je
      // verdikt, ne výjimka — ta jde v posledním rámci a čte ji volající.
    });
    return () => abort.abort();
  }, [promptId]);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <Canvas
        data-testid="viewer-canvas"
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ position: [7, 7, 9], fov: 45 }}
      >
        <ambientLight intensity={0.65} />
        <directionalLight position={[5, 8, 4]} intensity={1.3} />
        <Bridge onSwitch={switchTo} layouts={layouts} />
        <World layoutId={layouts[index]} />
      </Canvas>
      {progress.length === 0 ? null : (
        <ul style={PROGRESS} data-testid="viewer-progress">
          {progress.map((step) => (
            <li key={step.step} data-testid={`viewer-phase-${step.phase}`}>
              {step.phase}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
