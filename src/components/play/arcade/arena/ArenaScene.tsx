'use client';

/**
 * Scéna arény (P25F T6): kamera shora nad hráčem, velikosti na první pohled.
 * Každé tělo je kotouč o průměru své šířky; barva říká, co s ním: hráč
 * modrý, menší buňka zelená (sníst), větší červená (utéct), potrava žlutá.
 * Barva i velikost se čtou z každého tiku – hráč roste a buňka, kterou
 * přerostl, zezelená.
 *
 * Směry: kamera kouká dolů s „nahoru“ = +z, `x` jádra je zrcadlené jako
 * u ostatních scén, takže vpravo na obrazovce = +x jádra, nahoru = +z.
 * Vstup: šipky/WASD (i šikmo) a tah prstem od místa stisku = směr pohybu.
 *
 * Dvorek pravidel (P29A T6): věci pravidel (`thing:<id>`) a ploty jsou
 * kvádry w×h×d, výška se čte ze stavu – nesená věc jede hráči na hlavě,
 * hozená letí nad zemí, přepnuté dveře zmizí. Mezerník / ťuk = akce,
 * `e` = druhá akce.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type Group, type MeshStandardMaterial, type PerspectiveCamera, Vector3 } from 'three';

import { BODY, BUTTON, FLAG, HEADER, ROLE, UNIT, bodyBase } from '@/play/arcade/contract';
import type { Look } from '@/play/arcade/look';
import { arenaAxis } from '@/play/arcade/pieces/arena';

import { type BodyView, bodiesOf, bodiesStale } from '../bodies';
import { isTyping } from '../input';
import { UNDER_PANORAMA } from '../look/under-panorama';
import { applyIntro, introLeft, useIntroClock } from '../look/intro';
import { Scenery } from '../look/Scenery';
import type { ArcadeSession } from '../session';

const COLOR = { player: '#2563eb', prey: '#16a34a', hunter: '#dc2626', food: '#facc15', shot: '#f8fafc' } as const;

/** Barva kotouče při stavbě scény; nepřítel ji podle velikosti mění každý tik, pronásledovatel `+chaser` je vždy k útěku. */
const colorOf = (role: number): string =>
  role === ROLE.player ? COLOR.player : role === ROLE.collectible ? COLOR.food : role === ROLE.chaser ? COLOR.hunter : role === ROLE.projectile ? COLOR.shot : COLOR.prey;

const ROLE_NAMES: Readonly<Record<number, string>> = Object.fromEntries(Object.entries(ROLE).map(([name, code]) => [code, name]));

/** Věci pravidel: jantar, tyrkys, oranžová, nebeská, hnědá, břidlice – ne zelená kořist, ne fialová. */
const THING_COLORS = ['#f59e0b', '#14b8a6', '#f97316', '#38bdf8', '#a16207', '#64748b'] as const;
const FENCE_COLOR = '#78716c';

/** Id role pravidla z druhu `thing:<id>`, jinak `null`. */
const thingOf = (kind: string): string | null => (kind.startsWith('thing:') ? kind.slice(6) : null);

/** Stálá barva podle jména role – tatáž věc má tutéž barvu v každé hře. */
function thingColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return THING_COLORS[hash % THING_COLORS.length] as string;
}

/** Nad zemí víc než tohle (m) = ve vzduchu (sonda `data-airborne`). */
const AIRBORNE_M = 0.05;

/** Kolik metrů od hráče do strany je vidět vždy. */
const SEE_M = 9;
/** Na výšku (mobil) méně: při 6 m měl hráč 3,7 % výšky obrazu (P27A T6, P30B T5); nahoru a dolů je pak vidět víc. */
const SEE_M_TALL = 5;

/** Jak daleko za hranou arény stojí první řada kulis (m). */
const SCENERY_MARGIN = 1.5;

/** Sklon kamery nad vodorovnou (rad): 48° – hrdina pořád zřetelně shora, horní třetina obrazu už za hranou arény (58° ukázalo kulisy jen v rozích). */
const PITCH = (48 * Math.PI) / 180;

