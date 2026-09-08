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

import { chooseFamily } from '@/geom/family-choice';
import { familyById } from '@/geom/families';
import { buildRuntimeWorld } from '@/ir/build';
import { canonicalHash } from '@/ir/worlddoc';
import { buildLayoutScene, layoutById } from '@/kit';
import type { RunState, WorldDocRuntime } from '@/sim/interpreter';
import { FRAMING_FOV } from '@/worldstream/framing';
import { deriveLook, terrainOfProgram, type LookDescriptor } from '@/worldstream/look';
import { repairLook, type LookFloor } from '@/worldstream/look-repair';

import type { AssemblySnapshot } from './Assembly';
import { Atmosphere, SKY_NAME, WATER_NAME } from './Atmosphere';
import { disposeSubtree } from './dispose';
import { dressingSeed } from './dressing';
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
      /**
       * Vzhled, který scéna doopravdy kreslí, i s tím, co na něm opravila
       * podlaha z `look-repair.ts`.
       *
       * Bez tohohle je oprava neviditelná: opravený vzhled vypadá jako
       * odvozený a nedá se z prohlížeče poznat, jestli se něco stalo, nebo
       * jestli podlaha jen nic nedělá. `repairs` nese u každé změny vlastnost,
       * cestu, obě hodnoty i důvod — je to ten zápis, na kterém stojí Inspect.
       */
      look: () => LookFloor;
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
      /**
       * Co plátno **doopravdy nakreslilo**, po pixelech.
       *
       * Jediná cesta, jak se z prohlížeče zeptat, jestli má obraz tmy, středy
       * i světla — a jediná, kterou umí soudit `src/worldstream/image-judge.ts`.
       * Ze zdrojáku se to spočítat nedá vůbec: rozhoduje o tom shader oblohy,
       * mlha, tone mapping i to, kde zrovna stojí kamera.
       *
       * **Vrací slib, ne obraz**, a to je celý vtip: odečet čeká na nejbližší
       * snímek a proběhne uvnitř něj. Kreslicí buffer se po složení stránky
       * zahazuje (`preserveDrawingBuffer` je vypnutý), takže čtení mimo snímek
       * vrací poslední složený obraz a vlastní vykreslení do něj nedosáhne —
       * měření by tiše vracelo pořád totéž. Podrobnosti u implementace.
       *
       * Součástí odečtu jsou `sky` a `water`: podíly plochy, které maluje
       * obloha a hladina. Uvnitř jednoho snímku se čte třikrát, pokaždé s jednou
       * z nich schovanou, a pixely, které se mezi čteními změnily, JSOU ta věc —
       * přesně, ne odhadem podle barvy, který by u mrazivé palety tvrdil, že
       * obloha je celý obraz. **Na hladinu jiná cesta nevede:** v počtu
       * kreslicích volání ji přebije rozdíl geometrie mezi dvěma layouty.
       *
       * Řádky se otáčejí: WebGL má počátek vlevo **dole**, `getImageData`
       * i obrazový soudce vlevo nahoře. Bez otočení by „obloha je nahoře"
       * znamenalo pokaždé něco jiného.
       */
      pixels: (options?: { scale?: number }) => Promise<{
        data: number[];
        width: number;
        height: number;
        /** Podíl plochy, který maluje obloha, 0–1. Měřeno, ne odhadnuto. */
        sky: number;
        /** Podíl plochy, který maluje hladina, 0–1. Nula znamená, že se nekreslí. */
        water: number;
      }>;
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

