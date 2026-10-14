'use client';

/**
 * Varování průběhu ve scéně (P45C T15): telegraf každého těla chování, HP bosse
 * a záblesk okraje po blízkém minutí – v každé scéně, montuje je `Effects`.
 *
 * Kresba podle druhu varování (`telegraphOf`, jen ve fázi `telegraph`):
 * - `line` (ostřelovač, salva bosse, boss-terč): pás po zamčené přímce od
 *   střelce přes cíl dál, kudy výstřel poletí;
 * - `dash` / `lane` (flanker): pás výpadu ke zamčenému místu;
 * - `shake` (přepadník): „!“ nad hlavou a kroužek u nohou, obojí se chvěje;
 * - `ring`: kruh dosahu strážce, u bosse kruh dopadu dupnutí;
 * - `cluster` (hejno): kruh kolem celého sevřeného hejna se zvýrazněným okrajem.
 * Pohyb podle `09-motion.md`: nápřah (nástup 160 ms), houstnutí k úderu (pás
 * sílí a kruh se plní se zrychlením), úder = konec varování, kdy kresba zmizí.
 * Boss a boss-terč mají nad hlavou pipy HP (jeden na život ze startu), stejně boss finále jiného chování
 * (shazovač řízení a rváč skákačky, P46B T7) – soupeři úseků stejného chování ne.
 *
 * Těla chování a bosse kreslí scéna, která kreslí jejich roli (`World` každé
 * tělo, aréna stylu B i agar těla role `hazard`); boss je větší jen svým AABB.
 * Scény, které těla nekreslí (souboj dvou, načasování, rytmus), chování nemají
 * (`GENRE_PACING` jim dává `behaviours: []`), takže tu žádný model těla není.
 *
 * Do stavu hry nic nepíše: čte stav, předchozí stav a sběrnici efektů.
 * „Méně pohybu“ vypne chvění, nástup a záblesk okraje; pás a kruh zůstanou,
 * i jejich houstnutí – to je odpočet, informace, ne ozdoba.
 */

import { useFrame } from '@react-three/fiber';
import { type RefObject, useEffect, useMemo, useRef } from 'react';
import { CircleGeometry, Color, DoubleSide, type BufferGeometry, Group, Mesh, MeshBasicMaterial, PlaneGeometry, type Quaternion, RingGeometry } from 'three';

import { colorHex } from '@/brand/tokens';
import { type ArcadeState, BODY, FLAG, HEADER, UNIT, bodyBase, bodyHp } from '@/play/arcade/contract';
import { type BehaviourId, type BehaviourRef, type TelegraphKind, behaviourBodies, telegraphOf } from '@/play/arcade/pieces/behaviours';
import { BOSS } from '@/play/arcade/pieces/behaviours/boss';
import { GUARDIAN } from '@/play/arcade/pieces/behaviours/guardian';

import { type ArcadeSession, TICK_MS } from '../session';
import { type EffectsBus, type VisualEvent, pacingBossOf, pacingRefsOf } from './bus';
import { reducedMotion } from './feel';
import { renderHeld } from './render-feel';

/** Nástup varování (`duration-quick`) a záblesk okraje po blízkém minutí (`duration-base`), ms. */
export const APPEAR_MS = 160;
export const NEAR_MISS_FLASH_MS = 240;
/** Pás: šířka na začátku a na konci varování (m); přímka výstřelu pokračuje za cíl o tolik metrů. */
const STRIP_M = { from: 0.12, to: 0.6 } as const;
const LINE_PAST_M = 6;
/** Kresba leží kousek nad zemí, ať se s podlahou nepere. */
const GROUND_M = 0.04;
/** Chvění přepadníka: výchylka (m) a tempo (rad/ms). */
const SHAKE_M = 0.07;
const SHAKE_RATE = 0.09;
/** Hejno: tělo patří ke shluku, jehož první tělo je blíž než tohle (m); okraj o tolik za krajním tělem. */
const FLOCK_LINK_M = 2.5;
const FLOCK_MARGIN_M = 0.6;
/** Pipy HP: šířka, výška, mezera, rámeček (m) a výška nad hlavou. */
const PIP = { w: 0.4, h: 0.28, gap: 0.08, pad: 0.07, above: 0.5 } as const;