export function ArenaWorld({
  session,
  half,
  surface,
  look: scene,
  targets,
}: {
  readonly session: ArcadeSession;
  readonly half: number;
  readonly surface: React.RefObject<HTMLDivElement | null>;
  readonly look: Look;
  /** Vrstva cílů (P32-0 T5, naplní P32G): dostane těla, jak je aréna kreslí, a kreslí se nad ně. */
  readonly targets?: (bodies: readonly BodyView[]) => ReactNode;
}) {
  // Střely doplňku `+shoot` přidává jádro za běhu (`spawn`) – seznam se staví znovu, když se změní.
  const [discs, setDiscs] = useState(() => bodiesOf(session));
  const groups = useRef<(Group | null)[]>([]);
  const materials = useRef<(MeshStandardMaterial | null)[]>([]);
  const camera = useThree((three) => three.camera) as PerspectiveCamera;
  const look = useMemo(() => new Vector3(), []);
  const projected = useMemo(() => new Vector3(), []);
  const introClock = useIntroClock();

  // Role kreslených kotoučů pro e2e (jako `data-drawn` ostatních scén).
  useEffect(() => {
    if (surface.current !== null) surface.current.dataset.drawn = [...new Set(discs.map((disc) => ROLE_NAMES[disc.role]))].join(' ');
  }, [discs, surface]);

  // Pohled shora potřebuje „nahoru“ = +z; ostatní scény počítají s +y.
  useEffect(() => {
    camera.up.set(0, 0, 1);
    return () => {
      camera.up.set(0, 1, 0);
    };
  }, [camera]);

  useFrame((_, delta) => {
    const alpha = session.advance(delta * 1000);
    if (bodiesStale(discs, session)) setDiscs(bodiesOf(session));
    const state = session.state();
    const prev = session.prev();
    const player = state[HEADER.player] as number;
    const mine = state[bodyBase(player) + BODY.w] as number;
    for (const disc of discs) {
      const group = groups.current[disc.index];
      if (group === null || group === undefined) continue;
      const base = bodyBase(disc.index);
      group.visible = ((state[base + BODY.flags] as number) & FLAG.alive) !== 0;
      if (!group.visible) continue;
      const px = prev[base + BODY.x] as number;
      const pz = prev[base + BODY.z] as number;
      const py = prev[base + BODY.y] as number;
      group.position.set(-(px + ((state[base + BODY.x] as number) - px) * alpha) / UNIT, (py + ((state[base + BODY.y] as number) - py) * alpha) / UNIT, (pz + ((state[base + BODY.z] as number) - pz) * alpha) / UNIT);
      const w = state[base + BODY.w] as number;
      group.scale.set(w / UNIT / disc.w, 1, w / UNIT / disc.w);
      const material = materials.current[disc.index];
      if (material !== null && material !== undefined && disc.role === ROLE.enemy) material.color.set(w > mine ? COLOR.hunter : COLOR.prey);
    }
    // Sonda pro e2e ze skupin, které opravdu kreslíme: nesená věc nad zemí, počty viditelných věcí, věci v letu.
    if (surface.current !== null) {
      const heldIndex = (state[HEADER.held] as number) - 1;
      const counts = new Map<string, number>();
      const airborne: string[] = [];
      let held = '';
      for (const disc of discs) {
        const id = thingOf(disc.kind);
        const group = groups.current[disc.index];
        if (id === null || group === null || group === undefined || !group.visible) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (group.position.y <= AIRBORNE_M) continue;
        if (disc.index === heldIndex) held = id;
        else airborne.push(id);
      }
      const dataset = surface.current.dataset;
      const things = [...counts].map(([id, n]) => `${id}:${n}`).join(' ');
      if (dataset.held !== held) dataset.held = held;
      if (dataset.things !== things) dataset.things = things;
      if (dataset.airborne !== airborne.join(' ')) dataset.airborne = airborne.join(' ');
    }
    const me = groups.current[player];
    if (me !== null && me !== undefined) {
      // Aspoň `SEE_M` metrů do strany i na výšku (mobil) a výš s velikostí hráče,
      // ať větší buňku vidí dřív, než dojede.
      const tan = Math.tan((camera.fov * Math.PI) / 360);
      const distance = Math.max(16, (camera.aspect < 1 ? SEE_M_TALL : SEE_M) / (tan * Math.min(1, camera.aspect))) + (mine / UNIT) * 3;
      // Šikmo zezadu, ne kolmo dolů (P28D T6, F-29): kolmá kamera viděla jen podlahu,
      // takhle horní okraj obrazu sahá za hranu arény na kulisy prostředí.
      camera.position.set(me.position.x, distance * Math.sin(PITCH), me.position.z - distance * Math.cos(PITCH));
      look.set(me.position.x, 0, me.position.z);
      camera.lookAt(look);
      applyIntro(camera, look, introLeft(introClock()));
      camera.updateMatrixWorld();
      if (surface.current !== null) surface.current.dataset.playerX = projected.copy(me.position).project(camera).x.toFixed(3);
    }
  });

  const side = (2 * half) / UNIT;
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
        <planeGeometry args={[side, side]} />
        {/* Podlaha v barvě dráhy sady, ne země: zelená kořist by na trávě splynula. Prostředí ukazují kulisy za hranou. */}
        <meshStandardMaterial color={scene.track} roughness={0.8} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, 0]} renderOrder={UNDER_PANORAMA}>
        <planeGeometry args={[side + 60, side + 60]} />
        <meshStandardMaterial color={scene.ground} roughness={1} depthWrite={false} />
      </mesh>
      {/* Kulisy sady prostředí (P27A T3) za hranou arény ze všech čtyř stran – jen vzhled, jádro o nich neví. */}
      {[0, Math.PI / 2].map((turn) => (
        <group key={turn} rotation={[0, turn, 0]}>
          <Scenery look={scene} layout="sides" inner={side / 2 + SCENERY_MARGIN} from={-side / 2} to={side / 2} />
        </group>
      ))}
      {discs.map((disc) => {
        const thing = thingOf(disc.kind);
        if (thing !== null || disc.role === ROLE.obstacle) {
          return (
            <group key={disc.index} ref={(group) => { groups.current[disc.index] = group; }} userData={{ frame: thing === null ? undefined : 'target' }}>
              <mesh position={[0, disc.h / 2, 0]}>
                <boxGeometry args={[disc.w, disc.h, disc.d]} />
                <meshStandardMaterial ref={(material) => { materials.current[disc.index] = material; }} color={thing === null ? FENCE_COLOR : thingColor(thing)} roughness={0.6} />
              </mesh>
            </group>
          );
        }
        const color = colorOf(disc.role);
        const tall = disc.role === ROLE.collectible ? 0.15 : Math.min(0.5, disc.h);
        return (
          // `frame` čte sonda záběru (P27A T6): hráč je hrdina, každý jiný kotouč kromě střely cíl nebo hrozba.
          <group key={disc.index} ref={(group) => { groups.current[disc.index] = group; }} userData={{ frame: disc.role === ROLE.player ? 'hero' : disc.role === ROLE.projectile ? undefined : 'target' }}>
            <mesh position={[0, tall / 2, 0]}>
              <cylinderGeometry args={[disc.w / 2, disc.w / 2, tall, 32]} />
              <meshStandardMaterial ref={(material) => { materials.current[disc.index] = material; }} color={color} roughness={0.5} />
            </mesh>
            {disc.role === ROLE.player && (
              <mesh position={[0, tall + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <ringGeometry args={[disc.w / 2 - 0.08, disc.w / 2, 32]} />
                <meshBasicMaterial color="#f8fafc" />
              </mesh>
            )}
          </group>
        );
      })}
      {targets?.(discs)}
    </>
  );
}

