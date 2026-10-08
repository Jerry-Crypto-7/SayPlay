'use client';

/**
 * Plátno hlavní cesty — **hrubý svět z běžící relace na celé obrazovce**
 * (P15 `T21b` / `T47-t21bunblock`).
 *
 * Do 6. 9. 2026 kreslila úvodní stránka `Stage`, tedy starou herní scénu nad
 * `WorldDocRuntime`. Ta se přestěhovala na `/classic` a tohle je plátno
 * produktu: `WorldstreamStage` nad `ProxyWorld`, který si prohlížeč postavil
 * z blueprintu doručeného proudem relace.
 *
 * ## Proč vlastní soubor, a ne kus `page.tsx`
 *
 * `<Canvas>` sahá na `document` a WebGL2 kontext na serveru neexistuje, takže
 * se sem chodí přes `dynamic(..., { ssr: false })`. Je to totéž rozhodnutí,
 * jaké měla stará stránka u `Stage`, a ze stejného důvodu.
 *
 * ## Kamera se počítá ze světa, nekonstantuje se
 *
 * `/dev/worldstream` má kameru napsanou ručně (`DEMO_CAMERA`), protože staví
 * jediný známý dokument. Tady přijde svět, který nikdo nepředvídal — pevná
 * kamera by ho podle věty buď minula, nebo přiblížila na jeden roh. Rámuje ho
 * proto `frameScene()` ze **skutečných** kvádrů slotů, tedy z toho, co je na
 * scéně, ne z toho, co blueprint zamýšlel.
 */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Color, Fog, PerspectiveCamera } from 'three';

import WorldstreamLighting, {
  WORLDSTREAM_FOG,
  WORLDSTREAM_GL,
  WORLDSTREAM_KEY_LIGHT,
  WORLDSTREAM_SHADOWS,
} from '@/components/viewer/WorldstreamLighting';
import type { SceneEnvironment } from '@/scene/environment';
import { boundLookPreset, deriveLookPreset, type LookBinding, type LookDescriptor, type LookPreset } from '@/worldstream/look';
import WorldstreamStage from '@/components/viewer/WorldstreamStage';
import { PALETTES, type Palette } from '@/kit';
import { FRAMING_FOV, frameScene, safeAreaFromRects, type Bounds, type SafeArea } from '@/worldstream/framing';
import { applyDiagramProjection, frameDiagram } from '@/worldstream/diagram-framing';
import { readVariable, type RuntimeController, type RuntimeSnapshot } from '@/worldstream/runtime-controller';
import { CELL_SIZE } from '@/components/viewer/projection';
import type { ProxyWorld } from '@/worldstream/proxy';
import { budgetFor, type QualityTier } from '@/worldstream/quality';
import { guideStand, routeMarkers, type RouteMarker } from '@/worldstream/guide-answer';

/** Co o průvodci ví scéna: kde stojí a které zastávky kreslí. */
export interface GuideProbe {
  (): { readonly figure: readonly [number, number, number] | null; readonly stops: readonly string[] };
}

/**
 * Co o předvolbě vzhledu ví plátno: která platí, jak daleko tween došel a
 * **ze kterého stavu ji odvodilo** – tik, hash a vstupy, aby test mohl týž
 * běh přehrát v Node bez rendereru a porovnat hash.
 */
export interface LookProbe {
  (): {
    readonly preset: LookPreset | null;
    readonly settled: boolean;
    readonly tick: number;
    readonly stateHash: string;
    readonly inputs: readonly { readonly tick: number; readonly actor: string; readonly actionId: string; readonly target?: string }[];
  };
}

declare global {
  interface Window { __worldstreamGuide?: GuideProbe; __worldstreamLook?: LookProbe }
}

export interface SharedCamera {
  current: { eye: number[]; target: number[] } | null;
  listeners: Set<() => void>;
}

