'use client';

/**
 * Plátno arkády (P25A T6, P25C T6, P25F T6) – shell (P32-0 T5): plátno se
 * sondami, výběr scény, vstup a odezva nad plátnem (`EventFeedback`). Scény
 * kreslí jinde:
 * - běžec `runner/RunnerWorld.tsx`, plošinovka `platform/PlatformWorld.tsx`;
 * - poletování, závod, střelnice a hod sdílený `World.tsx`;
 * - aréna `arena/`, načasování `timing/`, rytmus `rhythm/` a souboj `duel/`;
 * - světlo, oblohu, mlhu a ladění barev všech `look/rig/StyleRig.tsx`;
 * - efekty z událostí jádra `effects/Effects.tsx` (sběrnice `effects/bus.ts`).
 *
 * Vstup se jen zapíše do relace – padne do nejbližšího tiku, takže záznam jde přehrát.
 */

import { Canvas, addAfterEffect, useThree } from '@react-three/fiber';
import { type ReactNode, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box3, type Camera, type Mesh, type Object3D, Quaternion, type SkinnedMesh, Vector3 } from 'three';

import { baseControlOf } from '@/play/arcade/addons';
import { AXIS_MAX, BUTTON, type PieceRef, nativeRule } from '@/play/arcade/contract';
import { LOOKS, type Look, type LookId } from '@/play/arcade/look';
import { riggedCharacter } from '@/play/arcade/models';
import { CAPABILITIES } from '@/play/capabilities';
import { stageOf } from '@/play/compose/stage-registry';
import type { ControlId, HeroAction } from '@/play/spec';

import { ActionButton, actionsOf, useActionInput } from './ActionButton';
import { ArenaWorld, useArenaInput } from './arena/ArenaScene';
import { Effects } from './effects/Effects';
import type { ArcadeGhost } from './GhostSlot';
import { comboOf } from './effects/feel';
import { inkCount, isInk } from './look/rig/InkOutline';
import { StyleRig } from './look/rig/StyleRig';
import { DuelScene, type RivalModel, useDuelInput } from './duel/DuelScene';
import { isTyping, runnerGesture } from './input';
import { PlatformWorld } from './platform/PlatformWorld';
import { RhythmScene } from './rhythm/RhythmScene';
import { RiggedModel } from './RiggedModel';
import { RunnerWorld } from './runner/RunnerWorld';
import type { ArcadeSession } from './session';
import { useGlideInput } from './glide/GlideScene';
import { useWalkerInput } from './walker/WalkerScene';
import { useBallInput } from './ball/BallScene';
import { useSteerInput } from './steer/SteerScene';
import { type BodyModel, TimingScene, useTapInput } from './timing/TimingScene';
import { TouchStick, TouchZones } from './TouchControls';
import { DUEL_ZONES, PLATFORM_ZONES, zoneAt } from './touch-zones';
import { Snowfall } from './Weather';
import { type Cast, FittedModel, World } from './World';

/** Fire remains available when independent parts wrap the native weapon rule. */
export function hasBlaster(rules: readonly PieceRef[]): boolean {
  return nativeRule(rules, 'blaster') !== undefined;
}

/**
 * Sonda záběru (P27A T6): `window.__playFrame()` promítne hrdinu a nejbližší
 * živý cíl nebo hrozbu skutečnou kamerou scény. Scény značí objekty
 * `userData.frame = 'hero' | 'target'`; sonda čte jen to, co se opravdu kreslí
 * (objekt i všichni předci viditelní, jen viditelné meshe).
 */
export interface FrameBox {
  /** Střed promítnutého obdélníku v NDC (−1 … 1, +y nahoru). */
  readonly x: number;
  readonly y: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Velikost na obrazovce = větší z šířky a výšky promítnutého obdélníku (px). */
  readonly sizePx: number;
  /** Některý roh je za kamerou – promítnutí pak neplatí a objekt v záběru není. */
  readonly behind: boolean;
}