/**
 * Vzhled toho, co plátno právě drží.
 *
 * Dvě cesty, jeden popis. Postavený svět má rodinu, kterou vybrala věta
 * (`chooseFamily`), a ta nese paletu i terén; ručně skládaný layout nese paletu
 * přímo a terén nemá, takže stojí na rovině.
 *
 * **`chooseFamily` se tu volá podruhé — vědomě.** Poprvé ho volá `WorldScene`,
 * aby postavil kulisu. Je to čistá funkce nad týmiž dvěma vstupy, takže obě
 * volání vrátí totéž a rozejít se nemůžou; alternativa by byla protáhnout
 * rozhodnutí přes signaturu `WorldScene`, tedy přepsat komponentu, která se
 * v téhle úloze jinak vůbec nemění.
 *
 * Semínko atmosféry je hash toho, co plátno drží. Prach se tak rozsype pro týž
 * svět pokaždé stejně a pro dva různé jinak — bez toho by dva světy vedle sebe
 * měly zrnko po zrnku tentýž vzduch.
 */
function atmosphereOf(
  world: WorldDocRuntime | null,
  look: unknown,
  layoutId: string,
): { look: LookDescriptor; seed: number } {
  if (world === null) {
    const layout = layoutById(layoutId);
    const seed = seedFrom(layoutId);
    return {
      look: deriveLook({ palette: layout?.palette ?? 'harbor', terrain: 'flat', seed }),
      seed,
    };
  }

  const seed = dressingSeed(world);
  const family = familyById(chooseFamily(look, seed));
  if (family === undefined) {
    // Neznámá rodina je vada výběru, ne stav k vykreslení — `buildScenery` na
    // ni reaguje prázdnou kulisou a atmosféra stejně tak: svět dostane počasí,
    // jen ne to svoje.
    return { look: deriveLook({ palette: 'harbor', terrain: 'flat', seed }), seed };
  }

  return {
    look: deriveLook({
      palette: family.palette,
      terrain: terrainOfProgram(family.compose(seed)),
      seed,
    }),
    seed,
  };
}