/**
 * Obal všech slotů, nebo `null` u prázdného světa.
 *
 * Bere `worldBounds`, ne `localBounds`: rámuje se to, kam objekt po transformu
 * doopravdy padne. `localBounds` je kvádr, ve kterém je podoba napsaná, a
 * u posunutého objektu ukazuje jinam, než kde ten objekt stojí.
 */
function worldExtent(world: ProxyWorld, state: RuntimeSnapshot | null): Bounds | null {
  if (world.kind !== 'built' || world.slots.length === 0) return null;

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { slot } of world.slots) {
    const entity = state?.entities.find(entry => entry.stableId === slot.stableId);
    const offset = entity ? [entity.dx * CELL_SIZE, 0, entity.dy * CELL_SIZE] : [0, 0, 0];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], slot.worldBounds.min[axis], slot.worldBounds.min[axis] + offset[axis]);
      max[axis] = Math.max(max[axis], slot.worldBounds.max[axis], slot.worldBounds.max[axis] + offset[axis]);
    }
  }
  return { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } };
}

/** Nejdůležitější slot je hrdina snímku. Při shodě rozhoduje pořadí blueprintu. */
function heroCenter(world: ProxyWorld): { x: number; y: number; z: number } | null {
  if (world.kind !== 'built' || world.slots.length === 0) return null;

  let best = world.slots[0].slot;
  for (const { slot } of world.slots) if (slot.importance > best.importance) best = slot;

  const { min, max } = best.worldBounds;
  return { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 };
}

/**
 * Kolik hran plátna kryje rozhraní, v podílu jeho rozměru.
 *
 * Na `/play` kryje plátno jen pás karet cílů mřížkové hry (P28C T4) u dolní
 * hrany: cíl pod ním by nešel klepnout. Boční panely měla jen skořápka starého
 * studia, která odešla 7. 10. 2026.
 *
 * **Měří se z DOM za běhu**, protože pás roste s počtem cílů a pod 760 px se
 * zalamuje.
 */
function measureSafeArea(canvas: HTMLCanvasElement): SafeArea {
  const box = (selector: string): DOMRect | null =>
    document.querySelector(selector)?.getBoundingClientRect() ?? null;

  // Sbírá se tady, počítá se ve `framing.ts`. Rozdíl hran, který tu stál do
  // 16. 9. 2026, přestal platit ve chvíli, kdy T2 zmenšila samo plátno — celý
  // ten příběh je u `safeAreaFromRects()`.
  return safeAreaFromRects(canvas.getBoundingClientRect(), {
    bottom: box('.play-targets'),
    left: null,
    right: null,
  });
}

/**
 * Posadí kameru tak, aby se svět vešel do snímku.
 *
 * Uvnitř plátna, ne v `<Canvas camera>`: prop `camera` platí jen při vzniku
 * plátna a svět přichází o vteřiny později. Automatické rámování proběhne
 * pro novou session/source identitu a na výslovný reset. Editace, pohyb
 * návštěvníka i doplnění detailu zachovají ruční pohled.
 */