export interface FrameReport {
  readonly control: string;
  readonly width: number;
  readonly height: number;
  readonly hero: FrameBox | null;
  /**
   * Úhel (°) mezi tím, kam hrdina kouká (jeho +z), a směrem od něj ke kameře, ve vodorovné
   * rovině: 0 = hledí do kamery, 180 = je k ní zády (P35 T12).
   */
  readonly heroFacing: number | null;
  /** Kolik inkoustových obalů (obrys, P36C T6) sítě hrdiny nesou; obrys nezávisí na úrovni kvality. */
  readonly heroInk: number;
  readonly target: FrameBox | null;
  /** Kolik viditelných kandidátů na cíl scéna má. */
  readonly targets: number;
  /** Cíl minus hrdina ve světě (m) – podklad, když cíl vyjde mimo záběr. */
  readonly offset: { readonly x: number; readonly y: number; readonly z: number } | null;
  /**
   * Položky z věty (P30B T5) podle role, jejíž popisek tělo kreslí (`userData.item`):
   * kolik jich je vidět a obdélník té, která je v záběru nejvíc.
   */
  readonly items: Readonly<Record<string, { readonly count: number; readonly box: FrameBox | null }>>;
}

/** Jak daleko od středu obrazu obdélník leží (NDC); za kamerou nekonečno. */
const offCenter = (box: FrameBox): number => (box.behind ? Infinity : Math.max(Math.abs(box.x), Math.abs(box.y)));

/** Sonda kreslení (P28B T2, T6): draw cally posledního snímku a živé zdroje GPU. */
export interface RenderReport {
  readonly calls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  /** Rig vzhledu (P32A T1): stíny zapnuté, tónování (`THREE.ACESFilmicToneMapping` = 4) a expozice. */
  readonly shadows: boolean;
  readonly toneMapping: number;
  readonly exposure: number;
  /** Efekty postprocessingu v pořadí (P32A T2, `look/rig/Post.tsx`); se skládačem tónuje `aces` a `toneMapping` je 0. */
  readonly post: readonly string[];
  /** Rodina ladění barev, kterou efekt ve skládači opravdu nastavil (P37B T3, `Grading`); `null` = bez ladění. */
  readonly grade: string | null;
  /**
   * Viditelné sítě scény (P35 T4) – co se kreslí, nezávisle na úrovni kvality, která
   * mění stínový výřez i průchody a s nimi `calls`.
   */
  readonly meshes: number;
}

declare global {
  interface Window {
    __playFrame?: () => FrameReport;
    __playRender?: () => RenderReport;
  }
}

function RenderProbe() {
  const gl = useThree((three) => three.gl);
  const scene = useThree((three) => three.scene);
  useEffect(() => {
    const meshes = (): number => {
      let count = 0;
      scene.traverseVisible((node) => {
        if ((node as Mesh).isMesh === true) count += 1;
      });
      return count;
    };
    const probe = (): RenderReport => ({
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      shadows: gl.shadowMap.enabled,
      toneMapping: gl.toneMapping,
      exposure: gl.toneMappingExposure,
      post: (gl.domElement.dataset.post ?? '').split(' ').filter(Boolean),
      grade: gl.domElement.dataset.grade ?? null,
      meshes: meshes(),
    });
    window.__playRender = probe;    return () => {
      if (window.__playRender === probe) delete window.__playRender;
    };
  }, [gl, scene]);
  return null;
}

/** Tratě jedou po +z: cílem je nejbližší kandidát před hrdinou, ne ten, který už minul. */
const TRACK_CONTROLS: ReadonlySet<string> = new Set(['runner', 'platform', 'flap', 'steer']);

const shown = (object: Object3D): boolean => {
  for (let node: Object3D | null = object; node !== null; node = node.parent) if (!node.visible) return false;
  return true;
};

const cornerOf = new Vector3();
const inView = new Vector3();

/**
 * Rohy kvádru každého viditelného meshe promítnuté kamerou; obdélník kolem nich.
 * `posed = false` vezme riggované postavě klidový kvádr geometrie místo pózy kostí.
 */