const GLOW = new Color(colorHex.tomato).multiplyScalar(1.5);
const FILL = new Color(colorHex.tomato);
const PIP_FULL = new Color(colorHex.tomato);
const PIP_EMPTY = new Color(colorHex['ink-soft']);
const PIP_FRAME = new Color(colorHex.ink);

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
/** `ease-standard` zhruba: rychlý nástup, měkký dojezd. */
const easeOut = (t: number): number => 1 - (1 - t) ** 3;
/** Houstnutí k úderu: zrychluje ke konci. */
const easeIn = (t: number): number => t * t;

/** Záblesk okraje `ms` po blízkém minutí (0..1), doznívá jako `ease-exit`; s „méně pohybu“ nic. */
export function nearMissFlash(ms: number, reduced: boolean): number {
  if (reduced || ms < 0 || ms >= NEAR_MISS_FLASH_MS) return 0;
  const t = ms / NEAR_MISS_FLASH_MS;
  return 1 - t * t * t;
}

/** Poslední blízké minutí mezi živými událostmi sběrnice (klíč `tik:tělo`), nebo `null`. */
export function latestNearMiss(events: readonly VisualEvent[]): string | null {
  let latest: VisualEvent | null = null;
  for (const event of events) if (event.kind === 'nearMiss' && (latest === null || event.tick >= latest.tick)) latest = event;
  return latest === null ? null : `${latest.tick}:${latest.body}`;
}

/** Co kresba v tomhle snímku ukazuje: varování podle druhu a těl, a HP bossů. */
export interface PacingCue {
  readonly kind: TelegraphKind;
  /** Těla, která varují (hejno jedním kruhem za všechna). */
  readonly bodies: readonly number[];
}

export interface PacingDrawn {
  readonly cues: readonly PacingCue[];
  readonly bosses: readonly { readonly body: number; readonly hp: number; readonly max: number }[];
}

export interface PacingFrame {
  readonly state: ArcadeState;
  /** Stav před posledním tikem (interpolace polohy); bez interpolace týž jako `state`. */
  readonly prev: ArcadeState;
  /** Podíl rozběhnutého tiku 0..1. */
  readonly alpha: number;
  /** Hodiny kresby (ms) – chvění. */
  readonly now: number;
  /** Natočení kamery: „!“ a pipy HP hledí do ní. */
  readonly facing: Quaternion;
  readonly reduced: boolean;
}

export interface PacingDrawing {
  readonly root: Group;
  update(frame: PacingFrame): PacingDrawn;
  dispose(): void;
}

/** Zásoba kousků kresby: `take` vrátí další volný (viditelný), `close` schová nepoužité. */
function pool<T extends Group>(root: Group, make: () => T): { take(): T; close(): void } {
  const items: T[] = [];
  let used = 0;
  return {
    take() {
      let item = items[used];
      if (item === undefined) {
        item = make();
        items.push(item);
        root.add(item);
      }
      used += 1;
      item.visible = true;
      return item;
    },
    close() {
      for (let i = used; i < items.length; i += 1) (items[i] as T).visible = false;
      used = 0;
    },
  };
}

/** Body chování a jejich chování; boss a strážce mají různý kruh, HP jen boss a boss-terč. */
function bodiesById(state: ArcadeState, refs: readonly BehaviourRef[]): [number, BehaviourId][] {
  const player = state[HEADER.player] as number;
  const ids = [...new Set(refs.map((ref) => ref.id))];
  return ids.flatMap((id) => behaviourBodies(state, player, refs.filter((ref) => ref.id === id)).map((body): [number, BehaviourId] => [body, id]));
}

/**
 * Kresba varování nad světem `refs` – trojrozměrné kousky v jedné skupině, které
 * `update` každý snímek postaví podle stavu; `boss` = předloha bosse finále (`pacingBossOf`). Stav jen čte.
 */