/** Semínko z řetězce. Tatáž hashovací rodina jako stav světa, ne druhá. */
function seedFrom(text: string): number {
  return Number.parseInt(canonicalHash(text), 16) & 0x7fff_ffff;
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
  floor,
}: {
  onSwitch: (index: number) => void;
  layouts: readonly string[];
  runnerRef: RunnerRef;
  floor: LookFloor;
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
      look: () => floor,
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
      pixels: (options = {}) =>
      new Promise((resolve) => {
        // **Odečet musí proběhnout uvnitř snímku, ne mezi snímky.** Kreslicí
        // buffer se po složení stránky zahazuje (`preserveDrawingBuffer` je
        // vypnutý a zapínat ho kvůli měření by zdražilo produkt), takže
        // `readPixels` zavolaný mimo `requestAnimationFrame` vrací poslední
        // **složený** snímek a vlastní `render()` do něj nedosáhne vůbec.
        //
        // Naměřeno 28. 8. 2026: pět čtení za sebou, mezi nimi schovaná obloha,
        // vrátilo pětkrát bajt po bajtu tentýž obraz — a přitom v `info.render`
        // ubylo přesně jedno kreslicí volání. Kreslilo se tedy správně a četlo
        // se něco jiného. Callback zaregistrovaný tady běží až po tom, který si
        // R3F zaregistroval při připojení, tedy po vykreslení snímku a před
        // jeho složením — a to je jediné místo, kde je buffer platný.
        requestAnimationFrame(() => {
          const pixelCount = gl.domElement.width * gl.domElement.height;

          const grab = (hide?: string): Uint8Array => {
            const hidden = hide === undefined ? undefined : scene.getObjectByName(hide);
            if (hidden !== undefined) hidden.visible = false;
            gl.render(scene, camera);
            if (hidden !== undefined) hidden.visible = true;

            const context = gl.getContext();
            const buffer = new Uint8Array(pixelCount * 4);
            context.readPixels(
              0,
              0,
              gl.domElement.width,
              gl.domElement.height,
              context.RGBA,
              context.UNSIGNED_BYTE,
              buffer,
            );
            return buffer;
          };

          // Účetnictví rendereru se vrací tam, kde bylo. Bez toho by `render()`
          // popisoval měřicí průchod místo snímku produktu: každé čtení přidá
          // celou scénu k počítadlu a rozpočet kreslicích volání pak měří,
          // kolikrát se měřilo — naměřeno 219 místo 74.
          const accounting = { ...gl.info.render };
          const full = grab();
          // **Všechna čtení v jednom snímku, ne ve třech.** Prach se snáší
          // a hladina se vlní z `useFrame`, který mezi vykresleními uvnitř
          // jednoho callbacku neběží. Dva snímky by se lišily i animací, a ta by
          // se do podílu oblohy započítala jako obloha.
          const withoutSky = grab(SKY_NAME);
          const withoutWater = grab(WATER_NAME);
          Object.assign(gl.info.render, accounting);

          // Podíly se počítají **v plném rozlišení a tady**, ne z vráceného
          // náhledu: pixely, které se mezi čteními změnily, JSOU ta schovaná
          // věc. Odhad podle barvy by u mrazivé palety tvrdil, že obloha je
          // celý obraz, a hladinu by od mokré dlažby neodlišil vůbec.
          const share = (without: Uint8Array): number => {
            let painted = 0;
            for (let at = 0; at < full.length; at += 4) {
              if (
                full[at] !== without[at] ||
                full[at + 1] !== without[at + 1] ||
                full[at + 2] !== without[at + 2] ||
                full[at + 3] !== without[at + 3]
              ) {
                painted += 1;
              }
            }
            return painted / pixelCount;
          };

          // Podvzorkuje se nejbližším sousedem, protože průměr by hrany
          // rozmazal a soudce měří právě je. Celý snímek by se přes ladicí
          // protokol přenášel jednotky sekund; 480 pixelů na šířku stačí na
          // pásma jasu, odstíny i hrany a přenese se okamžitě.
          const scale = Math.min(1, (options.scale ?? 480) / gl.domElement.width);
          const width = Math.max(1, Math.round(gl.domElement.width * scale));
          const height = Math.max(1, Math.round(gl.domElement.height * scale));
          const data = new Array<number>(width * height * 4);
          for (let y = 0; y < height; y += 1) {
            // Otočení řádků: `gl.readPixels` čte odspodu.
            const source =
              gl.domElement.height - 1 - Math.floor((y / height) * gl.domElement.height);
            for (let x = 0; x < width; x += 1) {
              const from =
                (source * gl.domElement.width + Math.floor((x / width) * gl.domElement.width)) * 4;
              const to = (y * width + x) * 4;
              data[to] = full[from];
              data[to + 1] = full[from + 1];
              data[to + 2] = full[from + 2];
              data[to + 3] = full[from + 3];
            }
          }

          resolve({ data, width, height, sky: share(withoutSky), water: share(withoutWater) });
        });
      }),
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
  }, [gl, camera, scene, onSwitch, layouts, runnerRef, floor]);

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

  /**
   * Odvozený vzhled projde **podlahou** dřív, než se z něj něco nakreslí.
   *
   * Pořadí je záměr: `deriveLook` umí vrátit vzhled, ze kterého vyjde plochý
   * obraz — naměřeno na kontaktním listu, kde dva světy z dvanácti propadly
   * prahu odstínů. `repairLook` je čistá a idempotentní, takže tenhle průchod
   * nic nestojí u světa, kterému nic nechybí, a u ostatních je to jediné místo,
   * kde se to dá spravit dřív, než to porotce uvidí.
   */
  const atmosphere = useMemo(() => {
    const derived = atmosphereOf(active, activeLook, layouts[index]);
    return { floor: repairLook(derived.look), seed: derived.seed };
  }, [active, activeLook, layouts, index]);

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <Canvas
        data-testid="viewer-canvas"
        shadows={VIEWER_SHADOWS}
        gl={VIEWER_GL}
        camera={{ position: [7, 7, 9], fov: FRAMING_FOV }}
      >
        <Lighting look={atmosphere.floor.look} />
        <Atmosphere look={atmosphere.floor.look} seed={atmosphere.seed} />
        <Bridge
          onSwitch={switchTo}
          layouts={layouts}
          runnerRef={runnerRef}
          floor={atmosphere.floor}
        />
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