export function frameOf(object: Object3D, camera: Camera, width: number, height: number, posed = true): FrameBox | null {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let behind = false;
  object.traverseVisible((node) => {
    const mesh = node as Mesh;
    // Obal obrysu (P36C T6) má kvádr svého těla. Riggovaný obal by navíc kostmi přepočítal
    // každý vrchol (3× víc než tělo, `toCreasedNormals`) – `PromptSpot` to dělá každý snímek.
    if (mesh.isMesh !== true || isInk(mesh)) return;
    let box: Box3;
    if (posed && (mesh as SkinnedMesh).isSkinnedMesh === true) {
      // Riggovaná postava: kvádr s pózou kostí, ne klidová geometrie.
      (mesh as SkinnedMesh).computeBoundingBox();
      box = (mesh as SkinnedMesh).boundingBox!;
    } else {
      if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
      box = mesh.geometry.boundingBox!;
    }
    for (let i = 0; i < 8; i += 1) {
      cornerOf.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(mesh.matrixWorld);
      // Kamera kouká po −z svého prostoru: roh s z ≥ 0 je za ní.
      if (inView.copy(cornerOf).applyMatrix4(camera.matrixWorldInverse).z >= 0) behind = true;
      cornerOf.project(camera);
      minX = Math.min(minX, cornerOf.x);
      maxX = Math.max(maxX, cornerOf.x);
      minY = Math.min(minY, cornerOf.y);
      maxY = Math.max(maxY, cornerOf.y);
    }
  });
  if (minX === Infinity) return null;
  const widthPx = ((maxX - minX) / 2) * width;
  const heightPx = ((maxY - minY) / 2) * height;
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, maxX, minY, maxY, widthPx, heightPx, sizePx: Math.max(widthPx, heightPx), behind };
}

/** `FrameReport.heroFacing`: úhel mezi pohledem hrdiny (+z) a směrem ke kameře ve vodorovné rovině (°). */
function facingOf(hero: Object3D, at: Vector3, camera: Camera): number {
  const gaze = new Vector3(0, 0, 1).applyQuaternion(hero.getWorldQuaternion(new Quaternion())).setY(0);
  const toCamera = camera.getWorldPosition(new Vector3()).sub(at).setY(0);
  return (gaze.angleTo(toCamera) * 180) / Math.PI;
}

/** Při kreslení na požádání překreslí scénu po každé změně relace – restart, konec běhu, pauza. */
function RedrawOnChange({ session }: { readonly session: ArcadeSession }) {
  const invalidate = useThree((three) => three.invalidate);
  useEffect(() => session.subscribe(() => invalidate()), [session, invalidate]);
  return null;
}

function FrameProbe({ control }: { readonly control: string }) {
  const get = useThree((three) => three.get);
  useEffect(() => {
    const probe = (): FrameReport => {
      const { camera, scene, size } = get();
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      let hero: Object3D | null = null;
      const candidates: Object3D[] = [];
      const items: Record<string, { count: number; box: FrameBox | null }> = {};
      scene.traverse((node) => {
        const item = node.userData.item as string | undefined;
        if (item !== undefined && shown(node)) {
          const entry = (items[item] ??= { count: 0, box: null });
          const box = frameOf(node, camera, size.width, size.height);
          entry.count += 1;
          if (box !== null && (entry.box === null || offCenter(box) < offCenter(entry.box))) entry.box = box;
        }
        if (node.userData.frame === 'hero' && shown(node)) hero = node;
        else if (node.userData.frame === 'target' && shown(node)) candidates.push(node);
      });
      const heroAt = hero === null ? null : (hero as Object3D).getWorldPosition(new Vector3());
      let target: { node: Object3D; pos: Vector3 } | null = null;
      if (heroAt !== null && candidates.length > 0) {
        const at = candidates.map((node) => ({ node, pos: node.getWorldPosition(new Vector3()) }));
        const ahead = TRACK_CONTROLS.has(control) ? at.filter((c) => c.pos.z > heroAt.z) : [];
        const pool = ahead.length > 0 ? ahead : at;
        target = pool.reduce((best, c) => (c.pos.distanceTo(heroAt) < best.pos.distanceTo(heroAt) ? c : best));
      }
      return {
        control,
        width: size.width,
        height: size.height,
        hero: hero === null ? null : frameOf(hero, camera, size.width, size.height),
        heroFacing: hero === null || heroAt === null ? null : facingOf(hero, heroAt, camera),
        heroInk: hero === null ? 0 : inkCount(hero),
        target: target === null ? null : frameOf(target.node, camera, size.width, size.height),
        targets: candidates.length,
        offset: target === null || heroAt === null ? null : { x: target.pos.x - heroAt.x, y: target.pos.y - heroAt.y, z: target.pos.z - heroAt.z },
        items,
      };
    };
    // Bez podmínky, stejně jako `__playShell`: e2e ji čte na každé arkádové hře.
    window.__playFrame = probe;
    return () => {
      if (window.__playFrame === probe) delete window.__playFrame;
    };
  }, [get, control]);
  return null;
}