export function createPacingDrawing(refs: readonly BehaviourRef[], boss?: BehaviourRef): PacingDrawing {
  const root = new Group();
  root.name = 'pacing-fx';
  const geometries: BufferGeometry[] = [];
  const materials: MeshBasicMaterial[] = [];
  const geometry = <G extends BufferGeometry>(made: G): G => (geometries.push(made), made);
  const strip = geometry(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, 0.5));
  const ringThin = geometry(new RingGeometry(0.9, 1, 64).rotateX(-Math.PI / 2));
  const ringThick = geometry(new RingGeometry(0.74, 1, 48).rotateX(-Math.PI / 2));
  const disc = geometry(new CircleGeometry(1, 48).rotateX(-Math.PI / 2));
  const bangBar = geometry(new PlaneGeometry(0.24, 0.62).translate(0, 0.62, 0));
  const bangDot = geometry(new CircleGeometry(0.14, 20));
  const plane = geometry(new PlaneGeometry(1, 1));
  const material = (color: Color, opacity = 1): MeshBasicMaterial => {
    const made = new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, toneMapped: false, side: DoubleSide });
    materials.push(made);
    return made;
  };
  const mesh = (shape: BufferGeometry, paint: MeshBasicMaterial, order = 3): Mesh => {
    const made = new Mesh(shape, paint);
    made.renderOrder = order;
    made.userData.rigShadow = 'off';
    return made;
  };

  /** Pás výpadu nebo výstřelu: jedna síť, délka po místní +z. */
  const lines = pool(root, () => {
    const group = new Group();
    group.add(mesh(strip, material(GLOW)));
    return group;
  });
  /** Kruh: okraj a výplň, která se k úderu plní. */
  const rings = pool(root, () => {
    const group = new Group();
    group.add(mesh(ringThin, material(GLOW)), mesh(disc, material(FILL, 0.2), 2));
    return group;
  });
  /** Hejno: tlustý okraj a slabá výplň. */
  const flocks = pool(root, () => {
    const group = new Group();
    group.add(mesh(ringThick, material(GLOW)), mesh(disc, material(FILL, 0.2), 2));
    return group;
  });
  /** Přepadník: „!“ čelem ke kameře a kroužek u nohou. */
  const bangs = pool(root, () => {
    const group = new Group();
    const mark = new Group();
    mark.add(mesh(bangBar, material(GLOW), 5), mesh(bangDot, material(GLOW), 5));
    group.add(mark, mesh(ringThin, material(GLOW)));
    return group;
  });
  /** Pipy HP bosse: rámeček a až 15 pipů (HP v 4 bitech paměti). */
  const pips = pool(root, () => {
    const group = new Group();
    group.add(mesh(plane, material(PIP_FRAME, 0.85), 5));
    for (let k = 0; k < 15; k += 1) group.add(mesh(plane, material(PIP_FULL), 6));
    return group;
  });

  /** Délka varování po tělech (nejvyšší viděný odpočet této epizody) a nejvyšší HP bosse. */
  const warned = new Map<number, number>();
  const topHp = new Map<number, number>();
  let lastTick = -1;

  return {
    root,
    update({ state, prev, alpha, now, facing, reduced }) {
      const tick = state[HEADER.tick] as number;
      if (tick < lastTick) {
        warned.clear();
        topHp.clear();
      }
      lastTick = tick;
      const at = (body: number, slot: 'x' | 'y' | 'z'): number => {
        const base = bodyBase(body) + BODY[slot];
        const before = prev[base] ?? state[base] ?? 0;
        return (before + ((state[base] as number) - before) * alpha) / UNIT;
      };
      const size = (body: number, slot: 'w' | 'h' | 'd'): number => (state[bodyBase(body) + BODY[slot]] as number) / UNIT;
      const cues: PacingCue[] = [];
      const bosses: { body: number; hp: number; max: number }[] = [];
      const flock: { body: number; x: number; z: number; r: number; p: number }[] = [];
      const telegraphing = new Set<number>();
      const finaleBoss = boss === undefined ? [] : behaviourBodies(state, state[HEADER.player] as number, [boss]);

      for (const [body, id] of bodiesById(state, refs)) {
        const x = -at(body, 'x');
        const y = at(body, 'y');
        const z = at(body, 'z');
        if (id === 'boss' || id === 'turret' || finaleBoss.includes(body)) {
          const hp = bodyHp(state, body);
          const max = Math.max(topHp.get(body) ?? 0, hp);
          topHp.set(body, max);
          if (max > 0) {
            bosses.push({ body, hp, max });
            const bar = pips.take();
            bar.userData.bossHp = { body, hp, max };
            bar.position.set(x, y + size(body, 'h') + PIP.above, z);
            bar.quaternion.copy(facing);
            const width = max * PIP.w + (max - 1) * PIP.gap;
            const [frame, ...cells] = bar.children as Mesh[];
            frame!.scale.set(width + 2 * PIP.pad, PIP.h + 2 * PIP.pad, 1);
            frame!.position.z = -0.01;
            cells.forEach((cell, k) => {
              cell.visible = k < max;
              if (k >= max) return;
              cell.scale.set(PIP.w, PIP.h, 1);
              cell.position.x = -width / 2 + PIP.w / 2 + k * (PIP.w + PIP.gap);
              (cell.material as MeshBasicMaterial).color.copy(k < hp ? PIP_FULL : PIP_EMPTY);
            });
          }
        }
        const telegraph = telegraphOf(state, body);
        if (telegraph === null) continue;
        telegraphing.add(body);
        const total = Math.max(warned.get(body) ?? 0, telegraph.ticksLeft);
        warned.set(body, total);
        // Průběh varování 0..1 i s rozběhnutým tikem; nástup jen na začátku, s „méně pohybu“ hned celý.
        const elapsed = total - telegraph.ticksLeft + alpha;
        const p = clamp01(elapsed / total);
        const appear = reduced ? 1 : easeOut(clamp01((elapsed * TICK_MS) / APPEAR_MS));
        const urge = easeIn(p);
        const ground = y + GROUND_M;
        if (telegraph.kind === 'cluster') {
          flock.push({ body, x, z, r: Math.max(size(body, 'w'), size(body, 'd')) / 2, p: urge });
          continue;
        }
        cues.push({ kind: telegraph.kind, bodies: [body] });
        if (telegraph.kind === 'line' || telegraph.kind === 'dash' || telegraph.kind === 'lane') {
          const line = lines.take();
          line.userData.cue = { kind: telegraph.kind, bodies: [body] };
          const dx = -telegraph.aim.x / UNIT - x;
          const dz = telegraph.aim.z / UNIT - z;
          const reach = Math.hypot(dx, dz);
          const length = (telegraph.kind === 'line' ? reach + LINE_PAST_M : Math.max(reach, 0.5)) * appear;
          line.position.set(x, ground, z);
          line.rotation.set(0, Math.atan2(dx, dz), 0);
          const band = line.children[0] as Mesh;
          band.scale.set(STRIP_M.from + (STRIP_M.to - STRIP_M.from) * urge, 1, length);
          (band.material as MeshBasicMaterial).opacity = 0.4 + 0.5 * urge;
        } else if (telegraph.kind === 'ring') {
          // Strážce: dosah, odkud vyrazí; boss: dopad dupnutí.
          const radius = (id === 'boss' ? BOSS.stomp : GUARDIAN.reach) / UNIT;
          const ring = rings.take();
          ring.userData.cue = { kind: 'ring', bodies: [body] };
          ring.position.set(x, ground, z);
          const [edge, fill] = ring.children as [Mesh, Mesh];
          edge.scale.setScalar(radius * appear);
          (edge.material as MeshBasicMaterial).opacity = 0.6 + 0.4 * urge;
          fill.scale.setScalar(radius * (0.12 + 0.88 * urge));
          (fill.material as MeshBasicMaterial).opacity = 0.18 + 0.27 * urge;
        } else if (telegraph.kind === 'shake') {
          const bang = bangs.take();
          bang.userData.cue = { kind: 'shake', bodies: [body] };
          const [mark, ring] = bang.children as [Group, Mesh];
          const tremble = reduced ? 0 : SHAKE_M * (0.5 + urge) * Math.sin(now * SHAKE_RATE + body);
          bang.position.set(x, y, z);
          mark.position.set(tremble, size(body, 'h') + 0.35, 0);
          mark.quaternion.copy(facing);
          mark.scale.setScalar(appear * (1 + 0.15 * urge));
          ring.position.set(0, GROUND_M, 0);
          ring.scale.setScalar((Math.max(size(body, 'w'), size(body, 'd')) / 2 + 0.35) * appear + (reduced ? 0 : Math.abs(tremble)));
          (ring.material as MeshBasicMaterial).opacity = 0.6 + 0.4 * urge;
        }
      }

      // Hejno: shluky po prvním těle, jeden kruh kolem každého.
      const groups: (typeof flock)[] = [];
      for (const member of flock) {
        const home = groups.find((group) => Math.hypot(group[0]!.x - member.x, group[0]!.z - member.z) <= FLOCK_LINK_M);
        if (home === undefined) groups.push([member]);
        else home.push(member);
      }
      for (const group of groups) {
        const cx = group.reduce((sum, member) => sum + member.x, 0) / group.length;
        const cz = group.reduce((sum, member) => sum + member.z, 0) / group.length;
        const radius = Math.max(...group.map((member) => Math.hypot(member.x - cx, member.z - cz) + member.r)) + FLOCK_MARGIN_M;
        const urge = Math.max(...group.map((member) => member.p));
        const bodies = group.map((member) => member.body);
        cues.push({ kind: 'cluster', bodies });
        const ring = flocks.take();
        ring.userData.cue = { kind: 'cluster', bodies };
        ring.position.set(cx, GROUND_M, cz);
        const [edge, fill] = ring.children as [Mesh, Mesh];
        edge.scale.setScalar(radius);
        (edge.material as MeshBasicMaterial).opacity = 0.7 + 0.3 * urge;
        fill.scale.setScalar(radius);
        (fill.material as MeshBasicMaterial).opacity = 0.15 + 0.25 * urge;
      }

      for (const body of warned.keys()) if (!telegraphing.has(body)) warned.delete(body);
      for (const body of topHp.keys()) if (((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) === 0) topHp.delete(body);
      lines.close();
      rings.close();
      flocks.close();
      bangs.close();
      pips.close();
      return { cues, bosses };
    },
    dispose() {
      for (const made of geometries) made.dispose();
      for (const made of materials) made.dispose();
    },
  };
}