function FrameCamera({ world, controller, sceneId, reset, framing, sharedCamera, focusId }: { readonly world: ProxyWorld | null;
  readonly controller: RuntimeController | null; readonly sceneId: string | null; readonly reset: number;
  readonly framing: 'scene' | 'diagram'; readonly sharedCamera?: SharedCamera; readonly focusId?: string | null }) {
  const camera = useThree((state) => state.camera);
  const canvas = useThree((state) => state.gl.domElement);
  const size = useThree((state) => state.size);
  const controls = useMemo(() => new OrbitControls(camera), [camera]);
  const framed = useRef<{ sceneId: string | null; reset: number; framing: 'scene' | 'diagram'; focusId?: string | null } | null>(null);

  useEffect(() => {
    if (!sharedCamera) return;
    let receiving = false;
    const receive = () => {
      if (!sharedCamera.current) return;
      receiving = true;
      camera.position.fromArray(sharedCamera.current.eye);
      controls.target.fromArray(sharedCamera.current.target);
      controls.update(); receiving = false;
    };
    const publish = () => {
      if (receiving) return;
      sharedCamera.current = { eye: camera.position.toArray(), target: controls.target.toArray() };
      for (const listener of sharedCamera.listeners) if (listener !== receive) listener();
    };
    sharedCamera.listeners.add(receive); receive();
    controls.addEventListener('change', publish);
    return () => { sharedCamera.listeners.delete(receive); controls.removeEventListener('change', publish); };
  }, [camera, controls, sharedCamera]);

  useEffect(() => {
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Scene camera: drag to orbit, scroll to zoom, arrow keys to pan');
    controls.connect(canvas);
    controls.listenToKeyEvents(canvas);
    controls.minDistance = 0.5;
    controls.maxPolarAngle = Math.PI / 2 - 0.01;
    const focus = () => canvas.focus({ preventScroll: true });
    canvas.addEventListener('pointerdown', focus);
    return () => { canvas.removeEventListener('pointerdown', focus); controls.dispose(); };
  }, [canvas, controls]);

  useEffect(() => {
    if (camera instanceof PerspectiveCamera)
      applyDiagramProjection(camera, size.width, size.height, framing === 'diagram');
  }, [camera, framing, size.width, size.height]);

  useEffect(() => {
    if (world === null) { framed.current = null; return; }
    if (framed.current?.sceneId === sceneId && framed.current.reset === reset && framed.current.framing === framing && framed.current.focusId === focusId) return;
    const focused = world.kind === 'built' && focusId ? {...world, slots: world.slots.filter(entry => entry.slot.stableId === focusId)} : world;
    const bounds = worldExtent(focused, controller?.getSnapshot() ?? null);
    if (bounds === null) return;
    const view = framing === 'diagram' ? frameDiagram(bounds, size.width / size.height) : frameScene({
      bounds,
      hero: heroCenter(focused),
      ...(world.kind === 'built' && world.environment?.kind === 'interior' ? {pitch: Math.PI * 0.27, heroHeight: 0.5} : {}),
      aspect: size.width / size.height,
      fov: FRAMING_FOV,
      // Měří se tady, ne v `frameScene`: rámování musí zůstat čistá funkce.
      // Změna zásuvky pohledem nehne schválně — přerámovat pod rukou někomu,
      // kdo si scénu zrovna otočil, je horší vada než hrdina o kus níž.
      safeArea: measureSafeArea(canvas),
    });
    camera.position.set(view.eye.x, view.eye.y, view.eye.z);
    controls.target.set(view.target.x, view.target.y, view.target.z);
    controls.update();
    camera.updateProjectionMatrix();
    framed.current = { sceneId, reset, framing, focusId };
  }, [world, controller, sceneId, reset, framing, focusId, camera, controls, size.height, size.width]);

  return null;
}

/**
 * Zvýraznění cesty, kterou průvodce našel (P21 T13).
 *
 * Kreslí se **prstenec na zemi kolem každé zastávky**, ne obarvený objekt:
 * materiál slotu nese podobu, kterou napsal model, a přebarvit ji kvůli
 * odpovědi by z ní udělalo něco jiného, než co ten svět je. Prstenec leží
 * mimo hashovaný stav — je to vykreslení, ne událost simulace.
 *
 * Jantarová, ne fialová: viz `rules/design-output.md`.
 */