/**
 * Místo výzvy „Tap to start“ (P35 T6): uprostřed obrazu v aréně a úkolu přesně
 * zakryla hrdinu. Dokud hra stojí na tiku 0, promítne hrdinu kamerou a dá stage,
 * kde v obraze je (`--_hero-top`, `--_hero-bottom` v % výšky) a na které straně
 * od něj je víc místa (`data-prompt-at`); CSS výzvu postaví nad, nebo pod něj.
 * Bez hrdiny v záběru zůstane výzva uprostřed.
 *
 * Měří se až nakreslený snímek (`addAfterEffect`), ne ve `useFrame`: kamera
 * stanoviště úkolu se přihlásí až druhým průchodem (`StationScene.tsx`) a přestaví
 * kameru po každém dřívějším `useFrame` – u kuchaře (P35 T11) se karta měřila
 * kamerou arény a na telefonu sedla přesně přes hrdinu. Hra na tiku 0 navíc kreslí
 * jen na požádání, takže snímek, kdy se dotáhne model, bývá poslední.
 *
 * Místo pro kartu je mezi hrdinou a lištami HUD (nahoře hodiny a cíl, dole akce).
 * Kde se nevejde ani nad, ani pod hrdinu, zmenší se do většího z obou míst
 * (`--_prompt-scale`) – přes hrdinu nejde nikdy.
 */
function PromptSpot({ session, surface }: { readonly session: ArcadeSession; readonly surface: React.RefObject<HTMLDivElement | null> }) {
  const get = useThree((three) => three.get);
  useEffect(() => {
    // Čekání na první vstup běží každý snímek (P37B T7, Pixel 7 CPU 4×): průchod scénou
    // a zápis stylu, který prohlížeči každý snímek zneplatnil rozvržení pro další
    // `getBoundingClientRect`, stály čaroději na úvodní kartě ~6 % CPU. Hrdina se proto
    // hledá znovu, jen když zmizí, a styl se píše, jen když se změní.
    let hero: Object3D | null = null;
    return addAfterEffect(() => {
      const host = surface.current;
      if (host === null || session.snapshot().tick !== 0) return;
      const { camera, scene, size } = get();
      if (hero === null || !shownIn(hero, scene)) {
        hero = null;
        scene.traverseVisible((node) => {
          if (node.userData.frame === 'hero') hero = node;
        });
      }
      // Klidový kvádr (P36C T9): póza kostí přepočítá každý vrchol postavy a tohle běží každý
      // snímek tiku 0 – u rytířů ~30 % CPU telefonu. Na místo pro kartu stačí postava v klidu.
      const box = hero === null ? null : frameOf(hero, camera, size.width, size.height, false);
      if (box === null || box.behind) {
        delete host.dataset.promptAt;
        return;
      }
      const top = (1 - box.maxY) / 2;
      const bottom = (1 - box.minY) / 2;
      const stage = host.getBoundingClientRect();
      const bars = hudBars(host, stage);
      const card = host.querySelector<HTMLElement>('.play-first-prompt')?.offsetHeight ?? 0;
      const above = top * stage.height - bars.top - 2 * PROMPT_GAP_PX;
      const below = bars.bottom - bottom * stage.height - 2 * PROMPT_GAP_PX;
      const room = Math.max(above, below, 0);
      setStyleVar(host, '--_hero-top', `${(top * 100).toFixed(1)}%`);
      setStyleVar(host, '--_hero-bottom', `${(bottom * 100).toFixed(1)}%`);
      setStyleVar(host, '--_prompt-scale', card > room ? (room / card).toFixed(3) : '1');
      const side = above >= below ? 'above' : 'below';
      if (host.dataset.promptAt !== side) host.dataset.promptAt = side;
    });
  }, [get, session, surface]);
  return null;
}

/** Uzel je ve scéně a viditelný i se všemi předky. */
function shownIn(object: Object3D, root: Object3D): boolean {
  let node: Object3D | null = object;
  for (; node !== null && node !== root; node = node.parent) if (!node.visible) return false;
  return node === root && root.visible;
}

/** Stejná hodnota se nepíše: i ta by zneplatnila styl a rozvržení stránky. */
export function setStyleVar(host: HTMLElement, name: string, value: string): void {
  if (host.style.getPropertyValue(name) !== value) host.style.setProperty(name, value);
}

/** Mezera mezi kartou a hrdinou i lištou HUD (`--sp-space-4` v `play.css`). */
const PROMPT_GAP_PX = 16;

