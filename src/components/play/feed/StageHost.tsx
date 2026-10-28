'use client';

/**
 * Jedno trvalé plátno feedu (P54A T5, tunel v `stage-tunnel.ts`). `StageHost`
 * drží R3F `<Canvas>` po celou dobu feedu a dětem dá hostitele; `ArcadeStage`
 * s `host` vykreslí scénu do něj přes `HostedCanvas`, bez `host` má vlastní
 * plátno jako dnes (`/play/[id]`). Kamera, `dpr` a stíny jsou pro obě cesty
 * jedny (`STAGE_CANVAS`).
 */

import { Canvas, type RootState, useFrame, useThree } from '@react-three/fiber';
import { Fragment, type ReactNode, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { type Camera, type Object3D, type PerspectiveCamera, type Scene, type WebGLRenderer, WebGLRenderTarget } from 'three';

import { loadsPending, loadsSettled } from '../arcade/look/pending-loads';
import { captureFrame } from './snapshot-cache';
import { createStageTunnel, type Frameloop, type StageTunnel } from './stage-tunnel';

const CAMERA_AT = [0, 3.4, -6.5] as const;
const CAMERA_FOV = 60;

/** Plátno scény: kamera, hustota pixelů a stíny slunce rigu (P32A T1; PCF s poloměrem – měkký PCFSoft three 0.185 odmítá). */
export const STAGE_CANVAS = { camera: { position: [...CAMERA_AT] as [number, number, number], fov: CAMERA_FOV }, dpr: [1, 2] as [number, number], shadows: 'percentage' as const };

let owners = 0;

/** Kamera jako u nového plátna – další hra nezdědí záběr předchozí (R3F výchozí kameru míří na počátek). */
export function FreshCamera() {
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  useLayoutEffect(() => {
    camera.position.set(...CAMERA_AT);
    camera.rotation.set(0, 0, 0);
    camera.fov = CAMERA_FOV;
    camera.zoom = 1;
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera]);
  return null;
}

/**
 * Nejdelší držení starého snímku. simplified: co se do té doby nepřeloží (první spuštění prohlížeče, GPU bez
 * `KHR_parallel_shader_compile`), přeloží první kresba synchronně jako dřív; kdyby to vadilo, držet až do hotového překladu.
 */
export const HOLD_CAP_MS = 1000;

/** Část stavu R3F, kterou drží `holdDrawing`. */
export interface DrawLoop {
  readonly frameloop: Frameloop | 'never';
  setFrameloop(frameloop: Frameloop | 'never'): void;
  readonly internal: { frames: number };
}

/**
 * Plátno přestane kreslit (`frameloop` 'never'), dokud `ready` nedoběhne – nejvýš `HOLD_CAP_MS` – a pak kreslí jako
 * předtím. `ready` začne až v další úloze, ne v potvrzení Reactu. Vrátí úklid, který kreslení pustí hned. Když mezitím
 * smyčku přepnul někdo jiný (plátno dostalo nový `frameloop`), nechá ji být.
 */
export function holdDrawing(get: () => DrawLoop, ready: () => Promise<unknown>): () => void {
  const { frameloop, setFrameloop, internal } = get();
  if (frameloop === 'never') return () => undefined;
  setFrameloop('never');
  // Snímek už vyžádaný před výměnou by novou scénu nakreslil hned.
  internal.frames = 0;
  let held = true;
  const resume = () => {
    if (!held) return;
    held = false;
    if (get().frameloop === 'never') get().setFrameloop(frameloop);
  };
  const cap = setTimeout(resume, HOLD_CAP_MS);
  const start = setTimeout(() => void ready().then(resume, resume), 0);
  return () => {
    clearTimeout(cap);
    clearTimeout(start);
    resume();
  };
}

/**
 * Programy všech materiálů scény, přeložené mimo hlavní vlákno do lineárního cíle jako vstup skládače – program pro
 * obrazovku (sRGB) by skládač nepoužil. Čekání je `compileAsync` three až na jedno: materiál, který React mezitím
 * uvolnil (odcházející scéna, náhrada načteného modelu), už program nemá a vypadne – `compileAsync` se na něj ptá dál
 * a hodí `reading 'isReady'` (T18, přechod do kola Run! na Pixelu 7).
 * `part` = jen tahle část (P62 T11: stěna interiéru před vstupem do scény), světla a mlhu dá `scene`.
 */
export function compileForComposer({ gl, scene, camera }: { readonly gl: WebGLRenderer; readonly scene: Scene; readonly camera: Camera }, part: Object3D = scene): Promise<void> {
  const target = new WebGLRenderTarget(1, 1);
  const previous = gl.getRenderTarget();
  gl.setRenderTarget(target);
  const pending = gl.compile(part, camera, scene);
  gl.setRenderTarget(previous);
  target.dispose();
  return new Promise((resolve) => {
    const check = () => {
      for (const material of pending) {
        const { currentProgram } = gl.properties.get(material) as { currentProgram?: { isReady(): boolean } };
        if (currentProgram === undefined || currentProgram.isReady()) pending.delete(material);
      }
      if (pending.size === 0) resolve();
      else setTimeout(check, 10);
    };
    // Bez `KHR_parallel_shader_compile` je každý program „hotový“ hned; three pak dá překladu aspoň 10 ms.
    if (gl.extensions.has('KHR_parallel_shader_compile')) check();
    else setTimeout(check, 10);
  });
}

/** Pauza po doběhnutém načítání: model se do scény dostane až potvrzením Reactu v některé z dalších úloh. */
const SETTLE_MS = 30;

/**
 * Scéna je hotová ke kresbě: přeložit, počkat na načítání modelů, která scéna rozjela, a překládat znovu, dokud
 * průchod (aspoň druhý – efekty scény načítání rozjedou až po potvrzení) nepřidá žádný program a nic se nenačítá.
 * Skončí i tehdy, když plátno mezitím kreslí (strop `holdDrawing`).
 */
async function readyToDraw(get: () => RootState): Promise<void> {
  const programs = (): number => get().gl.info.programs?.length ?? 0;
  for (let pass = 0; ; pass += 1) {
    const before = programs();
    await compileForComposer(get());
    if (get().frameloop !== 'never' || (pass > 0 && loadsPending() === 0 && programs() === before)) return;
    await loadsSettled();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  }
}

/**
 * Vyměněná scéna (kolo řetězu, T13a) se poprvé nakreslí až s hotovými programy shaderů (`holdDrawing`): do té doby
 * plátno ukazuje poslední snímek předchozí scény, programy nových materiálů se překládají mimo hlavní vlákno
 * a počká se i na modely, které scéna načítá. Montáž scény, překlad a první kresba tak nepadnou do jednoho snímku –
 * na telefonu to byl jeden snímek 117–300 ms. Plátno, které ještě nic nenakreslilo, nemá co držet.
 */
export function DrawWhenCompiled() {
  const get = useThree((three) => three.get);
  useLayoutEffect(() => (get().gl.info.render.frame === 0 ? undefined : holdDrawing(get, () => readyToDraw(get))), [get]);
  return null;
}

/**
 * Každý program, který three na plátně vytvoří, dostane jedno použití navíc (`usedTimes`), takže ho `releaseProgram`
 * při odchodu scény nesmaže a další scéna ho podle klíče vezme hotový. Kola řetězu kreslí z velké části tytéž
 * shadery (skládač, terén, obrys) a na telefonu stála jejich nová kompilace při každém přechodu 100–300 ms (T13a).
 * simplified: drží všechny programy plátna (u řetězu desítky, pár kB na GPU) do zániku kontextu; feed s desítkami
 * her by je měl pouštět podle stáří, proto jen na požádání.
 */
function KeepPrograms() {
  const gl = useThree((three) => three.gl);
  const [kept] = useState(() => new WeakSet<object>());
  useFrame(() => {
    for (const program of gl.info.programs ?? []) {
      if (kept.has(program)) continue;
      kept.add(program);
      program.usedTimes += 1;
    }
  });
  return null;
}

/**
 * Nový obsah scény jako odložená hodnota kořene R3F: plátno kreslí dál dosavadní scénu a novou React staví po
 * dílech mezi snímky (přechod se vzdává každých ~5 ms). Bez toho stála montáž scény kola řetězu na telefonu
 * ~85 ms v jednom kuse a s první kresbou nové scény padla do jednoho snímku 166–200 ms (T13a).
 */
function DeferredScene({ node }: { readonly node: ReactNode }) {
  return useDeferredValue(node);
}

/**
 * `<Canvas>` s poměrem pixelů, který plátno už má. R3F při každém překreslení `<Canvas>` volá `configure` a ten vrátí
 * `dpr` na hodnotu z props (`[1, 2]` → na telefonu 2) přes úroveň kvality rigu (`useQualityTier`, 1,5): plátno a cíle
 * skládače se zvětšily (4–19 ms, T13b) a kreslilo se dál v plném rozlišení – u řetězu i u samostatné hry.
 */
function StageCanvasRoot({ frameloop, onCreated, children }: { readonly frameloop: Frameloop; readonly onCreated?: (state: RootState) => void; readonly children: ReactNode }) {
  const live = useRef<RootState | null>(null);
  return (
    <Canvas
      {...STAGE_CANVAS}
      dpr={live.current?.get().viewport.dpr ?? STAGE_CANVAS.dpr}
      frameloop={frameloop}
      onCreated={(state) => {
        live.current = state;
        onCreated?.(state);
      }}
    >
      {children}
    </Canvas>
  );
}

function HostCanvas({ host, keepPrograms, deferScenes }: { readonly host: StageTunnel; readonly keepPrograms: boolean; readonly deferScenes: boolean }) {
  const content = useSyncExternalStore(host.subscribe, host.content, () => null);
  useLayoutEffect(() => () => host.bind(null), [host]);
  return (
    <StageCanvasRoot frameloop={content?.frameloop ?? 'demand'} onCreated={(state) => host.bind(() => captureFrame(state))}>
      {keepPrograms && <KeepPrograms />}
      {content !== null && (
        <Fragment key={content.owner}>
          <FreshCamera />
          {deferScenes ? <DeferredScene node={content.node} /> : content.node}
        </Fragment>
      )}
    </StageCanvasRoot>
  );
}

/**
 * Drží jedno plátno, dokud je feed na stránce; `children` dostanou hostitele pro `ArcadeStage`.
 * `onLeave` dostane snímek scény, která z plátna odchází (T8). `keepPrograms` drží programy shaderů přes výměny scén
 * (řetěz mikroher, `KeepPrograms`); `deferScenes` staví změněnou scénu odloženě (`DeferredScene`).
 */
export function StageHost({
  children,
  onLeave,
  keepPrograms = false,
  deferScenes = false,
}: {
  readonly children: (host: StageTunnel) => ReactNode;
  readonly onLeave?: (frame: Promise<Blob | null>) => void;
  readonly keepPrograms?: boolean;
  readonly deferScenes?: boolean;
}) {
  const [host] = useState(() => {
    if (typeof document === 'undefined') return createStageTunnel(null);
    const element = document.createElement('div');
    element.className = 'play-stage-host';
    element.style.cssText = 'width:100%;height:100%';
    return createStageTunnel(element);
  });
  useEffect(() => (onLeave === undefined ? undefined : host.onLeave(onLeave)), [host, onLeave]);
  return (
    <>
      {host.element !== null && createPortal(<HostCanvas host={host} keepPrograms={keepPrograms} deferScenes={deferScenes} />, host.element)}
      {children(host)}
    </>
  );
}

/** Místo plátna v `ArcadeStage` s hostitelem: scéna jde tunelem, kontejner plátna se přesune sem. */
function StageSlot({ host, frameloop, children }: { readonly host: StageTunnel; readonly frameloop: Frameloop; readonly children: ReactNode }) {
  const slot = useRef<HTMLDivElement | null>(null);
  const [owner] = useState(() => (owners += 1));
  useLayoutEffect(() => {
    host.show({ owner, node: children, frameloop });
  });
  useLayoutEffect(() => {
    if (slot.current !== null) host.attach(owner, slot.current);
    return () => host.release(owner);
  }, [host, owner]);
  return <div ref={slot} style={{ width: '100%', height: '100%' }} />;
}

/** Plátno scény `ArcadeStage`: s `host` tunel do trvalého plátna feedu, bez něj vlastní `<Canvas>` jako dnes. */
export function HostedCanvas({ host, frameloop, children }: { readonly host?: StageTunnel; readonly frameloop: Frameloop; readonly children: ReactNode }) {
  if (host !== undefined) {
    return (
      <StageSlot host={host} frameloop={frameloop}>
        {children}
      </StageSlot>
    );
  }
  return <StageCanvasRoot frameloop={frameloop}>{children}</StageCanvasRoot>;
}
