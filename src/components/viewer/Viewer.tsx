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
 * Světlo, stíny, mlha a tone mapping jsou od T6 v `Lighting.tsx` — jeden rig
 * pro tohle plátno i pro `Stage.tsx`, protože dvě kopie znamenají dvě místa,
 * kde se vzhled rozejde.
 *
 * Na `src/fallback/**` se odsud nesahá a hlídá to test — fallback je samostatný
 * artefakt, který se musí dát postavit bez jádra i bez tohohle plátna.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Fog, Light, Mesh, MeshToonMaterial, type Group } from 'three';

import { buildRuntimeWorld } from '@/ir/build';
import { buildLayoutScene, layoutById } from '@/kit';
import type { RunState, WorldDocRuntime } from '@/sim/interpreter';

import type { AssemblySnapshot } from './Assembly';
import { disposeSubtree } from './dispose';
import FollowCamera from './FollowCamera';
import Lighting, { VIEWER_GL, VIEWER_SHADOWS, toonRamp } from './Lighting';
import type { ProjectedEntity } from './projection';
import { streamEmission, type EmitProgress } from './sse';
import WorldScene, {
  type DressingBatch,
  type RunnerRef,
  type SceneryReport,
  type WorldRunner,
} from './WorldScene';

/** Změřený stav rendereru. Čte `e2e/render-quality.spec.ts`, plní `Bridge` níž. */
export interface RenderStats {
  readonly toneMapping: number;
  readonly toneMappingExposure: number;
  readonly shadowMapEnabled: boolean;
  readonly shadowMapType: number;
  /** Skutečný atribut kontextu, ne to, co si plátno vyžádalo. */
  readonly antialias: boolean;
  readonly fog: { readonly color: string; readonly near: number; readonly far: number } | null;
  /** Kreslicí volání posledního snímku, včetně stínového průchodu. */
  readonly calls: number;
  readonly triangles: number;
  readonly lights: number;
}

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
      /**
       * Co plátno naposledy nakreslilo. Mezi dvěma tiky to není totéž co
       * `entities()`: simulace stojí na celých polích, kreslení mezi nimi
       * dopočítává. Jediná cesta, jak se z prohlížeče zeptat, jestli se
       * mezipolohy opravdu kreslí, nebo se svět jen dvacetkrát za sekundu
       * překlápí o celé pole.
       */
      drawn: () => readonly ProjectedEntity[];
      /**
       * Co scéna postavila z kitu — jedna položka na id kusu, s počtem instancí,
       * které dávka právě kreslí. Ze zdrojáku se to spočítat nedá: co kde stojí
       * rozhoduje semínko odvozené z konkrétního světa.
       */
      dressing: () => readonly DressingBatch[];
      /** Co postavila kulisa z programu geometrie — rodina a její cena ve snímku. */
      scenery: () => SceneryReport;
      /** Kolik tiků svět odkrokoval. */
      tick: () => number;
      /**
       * Jak daleko je stavba světa (`Assembly.tsx`). `firstRevealTick` a
       * `lastRevealTick` scéna **pozoruje za běhu**, takže se z prohlížeče dá
       * poznat rozvrh, který stavbu jen předstírá a odhalí všechno naráz.
       * Prázdné plátno vrací nulový snímek, ne `undefined`.
       */
      assembly: () => AssemblySnapshot;
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
      /**
       * Co renderer doopravdy dostal a co za poslední snímek udělal.
       *
       * Jediná cesta, jak se z prohlížeče zeptat na vlastnosti, které nejde
       * odvodit ze zdrojáku: `antialias` je atribut kontextu a ovladač ho může
       * odmítnout, `calls` a `triangles` sčítají i stínový průchod, který ve
       * scéně vidět není. Rozpočet se tedy měří, ne dopočítává.
       */
      render: () => RenderStats;
    };
  }
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
    // Stíny se zapínají tady, ne v kitu: `src/kit/**` se staví i ve stromu
    // fallbacku, který žádný stínový průchod nemá. Bez tohohle nevrhal v layoutu
    // stín ani jeden kus — naměřeno na snímku, kde deska mola byla úplně čistá.
    if (object instanceof Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
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
  const scene = useThree((state) => state.scene);
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
      drawn: () => runnerRef.current?.drawn() ?? [],
      dressing: () => runnerRef.current?.dressing() ?? [],
      scenery: () =>
        runnerRef.current?.scenery() ?? { family: '', drawCalls: 0, triangles: 0, attached: false },
      tick: () => runnerRef.current?.tick() ?? 0,
      assembly: () =>
        runnerRef.current?.assembly() ?? {
          revealed: 0,
          total: 0,
          firstRevealTick: null,
          lastRevealTick: null,
          plannedSpanTicks: 0,
          done: false,
          reducedMotion: false,
        },
      camera: () => ({ x: camera.position.x, y: camera.position.y, z: camera.position.z }),
      step: (count: number) => runnerRef.current?.step(count),
      runState: () => runnerRef.current?.runState() ?? null,
      render: () => {
        let lights = 0;
        scene.traverse((node) => {
          if (node instanceof Light) lights += 1;
        });
        const fog = scene.fog;
        return {
          toneMapping: gl.toneMapping,
          toneMappingExposure: gl.toneMappingExposure,
          shadowMapEnabled: gl.shadowMap.enabled,
          shadowMapType: gl.shadowMap.type,
          // `getContextAttributes()` vrací, co kontext OPRAVDU má. Vyžádaná
          // hodnota z `VIEWER_GL` by tvrdila jen to, co jsme napsali do kódu.
          antialias: gl.getContext().getContextAttributes()?.antialias === true,
          fog:
            fog instanceof Fog
              ? { color: `#${fog.color.getHexString()}`, near: fog.near, far: fog.far }
              : null,
          calls: gl.info.render.calls,
          triangles: gl.info.render.triangles,
          lights,
        };
      },
    };
    return () => {
      delete window.__viewer;
    };
  }, [gl, camera, scene, onSwitch, layouts, runnerRef]);

  return null;
}

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
function worldFromVerdict(result: unknown): { world: WorldDocRuntime; look: unknown } | null {
  const doc = (result as { doc?: { sim?: unknown; look?: unknown } | null } | null)?.doc;
  if (doc === null || doc === undefined) return null;

  const built = buildRuntimeWorld(doc.sim);
  // `look` cestuje spolu se světem, ne vedle něj: kulisa se vybírá z něj a dva
  // stavy by šly rozejít na jednu emisi navíc.
  return built.ok ? { world: built.world, look: doc.look ?? null } : null;
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
  const [emitted, setEmitted] = useState<{ world: WorldDocRuntime; look: unknown } | null>(null);
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

  // Hotový svět z prop má přednost před emisí, a `look` ho následuje: prop ho
  // nenese, takže tou cestou rozhodne semínko světa — stejně jako do vlny 3.
  const active = world ?? emitted?.world ?? null;
  const activeLook = world === null ? (emitted?.look ?? null) : null;

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <Canvas
        data-testid="viewer-canvas"
        shadows={VIEWER_SHADOWS}
        gl={VIEWER_GL}
        camera={{ position: [7, 7, 9], fov: 45 }}
      >
        <Lighting />
        <Bridge onSwitch={switchTo} layouts={layouts} runnerRef={runnerRef} />
        {active === null ? (
          <World layoutId={layouts[index]} />
        ) : (
          <WorldScene world={active} look={activeLook} runnerRef={runnerRef} />
        )}
        <FollowCamera runnerRef={runnerRef} />
      </Canvas>
      {progress.length === 0 ? null : (
        <ul className="ws-progress" data-testid="viewer-progress">
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