/** Spodní hrana horní lišty HUD a horní hrana dolní, v px od horní hrany stage. */
function hudBars(host: HTMLElement, stage: DOMRect): { readonly top: number; readonly bottom: number } {
  const shell = host.parentElement;
  let top = 0;
  let bottom = stage.height;
  for (const bar of shell?.querySelectorAll('.play-hud-progress, .play-hud-corner, .play-hud-goal') ?? []) {
    const rect = bar.getBoundingClientRect();
    if (rect.height > 0) top = Math.max(top, rect.bottom - stage.top);
  }
  const actions = shell?.querySelector('.play-hud-bottom')?.getBoundingClientRect();
  if (actions !== undefined && actions.height > 0) bottom = Math.min(bottom, actions.top - stage.top);
  return { top, bottom };
}

/** Jak dlouho po konci běhu plátno ještě kreslí naplno: klip pádu či oslavy a pauza výsledku (600 ms). */
const END_CLIP_MS = 1500;

const JUMP_KEYS = new Set([' ', 'arrowup', 'w']);

/** Běžec: mezerník/šipka nahoru = skok, šipky/A-D = pruh, šipka dolů = skluz; dotyk a myš: `runnerGesture`. */
function useRunnerInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const button =
        JUMP_KEYS.has(key) ? BUTTON.TAP
        : key === 'arrowleft' || key === 'a' ? BUTTON.LEFT
        : key === 'arrowright' || key === 'd' ? BUTTON.RIGHT
        : key === 'arrowdown' || key === 's' ? BUTTON.DOWN
        : 0;
      if (button === 0) return;
      event.preventDefault();
      session.press(button);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, active]);

  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const gesture = runnerGesture(session);
    const onDown = (event: PointerEvent) => gesture.down(event);
    const onMove = (event: PointerEvent) => gesture.move(event);
    const onUp = (event: PointerEvent) => gesture.up(event);
    const onCancel = () => gesture.cancel();
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onCancel);
    return () => {
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onCancel);
    };
  }, [session, target, active]);
}

/**
 * Plošinovka: šipky/A-D drží osu, mezerník/šipka nahoru/W = skok. Dotyk:
 * levá čtvrtina drží vlevo, druhá vpravo, pravá polovina = skok – palec
 * vlevo běží, palec vpravo skáče (víc prstů najednou).
 */
function usePlatformInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const keys = new Set<'left' | 'right'>();
    const pointers = new Map<number, 'left' | 'right'>();
    const sync = (): void => {
      const held = new Set([...keys, ...pointers.values()]);
      session.hold(((held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0)) * AXIS_MAX);
    };
    const sideOf = (key: string): 'left' | 'right' | null => (key === 'arrowleft' || key === 'a' ? 'left' : key === 'arrowright' || key === 'd' ? 'right' : null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const side = sideOf(key);
      if (side !== null) {
        event.preventDefault();
        keys.add(side);
        sync();
      } else if (JUMP_KEYS.has(key) && !event.repeat) {
        event.preventDefault();
        session.press(BUTTON.TAP);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const side = sideOf(event.key.toLowerCase());
      if (side === null) return;
      keys.delete(side);
      sync();
    };
    const onDown = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const zone = zoneAt(PLATFORM_ZONES, (event.clientX - box.left) / Math.max(1, box.width));
      if (zone === 2) session.press(BUTTON.TAP);
      else {
        pointers.set(event.pointerId, zone === 0 ? 'left' : 'right');
        sync();
      }
    };
    const onUp = (event: PointerEvent) => {
      if (pointers.delete(event.pointerId)) sync();
    };
    const release = (): void => {
      keys.clear();
      pointers.clear();
      sync();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', onUp);
    };
  }, [session, target, active]);
}

/** Poletování: mezerník/šipka nahoru/W nebo dotyk kdekoli = mávnutí (hned při stisku). */
function useFlapInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target) || !JUMP_KEYS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      session.press(BUTTON.TAP);
    };
    const onDown = () => session.press(BUTTON.TAP);
    window.addEventListener('keydown', onKey);
    element.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      element.removeEventListener('pointerdown', onDown);
    };
  }, [session, target, active]);
}

const FIRE_KEYS = new Set(['f', 'j', 'enter']);