const DRAG_PX = 12;

/** Šipky/WASD (i dvě naráz = šikmo) a tah prstem = směr; puštěno = stát. */
export function useArenaInput(session: ArcadeSession, target: React.RefObject<HTMLDivElement | null>, active: boolean): void {
  useEffect(() => {
    const element = target.current;
    if (!active || element === null) return;
    const keys = new Set<string>();
    let drag: { readonly x: number; readonly y: number; dx: number; dz: number } | null = null;
    const sync = (): void => {
      const dx = (keys.has('right') ? 1 : 0) - (keys.has('left') ? 1 : 0);
      const dz = (keys.has('up') ? 1 : 0) - (keys.has('down') ? 1 : 0);
      if (dx !== 0 || dz !== 0) session.hold(arenaAxis(dx, dz));
      else session.hold(drag === null ? 0 : arenaAxis(drag.dx, drag.dz));
    };
    const keyOf = (key: string): string | null =>
      key === 'arrowleft' || key === 'a' ? 'left'
      : key === 'arrowright' || key === 'd' ? 'right'
      : key === 'arrowup' || key === 'w' ? 'up'
      : key === 'arrowdown' || key === 's' ? 'down'
      : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return;
      // Akce pravidel (P29A T6): mezerník = „action“, `e` = „alt“; F/J/Enter patří střelbě doplňku.
      const button = event.key === ' ' ? BUTTON.TAP : event.key.toLowerCase() === 'e' ? BUTTON.FIRE : 0;
      if (button !== 0) {
        event.preventDefault();
        if (!event.repeat) session.press(button);
        return;
      }
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      event.preventDefault();
      keys.add(key);
      sync();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const key = keyOf(event.key.toLowerCase());
      if (key === null) return;
      keys.delete(key);
      sync();
    };
    const onDown = (event: PointerEvent) => {
      // Tah, který vyjede z plátna, se musí pustit i venku – jinak hráč jede dál.
      element.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, dx: 0, dz: 0 };
      sync();
    };
    const onMove = (event: PointerEvent) => {
      if (drag === null) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (Math.hypot(dx, dy) < DRAG_PX) return;
      // Obrazovka dolů = −z jádra.
      drag.dx = Math.round(dx);
      drag.dz = Math.round(-dy);
      sync();
    };
    const onUp = () => {
      // Ťuk bez tahu = akce.
      if (drag !== null && drag.dx === 0 && drag.dz === 0) session.press(BUTTON.TAP);
      drag = null;
      sync();
    };
    const release = (): void => {
      keys.clear();
      drag = null;
      sync();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    element.addEventListener('pointerdown', onDown);
    element.addEventListener('pointermove', onMove);
    element.addEventListener('pointerup', onUp);
    element.addEventListener('pointercancel', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointercancel', release);
    };
  }, [session, target, active]);
}