function RouteRings({ markers }: { readonly markers: readonly RouteMarker[] }) {
  if (markers.length === 0) return null;

  return (
    <group name="guide-route">
      {markers.map((marker) => (
        <mesh
          key={marker.stableId}
          position={[marker.at[0], marker.at[1] + 0.02, marker.at[2]]}
          rotation={[-Math.PI / 2, 0, 0]}
          renderOrder={2}
        >
          <ringGeometry args={[marker.radius * 1.08, marker.radius * 1.3, 48]} />
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.85} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Postava průvodce ve scéně (P21 T14).
 *
 * Je to **schválně figura, ne portrét**: tvary ve světě píše model a tahle
 * postava je jediné, co do scény přidává produkt sám. Kdyby si hrála na
 * obyvatele toho světa, tvrdila by o něm něco, co v žádné emisi nestojí.
 *
 * Tyrkysová, ne jantarová: prstence cesty jsou jantarové a průvodce má být na
 * první pohled něco jiného než zastávka. A nikdy ne fialová — `design-output`.
 */
function GuideFigure({ at }: { readonly at: readonly [number, number, number] }) {
  return (
    <group name="guide-figure" position={[at[0], at[1], at[2]]}>
      <mesh position={[0, 0.57, 0]} castShadow>
        <capsuleGeometry args={[0.22, 0.7, 4, 12]} />
        <meshStandardMaterial color="#2dd4bf" roughness={0.55} />
      </mesh>
      <mesh position={[0, 1.28, 0]} castShadow>
        <sphereGeometry args={[0.18, 16, 12]} />
        <meshStandardMaterial color="#99f6e4" roughness={0.6} />
      </mesh>
    </group>
  );
}

/**
 * Popis vzhledu, který plátno hlavní cesty **doopravdy kreslí** – ne odvození
 * z palety, které patří `/embed`. Hlavní plátno má pozadí a mlhu ze
 * `SceneEnvironment` a klíčové světlo z `WorldstreamLighting`; tenhle popis
 * je tatáž scéna zapsaná jako `LookDescriptor`, aby se na ní daly odvodit
 * předvolby stejnou funkcí jako všude jinde. Svět bez vazeb ho nikdy nečte,
 * takže dnešní snímky se nehnou ani o pixel.
 */
function lookOfEnvironment(environment: SceneEnvironment | undefined): LookDescriptor {
  const background = environment?.background ?? WORLDSTREAM_FOG.color;
  const [x, y, z] = WORLDSTREAM_KEY_LIGHT.position;
  const length = Math.hypot(x, y, z);
  return {
    palette: 'harbor',
    sky: { color: background, height: 0.5 },
    water: { present: false, color: background },
    ground: { present: false, color: background },
    // Hustota 0,5 je střed rozpočtu: předvolba ji násobí a plátno z poměru
    // odvozuje, o kolik se přiblíží konec mlhy. Hodnota sama nic nekreslí.
    fog: { density: 0.5, color: background },
    key: { direction: [x / length, y / length, z / length], temperature: environment?.night ? 7800 : 5600 },
    rim: 0.6,
    exposure: WORLDSTREAM_GL.toneMappingExposure,
    dust: 0,
  };
}

/** Časová konstanta tweenu v sekundách. Bouře se stáhne za necelé dvě, ne skokem. */
const LOOK_TWEEN_TAU = 0.45;
/** Pod tímhle zbytkem se tween hlásí jako usazený. */
const LOOK_SETTLED = 0.01;

/**
 * Plynulý přechod mezi předvolbami vzhledu podle proměnné světa (P22 T12).
 *
 * **Mimo hash, schválně a celý.** Tween běží na snímcích (`useFrame`,
 * nástěnný čas), ne na tiku simulace, a data tečou jedním směrem: snímek běhu
 * → `readVariable()` → předvolba → barvy na scéně. Nic z toho, co tween
 * spočítá, se nikam do stavu nevrací – `RuntimeController` o téhle komponentě
 * neví a `look-binding.spec.ts` to drží rovností hashe s rendererem a bez něj.
 *
 * Kreslí se **do objektů, které už na scéně jsou** (`scene.fog`,
 * `scene.background` z `WorldstreamLighting`, `gl.toneMappingExposure`),
 * ne vedle nich: druhá mlha nebo druhé pozadí by se s těmi prvními přetahovaly
 * o snímek. Když `WorldstreamLighting` objekty vymění (nový svět), tween
 * pokračuje z toho, co najde, což je přesně základ.
 */
function LookTransition({ bindings, environment, controller }: { readonly bindings: readonly LookBinding[];
  readonly environment: SceneEnvironment | undefined; readonly controller: RuntimeController | null }) {
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty, controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const base = useMemo(() => lookOfEnvironment(environment), [environment]);
  const preset = state === null ? null : boundLookPreset(bindings, (variable) => readVariable(state, variable));
  const target = useMemo(() => (preset === null ? base : deriveLookPreset(base, preset)), [base, preset]);
  const current = useRef({ sky: new Color(base.sky.color), fog: new Color(base.fog.color), far: WORLDSTREAM_FOG.far, exposure: base.exposure });
  const remaining = useRef(0);

  useFrame((_, delta) => {
    const goalSky = new Color(target.sky.color);
    const goalFog = new Color(target.fog.color);
    const goalFar = WORLDSTREAM_FOG.far * (base.fog.density / target.fog.density);
    const goalExposure = WORLDSTREAM_GL.toneMappingExposure * (target.exposure / base.exposure);
    const k = 1 - Math.exp(-Math.min(delta, 0.1) / LOOK_TWEEN_TAU);
    const now = current.current;
    now.sky.lerp(goalSky, k);
    now.fog.lerp(goalFog, k);
    now.far += (goalFar - now.far) * k;
    now.exposure += (goalExposure - now.exposure) * k;
    remaining.current = Math.max(
      Math.abs(now.sky.r - goalSky.r), Math.abs(now.sky.g - goalSky.g), Math.abs(now.sky.b - goalSky.b),
      Math.abs(now.far - goalFar) / WORLDSTREAM_FOG.far, Math.abs(now.exposure - goalExposure));

    if (scene.background instanceof Color) scene.background.copy(now.sky);
    else scene.background = now.sky.clone();
    if (scene.fog instanceof Fog) { scene.fog.color.copy(now.fog); scene.fog.far = now.far; }
    gl.toneMappingExposure = now.exposure;
  });

  // Renderer i mlha přežijí nový svět (plátno nemá `key`), a nikdo jiný
  // expozici ani dosah mlhy nepíše – po odpojení tweenu se proto vrací
  // na základ, jinak by svět bez vazeb zůstal potmě po bouři.
  useEffect(() => () => {
    gl.toneMappingExposure = WORLDSTREAM_GL.toneMappingExposure;
    if (scene.fog instanceof Fog) scene.fog.far = WORLDSTREAM_FOG.far;
  }, [gl, scene]);

  useEffect(() => {
    const probe: LookProbe = () => {
      const snapshot = controller?.getSnapshot() ?? null;
      return { preset, settled: remaining.current < LOOK_SETTLED, tick: snapshot?.tick ?? 0, stateHash: snapshot?.stateHash ?? '',
        inputs: controller?.getInputLog().map((input) => ({ ...input })) ?? [] };
    };
    window.__worldstreamLook = probe;
    return () => { if (window.__worldstreamLook === probe) delete window.__worldstreamLook; };
  }, [controller, preset]);

  return null;
}

export default function WorldstreamCanvas({ world, controller = null, sceneId = null, reset = 0, framing = 'scene', onPresented, sharedCamera, adaptiveAssets, focusId,cutaway=true, routeHighlight, guide = true, ground, children }: {
  readonly world: ProxyWorld | null;
  readonly controller?: RuntimeController | null;
  readonly sceneId?: string | null;
  readonly reset?: number;
  readonly framing?: 'scene' | 'diagram';
  readonly onPresented?: (world: ProxyWorld) => void;
  readonly sharedCamera?: SharedCamera;
  readonly adaptiveAssets?: boolean;
  readonly focusId?: string | null;
  readonly cutaway?:boolean;
  /** Zastávky cesty od průvodce, v jejím pořadí. Prázdné pole nekreslí nic. */
  readonly routeHighlight?: readonly string[];
  /** Figura průvodce. PLAY ji vypíná: vedle hráčovy postavy čte jako druhý hrdina (QA 22. 9. 2026). */
  readonly guide?: boolean;
  /**
   * Barva rovné země pod hrou (slot `sand` palety). PLAY ji bere z prostředí věty
   * (P30B T6); bez ní béžová přístavu, kterou porota viděla i na Marsu.
   */
  readonly ground?: string;
  /** Vrstvy navíc uvnitř scény – PLAY tu kreslí výhled stráže a přání zákazníků (P25E). */
  readonly children?: ReactNode;
}) {
  // Úroveň se čte ze **světa**, ne z volajícího: kdo svět dostane, ví, proti
  // jakému rozpočtu se má soudit (`proxy.ts`). Prázdné plátno kreslí `full`,
  // protože nekreslí nic.
  const quality: QualityTier = world?.kind === 'built' ? world.quality : 'full';

  const stand = useMemo(() => (world === null || !guide ? null : guideStand(world)), [world, guide]);
  const markers = useMemo(() => (world === null ? [] : routeMarkers(world, routeHighlight ?? [])), [world, routeHighlight]);
  // Jedna paleta na barvu: scéna přebarvuje všechno, když dostane jiný objekt.
  const palette = useMemo(() => (ground === undefined ? undefined : { ...PALETTES.harbor, sand: ground }), [ground]);
  // Sonda pro e2e, stejným způsobem jako `__worldstreamStage`. Ptá se na to,
  // co se z obrázku plátna přečíst nedá: **stojí tu postava a které zastávky
  // scéna doopravdy zvýraznila** — zvýraznit jde jen slot, který má hmotu,
  // takže odpověď průvodce a nakreslené prstence nejsou totéž.
  useEffect(() => {
    window.__worldstreamGuide = () => ({ figure: stand, stops: markers.map((marker) => marker.stableId) });
    return () => { delete window.__worldstreamGuide; };
  }, [stand, markers]);

  return (
    <Canvas
      data-testid="worldstream-canvas"
      gl={{ ...WORLDSTREAM_GL }}
      shadows={WORLDSTREAM_SHADOWS}
      camera={{ position: [17, 12, 21], fov: FRAMING_FOV }}
      // Rozsah, ne jedno číslo — viz `/dev/worldstream`: rozpočet úrovně je
      // horní mez, ne příkaz vykreslovat na ni i na stroji, který ji nemá.
      dpr={[1, budgetFor(quality).pixelRatio]}
    >
      <WorldstreamLighting quality={quality} environment={world?.kind === 'built' ? world.environment : undefined} />
      {world?.kind === 'built' && world.lookBindings !== undefined && world.lookBindings.length > 0 &&
        <LookTransition bindings={world.lookBindings} environment={world.environment} controller={controller} />}
      <FrameCamera world={world} controller={controller} sceneId={sceneId} reset={reset} framing={framing} sharedCamera={sharedCamera} focusId={focusId} />
      {world !== null && world.kind === 'built' && <RuntimeStage key={sceneId} world={world} controller={controller} onPresented={onPresented} adaptiveAssets={adaptiveAssets} cutaway={cutaway} palette={palette} />}
      {stand !== null && <GuideFigure at={stand} />}
      <RouteRings markers={markers} />
      {children}
    </Canvas>
  );
}

const subscribeEmpty = () => () => {};
const emptySnapshot = () => null;

function RuntimeStage({ world, controller, onPresented, adaptiveAssets,cutaway, palette }: { readonly world: ProxyWorld; readonly controller: RuntimeController | null;
  readonly onPresented?: (world: ProxyWorld) => void; readonly adaptiveAssets?: boolean;readonly cutaway?:boolean; readonly palette?: Palette }) {
  const state = useSyncExternalStore(controller?.subscribe ?? subscribeEmpty,
    controller?.getSnapshot ?? emptySnapshot, emptySnapshot);
  return <WorldstreamStage world={world} runtimeState={state} onPresented={onPresented} adaptiveAssets={adaptiveAssets} cutaway={cutaway} palette={palette} />;
}