/** Střelba doplňku `+shoot` (P26D): F/J/Enter, na dotyku tlačítko ve scéně – skok a skluz zůstávají, kde byly. */
function useFireInput(session: ArcadeSession, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || isTyping(event.target) || !FIRE_KEYS.has(event.key.toLowerCase())) return;
      event.preventDefault();
      session.press(BUTTON.FIRE);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, active]);
}

function FireButton({ session }: { readonly session: ArcadeSession }) {
  const button = useRef<HTMLButtonElement | null>(null);
  // Ťuk na tlačítko nesmí doběhnout k ploše scény – tam je to skok. Plocha poslouchá
  // nativně, takže zastavit to musí nativní posluchač (React by přišel až po ní).
  useEffect(() => {
    const element = button.current;
    if (element === null) return;
    const stop = (event: PointerEvent) => event.stopPropagation();
    const fire = (event: PointerEvent) => {
      stop(event);
      session.press(BUTTON.FIRE);
    };
    element.addEventListener('pointerdown', fire);
    element.addEventListener('pointerup', stop);
    return () => {
      element.removeEventListener('pointerdown', fire);
      element.removeEventListener('pointerup', stop);
    };
  }, [session]);
  return (
    <button ref={button} type="button" className="play-fire" data-testid="arcade-fire">
      Fire
    </button>
  );
}

/** Jak dlouho visí „+1“ nad hráčem (P28C T3). */
export const SCORE_POP_MS = 500;

interface ScorePop {
  readonly id: number;
  /** „+N“ za bod, „×N“ za kombo (P36C T7). */
  readonly text: string;
  readonly combo: boolean;
  /** Vodorovná poloha hráče na obrazovce v % (střed, když ji scéna nehlásí). */
  readonly left: number;
}

/**
 * Odezva nad plátnem (P28C T3), společná všem scénám: „+N“ nad hráčem při
 * bodu. Je to DOM nad plátnem – žádný draw call navíc, stav relace se nemění.
 * Otřes po zásahu dělá kamera (`effects/Effects.tsx`, P32A T4). Poloha „+N“ je `data-player-x`,
 * který píše scéna běžce, plošinovky, poletování a závodu; ostatní scény ho
 * nemají a „+N“ je uprostřed.
 */