/** Kresba varování průběhu a záblesk okraje po blízkém minutí; hra bez chování nekreslí nic. */
export function PacingFx({ session, bus, surface }: { readonly session: ArcadeSession; readonly bus: RefObject<EffectsBus | null>; readonly surface: RefObject<HTMLDivElement | null> }) {
  const drawing = useMemo(() => {
    const refs = pacingRefsOf(session.world.rules);
    return refs.length === 0 ? null : createPacingDrawing(refs, pacingBossOf(session.world.rules));
  }, [session]);
  useEffect(() => () => drawing?.dispose(), [drawing]);
  const edge = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const host = surface.current;
    if (drawing === null || host === null) return;
    const element = document.createElement('div');
    element.className = 'play-near-miss';
    element.setAttribute('aria-hidden', 'true');
    // Záblesk okraje: plný rámeček barvy odměny (ne rajčatová – ta je zásah), bez rozmazání.
    element.style.cssText = 'position:absolute;inset:0;z-index:1;pointer-events:none;box-shadow:inset 0 0 0 10px var(--sp-color-sun);opacity:0';
    host.append(element);
    edge.current = element;
    return () => {
      element.remove();
      edge.current = null;
      delete host.dataset.telegraphs;
    };
  }, [drawing, surface]);
  const clock = useRef(0);
  const flash = useRef<{ key: string | null; at: number }>({ key: null, at: -Infinity });
  const shown = useRef(-1);
  const lit = useRef('0.00');
  useFrame(({ camera }, delta) => {
    if (drawing === null) return;
    clock.current += delta * 1000;
    if (renderHeld(session)) return;
    const reduced = reducedMotion();
    const drawn = drawing.update({ state: session.state(), prev: session.prev(), alpha: session.alpha(), now: clock.current, facing: camera.quaternion, reduced });
    // Sonda e2e: kolik varování scéna právě kreslí.
    if (surface.current !== null && drawn.cues.length !== shown.current) {
      shown.current = drawn.cues.length;
      surface.current.dataset.telegraphs = String(drawn.cues.length);
    }
    const latest = latestNearMiss(bus.current?.live() ?? []);
    if (latest !== null && latest !== flash.current.key) flash.current = { key: latest, at: clock.current };
    const glow = nearMissFlash(clock.current - flash.current.at, reduced).toFixed(2);
    if (edge.current !== null && glow !== lit.current) edge.current.style.opacity = lit.current = glow;
  });
  return drawing === null ? null : <primitive object={drawing.root} />;
}
