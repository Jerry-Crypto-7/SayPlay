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

import { buildRuntimeWorld } from '@/ir/build';
import { buildLayoutScene, layoutById } from '@/kit';
import type { RunState, WorldDocRuntime } from '@/sim/interpreter';

import { disposeSubtree } from './dispose';
import FollowCamera from './FollowCamera';
import type { ProjectedEntity } from './projection';
import { streamEmission, type EmitProgress } from './sse';
import WorldScene, { type RunnerRef, type WorldRunner } from './WorldScene';

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
      /**
       * Entity běžícího světa ve světových souřadnicích — v pořadí deklarace a
       * v plné délce, včetně despawnutých. Prázdné pole znamená, že plátno
       * žádný svět nedrží, ne že svět žádné entity nemá.
       */
      entities: () => readonly ProjectedEntity[];
      /** Kolik tiků svět odkrokoval. */
      tick: () => number;
      /**
       * Kde stojí kamera ve světových souřadnicích.
       *
       * Vzdálenost k postavě je jediné, čím se dá zvenčí ověřit, že kamera hru
       * opravdu sleduje — sama o sobě je kamera mimo hashovaný stav, takže ji
       * replay ani řetěz hashů nezachytí.
       */
      camera: () => { x: number; y: number; z: number };
      /**
       * Posune svět o `count` tiků bez čekání na nástěnný čas.
       *
       * Není to testovací zkratka vedle produkční cesty: je to tatáž cesta, jen
       * bez hodin. `pump()` z nástěnného času nedělá nic jiného, než že spočítá
       * celý počet tiků, a ty se pak krokují úplně stejně. Test, který by čekal
       * na skutečné vteřiny, by měřil rychlost stroje, ne chování světa.
       */
      step: (count: number) => void;
      runState: () => RunState | null;
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

function Bridge({
  onSwitch,
  layouts,
  runnerRef,
}: {
  onSwitch: (index: number) => void;
  layouts: readonly string[];
  runnerRef: RunnerRef;
}) {
  const gl = useThree((state) => state.gl);
  const camera = useThree((state) => state.camera);
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
      // Přes `runnerRef`, ne přes zachycenou hodnotu: běh vzniká až se světem
      // a plátno ho mění za života mostu. Zachycená hodnota by tu zamrzla na
      // `null` z prvního snímku a `entities()` by navždy vracelo prázdno.
      entities: () => runnerRef.current?.entities() ?? [],
      tick: () => runnerRef.current?.tick() ?? 0,
      camera: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }),
      step: (count: number) => runnerRef.current?.step(count),
      runState: () => runnerRef.current?.runState() ?? null,
    };
    return () => {
      delete window.__viewer;
    };
  }, [gl, camera, onSwitch, layouts, runnerRef]);

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

/**
 * Ze zapečetěného dokumentu na běhový svět.
 *
 * `POST /api/emit` vrací `doc` s povrchovou částí `sim`; běh z ní staví
 * `buildRuntimeWorld` — **tentýž** vstupní bod, jakým prošel certifikát na
 * serveru. Kdyby si plátno stavělo svět po svém, kreslilo by něco jiného, než
 * co verifikátor prohlásil za platné.
 *
 * Odmítnutá emise nevrací svět a je to normální stav, ne výjimka: kanál dorazí
 * s verdiktem `REJECTED` a plátno zůstane na layoutu z kitu.
 */
function worldFromVerdict(result: unknown): WorldDocRuntime | null {
  const doc = (result as { doc?: { sim?: unknown } | null } | null)?.doc;
  if (doc === null || doc === undefined) return null;

  const built = buildRuntimeWorld(doc.sim);
  return built.ok ? built.world : null;
}

export default function Viewer({
  layouts,
  promptId = null,
  world = null,
}: {
  readonly layouts: readonly string[];
  /** Když je zadaný, viewer si vyžádá emisi a vypisuje její průběh. */
  readonly promptId?: string | null;
  /**
   * Hotový běhový svět. Má přednost před emisí — tudy vede produktová cesta
   * z T5, kde svět přijde z `/api/generate`, ne ze zmrazeného korpusu.
   */
  readonly world?: WorldDocRuntime | null;
}) {
  const [index, setIndex] = useState(0);
  const [progress, setProgress] = useState<readonly EmitProgress[]>([]);
  const [emitted, setEmitted] = useState<WorldDocRuntime | null>(null);
  const runnerRef = useRef<WorldRunner | null>(null);

  const switchTo = useCallback(
    (next: number) => setIndex(((next % layouts.length) + layouts.length) % layouts.length),
    [layouts.length],
  );

  useEffect(() => {
    if (promptId === null) return;
    const abort = new AbortController();
    setProgress([]);
    setEmitted(null);
    streamEmission(promptId, {
      signal: abort.signal,
      onProgress: (step) => setProgress((seen) => [...seen, step]),
    })
      .then((stream) => setEmitted(worldFromVerdict(stream.result)))
      .catch(() => {
        // Přerušení odchodem ze stránky není stav k vykreslení. Vada emise je
        // verdikt, ne výjimka — ta jde v posledním rámci a čte ji volající.
      });
    return () => abort.abort();
  }, [promptId]);

  const active = world ?? emitted;

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <Canvas
        data-testid="viewer-canvas"
        gl={{ antialias: false, powerPreference: 'high-performance' }}
        camera={{ position: [7, 7, 9], fov: 45 }}
      >
        <ambientLight intensity={0.65} />
        <directionalLight position={[5, 8, 4]} intensity={1.3} />
        <Bridge onSwitch={switchTo} layouts={layouts} runnerRef={runnerRef} />
        {active === null ? (
          <World layoutId={layouts[index]} />
        ) : (
          <WorldScene world={active} runnerRef={runnerRef} />
        )}
        <FollowCamera runnerRef={runnerRef} />
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