function EventFeedback({ session, surface }: { readonly session: ArcadeSession; readonly surface: React.RefObject<HTMLDivElement | null> }) {
  const [pops, setPops] = useState<readonly ScorePop[]>([]);
  useEffect(() => {
    let next = 0;
    const timers = new Set<number>();
    const later = (ms: number, fn: () => void): void => {
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };
    const off = session.onEvents((events) => {
      const amount = events.reduce((sum, event) => (event.kind === 'score' ? sum + event.amount : sum), 0);
      const combo = comboOf(events);
      const x = Number(surface.current?.dataset.playerX ?? 0);
      const left = 50 + Math.max(-0.9, Math.min(0.9, Number.isFinite(x) ? x : 0)) * 50;
      const fresh: ScorePop[] = [];
      if (amount > 0) fresh.push({ id: (next += 1), text: `+${amount}`, combo: false, left });
      if (combo !== null) fresh.push({ id: (next += 1), text: `×${combo}`, combo: true, left });
      for (const pop of fresh) {
        setPops((current) => [...current, pop]);
        later(SCORE_POP_MS, () => setPops((current) => current.filter((entry) => entry.id !== pop.id)));
      }
    });
    return () => {
      off();
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [session, surface]);
  return (
    <>
      {pops.map((pop) => (
        <span key={pop.id} className={pop.combo ? 'play-score-pop play-combo-pop' : 'play-score-pop'} data-testid={pop.combo ? 'combo-pop' : 'score-pop'} style={{ left: `${pop.left}%` }} aria-hidden="true">
          {pop.text}
        </span>
      ))}
    </>
  );
}

/**
 * Plátno se scénou za vlastní hranicí `memo` (P32A T2-R1). `ArcadePlay` se překresluje
 * s každým tikem (HUD čte snímek relace) a nový prvek `overlay` obejde `memo` celé
 * stage – bez téhle hranice React každý tik prošel celý strom scény (běžec na Pixel 7
 * se 4× CPU ~20 % času). Scény čtou stav relace ve `useFrame`, props se jim za běhu nemění.
 */
const StageCanvas = memo(function StageCanvas({
  session,
  cast,
  look,
  lookId,
  enabled,
  live,
  surface,
  heroAction,
  ghost,
}: {
  readonly session: ArcadeSession;
  readonly cast: Cast;
  readonly look: Look;
  /** Rodina ladění barev (P37B T3, `look/rig/grade.ts`). */
  readonly lookId: LookId;
  readonly enabled: boolean;
  readonly live: boolean;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly heroAction: HeroAction;
  readonly ghost?: ArcadeGhost;
}) {
  const base = baseControlOf(session.world.control);
  const control = base.id;
  const stage = stageOf(control);
  if (stage === null) throw new Error(`No scene registered for ${control}`);
  // Soupeř souboje z popisku (P27A T4): riggovaná postava stojí, model katalogu se vepíše do těla.
  const rival = cast.props.rival;
  const character = rival === undefined ? undefined : riggedCharacter(rival);
  const rivalModel: RivalModel | undefined =
    rival === undefined
      ? undefined
      : (w, h, d) => (character !== undefined ? <RiggedModel character={character} h={h} clip={() => 'idle'} fallback="#64748b" /> : <FittedModel id={rival} w={w} h={h} d={d} fallback="#64748b" />);
  // P30B T4: nota rytmu a díl věže z popisku („lily pads“, „pancakes“); díl vyplní kvádr, šířku mu mění jádro.
  const { note, block } = cast.props;
  const noteModel: BodyModel | undefined = note === undefined ? undefined : (w, h, d) => <FittedModel id={note} w={w} h={h} d={d} fallback="#0ea5e9" />;
  const blockModel: BodyModel | undefined = block === undefined ? undefined : (w, h, d) => <FittedModel id={block} w={w} h={h} d={d} fallback="#0ea5e9" fill />;
  const world = { session, cast, surface, scene: look, enabled, heroAction, ghost };
  return (
    // Stíny slunce rigu (P32A T1); PCF s poloměrem – měkký PCFSoft three 0.185 odmítá.
    <Canvas camera={{ position: [0, 3.4, -6.5], fov: 60 }} dpr={[1, 2]} frameloop={live ? 'always' : 'demand'} shadows="percentage">
      <RedrawOnChange session={session} />
      <FrameProbe control={control} />
      <RenderProbe />
      {/* Fotopanorama tu není (P32A T6): prostředí z věty vybírá paletu a kulisy, obloha je rigu. Zůstává mřížce (`GridScenery`). */}
      {/* Rig svítí všem scénám: načasování a rytmus od P32A T10, souboj od P37B T3. */}
      <StyleRig look={look} lookId={lookId} control={control} surface={surface} />
      {stage.scene === 'duel' ? (
        <DuelScene session={session} look={look} rivalModel={rivalModel} heroAction={heroAction} ghost={ghost} />
      ) : (
        <>
          {/* Souboj (P32E T3) je režim arény: stejná plocha, kamera i pohyb, úder přidává `ActionButton`. */}
          {stage.scene === 'timing' ? (
            <TimingScene session={session} look={look} blockModel={blockModel} heroAction={heroAction} ghost={ghost} />
          ) : stage.scene === 'rhythm' ? (
            <RhythmScene session={session} look={look} noteModel={noteModel} surface={surface} heroAction={heroAction} ghost={ghost} />
          ) : stage.scene === 'arena' ? (
            <ArenaWorld session={session} half={Number(base.params.half)} surface={surface} look={look} cast={cast} heroAction={heroAction} ghost={ghost} />
          ) : stage.scene === 'runner' ? (
            <RunnerWorld {...world} />
          ) : stage.scene === 'platform' ? (
            <PlatformWorld {...world} />
          ) : (
            <World {...world} control={control} />
          )}
        </>
      )}
      {/* Sněží jen v zasněžené sadě (čepička na kulisách), body kolem kamery (P32A T4). */}
      {look.terrain?.cap !== undefined && <Snowfall />}
      {/* Výzva na startu se měří až nakresleným snímkem – záběrem kamery, kterou scéna nakonec postavila. */}
      <PromptSpot session={session} surface={surface} />
      {/* Poslední dítě plátna: jeho snímek běží až po scéně, která kameru umístila. */}
      <Effects session={session} look={look} surface={surface} />
    </Canvas>
  );
});

export default function ArcadeStage({
  session,
  cast,
  lookId = 'meadow',
  look: scene,
  enabled = true,
  heroAction = 'none',
  ghost,
  overlay,
}: {
  readonly session: ArcadeSession;
  readonly cast: Cast;
  readonly lookId?: LookId;
  /** Sada upravená místem z věty (`sceneLook`, P30B T6); bez ní sada `lookId`. */
  readonly look?: Look;
  /** Hra je na obrazovce a běží (P28B T3); jinak vstup neposlouchá – po konci patří šipky feedu a klávesy formuláři. */
  readonly enabled?: boolean;
  /** Viditelná činnost hrdiny ze specu (P37-0 T2); jde do každé scény, kreslí ji až stopa vzhledu. Jádro ji nečte. */
  readonly heroAction?: HeroAction;
  /** Duch dřívějšího běhu (P37B T8, `GhostSlot.tsx`); scéna ho kreslí ve svém slotu. */
  readonly ghost?: ArcadeGhost;
  /* P29D */
  /** Vrstva nad plátnem (počasí a denní doba živé změny) – mimo scénu i hash. */
  readonly overlay?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement | null>(null);
  // Doplňky obalí ovládání (`addon_control`); kamera, scéna i vstup se řídí tím pod obalem.
  const control = baseControlOf(session.world.control).id;
  const input = stageOf(control)?.input;
  const fires = hasBlaster(session.world.rules);
  // Úder a použití (P32-0 T5) jen ve světě, který je čte.
  const actions = useMemo(() => actionsOf(session.world), [session]);
  const look = scene ?? LOOKS[lookId];
  const draws = CAPABILITIES[control as ControlId]?.setting === true;
  useFireInput(session, fires && enabled);
  useActionInput(session, actions, enabled);
  useRunnerInput(session, surface, enabled && input === 'runner');
  usePlatformInput(session, surface, enabled && input === 'platform');
  useFlapInput(session, surface, enabled && input === 'flap');
  useSteerInput(session, surface, enabled && input === 'steer');
  useGlideInput(session, surface, enabled && input === 'glide');
  useWalkerInput(session, surface, enabled && input === 'walker');
  useBallInput(session, surface, enabled && input === 'ball');
  useArenaInput(session, surface, enabled && input === 'arena');
  useTapInput(session, surface, enabled && input === 'tap', control === 'rhythm');
  useDuelInput(session, surface, enabled && input === 'duel');
  // Pauza a konec běhu kreslí jen na požádání (P28E T2, F-33): hodiny stojí, obraz se nemění.
  // Po konci ale ještě END_CLIP_MS naplno – klip pádu či oslavy (P28C T3) by jinak stál na prvním snímku.
  const ticking = useSyncExternalStore(session.subscribe, () => session.snapshot().runState === 'running' && !session.paused(), () => true);
  const ended = useSyncExternalStore(session.subscribe, () => session.snapshot().runState !== 'running', () => false);
  const [settling, setSettling] = useState(false);
  useEffect(() => {
    if (!ended) return;
    setSettling(true);
    const timer = window.setTimeout(() => setSettling(false), END_CLIP_MS);
    return () => window.clearTimeout(timer);
  }, [ended]);
  const live = ticking || settling;
  return (
    // `data-setting` = sada, jejíž kulisy scéna opravdu kreslí (P27A T3); scéna bez sad ho nemá.
    <div ref={surface} className="play-stage" data-testid="arcade-stage" data-control={control} data-look={lookId} data-setting={draws ? lookId : undefined} style={{ touchAction: 'none' }}>
      <StageCanvas session={session} cast={cast} look={look} lookId={lookId} enabled={enabled} live={live} surface={surface} heroAction={heroAction} ghost={ghost} />
      {overlay /* P29D */}
      <EventFeedback session={session} surface={surface} />
      {enabled && control === 'platform' && <TouchZones session={session} zones={PLATFORM_ZONES} />}
      {enabled && control === 'duel' && <TouchZones session={session} zones={DUEL_ZONES} />}
      {enabled && (control === 'move_free' || control === 'fight') && <TouchStick surface={surface} />}
      {enabled && control === 'ball' && session.world.control.id === 'assembly_control' && <div
        className="play-pause-hint" data-testid="ball-dribble-hint"
        style={{ position: 'absolute', left: 12, top: 12, maxWidth: '65%', pointerEvents: 'none' }}>
        Left side: drag to move. Right side: aim and release to shoot. Keyboard: arrows move, Q/E aim, Space shoots.
      </div>}
      {fires && enabled && <FireButton session={session} />}
      {enabled && actions.map((action) => <ActionButton key={action} session={session} action={action} />)}
    </div>
  );
}
