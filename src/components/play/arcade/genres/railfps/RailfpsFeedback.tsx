'use client';

/**
 * Odezva zásahu střelnice z očí (P68-F T8). Jen čte: efekty tiku z `session.onEvents` (vzor `comboOf` v `feel.ts`
 * a `onHookEffects` v `effects/bus.ts`) a stav před tikem a po něm. Do relace, stavu ani hashe nezapíše nic – zdroj
 * je `EffectsSource` sběrnice, který stisknout, pozastavit ani restartovat neumí.
 *
 * - **výstřel** → záblesk u spodního okraje pásu hry a krátký paprsek odtud do zaměřovače. Rána padá vždy do sektoru,
 *   kam kamera hledí (`aimTick` střílí až po dorazu natočení), takže paprsek do sektoru je na obrazovce svislý pruh
 *   do středu záběru;
 * - **zásah** (cíl zmizel ranou, nebo boss ztratil HP) → značka zásahu na zaměřovači (`railfps-hit-marker`; rajčatová
 *   za sražený cíl, slunečná za ubrané HP) a u sraženého cíle rozpad na střepy ve scéně – nejvýš `FEEDBACK.particles`
 *   naráz, novější rozpad bere místo staršímu;
 * - **ztráta života** → otřes záběru (posun v px, nejvýš 6 px na 200 ms podle `08-game-hud.md`; s „méně pohybu“ žádný)
 *   a rajčatový okraj obrazovky;
 * - **minutí** (výstřel bez zásahu) → slabý kroužek kolem zaměřovače (`railfps-miss-marker`) místo značky.
 *
 * Rána do prázdného sektoru nevydá žádný efekt, takže ji `onEvents` nevidí. Pozná se po oznámení relace podle
 * odpočtu míření na držáku (`aimOf().cooldown`): rána ho nastaví na `RAILFPS.fireInterval`, přestávka mezi koly ho
 * drží. Mezi dvěma oznámeními padne nejvýš jedna rána (rozestup 12 tiků), takže stačí vědět, jestli ji už viděla
 * cesta efektů. Jako sběrnice jen za člověka: ukázka ani přehrání záznamu nic nevydají.
 *
 * Čas odezvy je čas kresby (ms) – součet `delta` snímků, ne hodiny tiků. Otřes předává scéně (`kick`), která ho přičte
 * k posunu záběru až po své póze kamery.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { type RefObject, useEffect, useRef } from 'react';
import { Color, Euler, type InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';

import { colorHex, space } from '@/brand/tokens';
import { type ArcadeEffect, type ArcadeState, BODY, COUNTER, HEADER, bodyBase, bodyHp } from '@/play/arcade/contract';
import { RAILFPS, aimOf, foeDistance, isAlive, isEnemy, isFoe, shotOf } from '@/play/arcade/pieces/railfps-world';

import type { EffectsSource } from '../../effects/bus';
import { reducedMotion } from '../../effects/feel';
import { type PlayRect, playRect, usePlayRectRef } from '../../portrait-frame';
import { HUD_BAND_PX, THUMB_ZONE_PX } from '../portrait-first';
import { scenePoint } from './railfps-camera';

/** Délky a míry odezvy (ms, px, m). */
export const FEEDBACK = {
  /** Záblesk u hlavně a paprsek do zaměřovače. */
  flashMs: 80,
  beamMs: 100,
  /** Značka zásahu drží plně, pak dohasne. */
  markerHoldMs: 250,
  markerMs: 450,
  /** Kroužek minutí. */
  missMs: 240,
  /** Otřes po ztrátě života: nejvýš 6 px na 200 ms (`docs/brand/docs/08-game-hud.md`). */
  shakeMs: 200,
  shakePx: 6,
  /** Rajčatový okraj obrazovky po ztrátě života. */
  edgeMs: 450,
  /** Rozpad: střepů na sražený cíl, strop živých střepů naráz, život, rychlost (m/s), tíže (m/s²), hrana střepu (m). */
  burst: 8,
  particles: 12,
  burstMs: 450,
  speed: 3.2,
  gravity: 9,
  shard: 0.16,
} as const;

/** Co se v tiku stalo, jak to odezva vidí. `at` je střed sraženého těla ve scéně (m). */
export type RailfpsCue =
  | { readonly kind: 'shot'; readonly tick: number }
  | { readonly kind: 'miss'; readonly tick: number }
  | { readonly kind: 'hit'; readonly tick: number; readonly kill: boolean; readonly tone: Tone; readonly at: readonly [number, number, number] }
  | { readonly kind: 'hurt'; readonly tick: number };

export type Tone = 'target' | 'enemy';

const healthOf = (state: ArcadeState): number => state[HEADER.counters + COUNTER.health] as number;

/** Střed těla ve scéně (m); mrtvé tělo drží polohu z tiku zániku. */
function centerOf(state: ArcadeState, body: number): readonly [number, number, number] {
  const base = bodyBase(body);
  const at = scenePoint(state[base + BODY.x] as number, (state[base + BODY.y] as number) + (state[base + BODY.h] as number) / 2, state[base + BODY.z] as number);
  return [at.x, at.y, at.z];
}

/**
 * Odezva jednoho tiku z jeho efektů; `state` je stav po tiku, `prev` před ním, `keeper` držák míření. Jen čte.
 *
 * Výstřel = slot rány držáku se v tiku rozsvítil (`shotOf` po tiku, ne před ním – přestávka mezi koly drží slot
 * poslední rány a ta by jinak střílela každý tik). Zásah = cíl, který ranou zmizel (`despawn` dál než `reach`; na
 * `reach` mizí nepřítel, který vzal život) nebo ztratil HP (`hit`). Ztráta života = `damage`, po kterém životy
 * opravdu klesly. Minutí = výstřel bez zásahu.
 */
export function railfpsCuesOf(effects: readonly ArcadeEffect[], tick: number, state: ArcadeState, prev: ArcadeState, keeper: number): RailfpsCue[] {
  const shot = shotOf(state, keeper) !== null && shotOf(prev, keeper) === null;
  const player = state[HEADER.player] as number;
  const count = state[HEADER.bodyCount] as number;
  const hits: RailfpsCue[] = [];
  const seen = new Set<number>();
  let hurt = false;
  for (const effect of effects) {
    if (effect.kind === 'damage') {
      hurt ||= effect.amount > 0 && healthOf(state) < healthOf(prev);
      continue;
    }
    if (!shot || (effect.kind !== 'despawn' && effect.kind !== 'hit')) continue;
    const body = effect.body;
    if (body < 0 || body >= count || body === player || seen.has(body) || !isAlive(prev, body) || !isFoe(prev, body)) continue;
    const kill = !isAlive(state, body);
    const landed = effect.kind === 'despawn' ? kill && foeDistance(state, body) > RAILFPS.reach : effect.amount > 0 && (kill || bodyHp(state, body) < bodyHp(prev, body));
    if (!landed) continue;
    seen.add(body);
    hits.push({ kind: 'hit', tick, kill, tone: isEnemy(prev, body) ? 'enemy' : 'target', at: centerOf(state, body) });
  }
  const cues: RailfpsCue[] = shot ? [{ kind: 'shot', tick }, ...(hits.length === 0 ? [{ kind: 'miss', tick } as const] : hits)] : [];
  if (hurt) cues.push({ kind: 'hurt', tick });
  return cues;
}

// ---------------------------------------------------------------------------
// Stopy odezvy v čase kresby

export type MarkKind = 'flash' | 'beam' | 'marker' | 'miss' | 'burst' | 'shake' | 'edge';
export const MARK_KINDS: readonly MarkKind[] = ['flash', 'beam', 'marker', 'miss', 'burst', 'shake', 'edge'];

export interface Mark {
  readonly kind: MarkKind;
  /** Začátek v čase kresby (ms). */
  readonly at: number;
  /** Značka: sražený cíl (rajčatová), nebo ubrané HP (slunečná). */
  readonly kill?: boolean;
  /** Rozpad: barva a střed (m). */
  readonly tone?: Tone;
  readonly origin?: readonly [number, number, number];
}

const LIFE: Readonly<Record<MarkKind, number>> = {
  flash: FEEDBACK.flashMs,
  beam: FEEDBACK.beamMs,
  marker: FEEDBACK.markerMs,
  miss: FEEDBACK.missMs,
  burst: FEEDBACK.burstMs,
  shake: FEEDBACK.shakeMs,
  edge: FEEDBACK.edgeMs,
};

const liveAt = (mark: Mark, now: number): boolean => now - mark.at < LIFE[mark.kind];

/** Stopy z odezvy tiku v čase `now`; s „méně pohybu“ ztráta života otřes nevydá (okraj ano). */
export function marksOf(cues: readonly RailfpsCue[], now: number, reduced: boolean): Mark[] {
  return cues.flatMap((cue): Mark[] => {
    switch (cue.kind) {
      case 'shot':
        return [
          { kind: 'flash', at: now },
          { kind: 'beam', at: now },
        ];
      case 'miss':
        return [{ kind: 'miss', at: now }];
      case 'hit':
        return cue.kill
          ? [
              { kind: 'marker', at: now, kill: true },
              { kind: 'burst', at: now, tone: cue.tone, origin: cue.at },
            ]
          : [{ kind: 'marker', at: now, kill: false }];
      case 'hurt':
        return reduced ? [{ kind: 'edge', at: now }] : [{ kind: 'edge', at: now }, { kind: 'shake', at: now }];
    }
  });
}

export type MarkCounts = Record<MarkKind, number>;
export const countMarks = (marks: readonly Mark[]): MarkCounts => {
  const counts = Object.fromEntries(MARK_KINDS.map((kind) => [kind, 0])) as MarkCounts;
  for (const mark of marks) counts[mark.kind] += 1;
  return counts;
};

export interface Particle {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Hrana střepu (m) a natočení (rad). */
  readonly size: number;
  readonly spin: number;
  readonly tone: Tone;
}

export interface FeedbackShake {
  readonly x: number;
  readonly y: number;
}
export const NO_SHAKE: FeedbackShake = { x: 0, y: 0 };

/** Co kreslit v čase `now`: krytí 0..1 (0 = skrýt), měřítka a otřes v px, živé střepy. */
export interface FeedbackFrame {
  readonly flash: number;
  readonly beam: number;
  readonly marker: number;
  readonly kill: boolean;
  /** Značka naskočí o čtvrtinu větší a sedne na 1. */
  readonly pop: number;
  readonly miss: number;
  /** Kroužek minutí roste 0..1. */
  readonly spread: number;
  readonly edge: number;
  readonly shake: FeedbackShake;
  readonly particles: readonly Particle[];
}

/** Nejmladší živá stopa druhu `kind` a její stáří (ms). */
function latest(marks: readonly Mark[], kind: MarkKind, now: number): { readonly mark: Mark; readonly age: number } | null {
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const mark = marks[i] as Mark;
    if (mark.kind === kind && liveAt(mark, now)) return { mark, age: Math.max(0, now - mark.at) };
  }
  return null;
}

const fade = (age: number | undefined, life: number): number => (age === undefined ? 0 : Math.max(0, 1 - age / life));

/** Střepy živých rozpadů od nejmladšího, nejvýš `FEEDBACK.particles`; dráha z času, ne z náhody. */
function particlesOf(marks: readonly Mark[], now: number): Particle[] {
  const out: Particle[] = [];
  for (let i = marks.length - 1; i >= 0 && out.length < FEEDBACK.particles; i -= 1) {
    const mark = marks[i] as Mark;
    if (mark.kind !== 'burst' || mark.origin === undefined || !liveAt(mark, now)) continue;
    const t = Math.max(0, now - mark.at) / 1000;
    const left = 1 - Math.max(0, now - mark.at) / FEEDBACK.burstMs;
    const [x, y, z] = mark.origin;
    for (let k = 0; k < FEEDBACK.burst && out.length < FEEDBACK.particles; k += 1) {
      // Vějíř do stran a nahoru: kamera kouká po paprsku sektoru, střepy letí napříč ním.
      const angle = (k / FEEDBACK.burst) * 2 * Math.PI + 0.4;
      const rise = 0.55 + 0.25 * (k % 3);
      const v = FEEDBACK.speed * (0.8 + 0.1 * (k % 4));
      out.push({
        x: x + Math.cos(angle) * v * t,
        y: y + (rise * v - (FEEDBACK.gravity * t) / 2) * t,
        z: z + Math.sin(angle) * v * t * 0.5,
        size: FEEDBACK.shard * Math.max(0.2, left),
        spin: t * (6 + k),
        tone: mark.tone ?? 'target',
      });
    }
  }
  return out;
}

/** Obraz odezvy v čase `now`. Čistá funkce stop – týž seznam a čas dají týž obraz. */
export function feedbackFrame(marks: readonly Mark[], now: number, reduced: boolean): FeedbackFrame {
  const marker = latest(marks, 'marker', now);
  const miss = latest(marks, 'miss', now);
  const shake = reduced ? null : latest(marks, 'shake', now);
  let kick = NO_SHAKE;
  if (shake !== null) {
    // Tlumený kmit: výchylka ze stáří, ne z náhody – týž zásah třese stejně.
    const amp = FEEDBACK.shakePx * (1 - shake.age / FEEDBACK.shakeMs) ** 2;
    kick = { x: Math.round(amp * Math.sin(shake.age * 0.11) * 100) / 100, y: Math.round(amp * Math.cos(shake.age * 0.083) * 100) / 100 };
  }
  return {
    flash: fade(latest(marks, 'flash', now)?.age, FEEDBACK.flashMs),
    beam: fade(latest(marks, 'beam', now)?.age, FEEDBACK.beamMs),
    marker: marker === null ? 0 : marker.age < FEEDBACK.markerHoldMs ? 1 : Math.max(0, 1 - (marker.age - FEEDBACK.markerHoldMs) / (FEEDBACK.markerMs - FEEDBACK.markerHoldMs)),
    kill: marker?.mark.kill ?? false,
    pop: marker === null ? 1 : 1 + 0.25 * Math.max(0, 1 - marker.age / 90),
    miss: fade(miss?.age, FEEDBACK.missMs) * 0.85,
    spread: miss === null ? 0 : Math.min(1, miss.age / FEEDBACK.missMs),
    edge: fade(latest(marks, 'edge', now)?.age, FEEDBACK.edgeMs),
    shake: kick,
    particles: particlesOf(marks, now),
  };
}

// ---------------------------------------------------------------------------
// Pozorovatel relace

export interface RailfpsFeedbackCore {
  /** Obraz v čase kresby `now`; zahodí stopy, kterým doběhl život. */
  frame(now: number, reduced?: boolean): FeedbackFrame;
  /** Kolik stop kterého druhu vzniklo od připojení (sonda testu). */
  counts(): MarkCounts;
  dispose(): void;
}

/**
 * Připojí odezvu k relaci. `now` je čas kresby (ms), `reduced` přání „méně pohybu“. Restart relace (tik zpět)
 * zahodí živé stopy. Ze zdroje volá jen `onEvents`, `subscribe`, `state`, `prev` a `humanRun`.
 */
export function createRailfpsFeedback(source: EffectsSource, keeper: number, now: () => number, reduced: () => boolean = reducedMotion): RailfpsFeedbackCore {
  let marks: Mark[] = [];
  const started = countMarks([]);
  let seen = source.state()[HEADER.tick] as number;
  let cooldown = aimOf(source.state(), keeper).cooldown;
  /** Rány, které od posledního oznámení viděla cesta efektů. */
  let shots = 0;
  const add = (cues: readonly RailfpsCue[]): void => {
    if (cues.length === 0) return;
    const at = now();
    const made = marksOf(cues, at, reduced());
    marks = marks.filter((mark) => liveAt(mark, at)).concat(made);
    for (const mark of made) started[mark.kind] += 1;
  };
  const offEvents = source.onEvents((effects, tick) => {
    const cues = railfpsCuesOf(effects, tick, source.state(), source.prev(), keeper);
    if (cues.some((cue) => cue.kind === 'shot')) shots += 1;
    add(cues);
  });
  const offState = source.subscribe(() => {
    const state = source.state();
    const tick = state[HEADER.tick] as number;
    if (tick < seen) marks = [];
    seen = tick;
    const next = aimOf(state, keeper).cooldown;
    // Rána bez efektů tiku: odpočet vyskočil a cesta efektů ji neviděla – minutí do prázdného sektoru.
    if (next > cooldown && shots === 0 && source.humanRun()) add([{ kind: 'shot', tick: tick - 1 }, { kind: 'miss', tick: tick - 1 }]);
    cooldown = next;
    shots = 0;
  });
  return {
    frame: (at, still = reduced()) => {
      if (marks.length > 0 && !marks.every((mark) => liveAt(mark, at))) marks = marks.filter((mark) => liveAt(mark, at));
      return feedbackFrame(marks, at, still);
    },
    counts: () => ({ ...started }),
    dispose: () => {
      offEvents();
      offState();
      marks = [];
    },
  };
}

// ---------------------------------------------------------------------------
// Kresba: DOM nad plátnem a střepy ve scéně

/** Paprsek začíná pod okrajem prstence zaměřovače (`CROSSHAIR.px` scény), záblesk sedí kousek nad spodní hranou pásu (px). */
const RING_PX = space['4'];
const MUZZLE_LIFT_PX = space['2'];
/** Hvězda záblesku (pět cípů) – výřez, ne obrázek. */
const STAR = 'polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)';
/** Společný základ prvků odezvy: nad plátnem, pod HUD, ťuky propouští na plátno. */
const LAYER = 'position:absolute;pointer-events:none;z-index:1;';

interface Overlay {
  paint(frame: FeedbackFrame, rect: PlayRect): void;
  remove(): void;
}

/** Prvky odezvy na ploše hry; píšou se jen hodnoty, které se změnily. */
function mountOverlay(host: HTMLElement): Overlay {
  const made: HTMLElement[] = [];
  const make = (testId: string, css: string): HTMLDivElement => {
    const element = document.createElement('div');
    element.dataset.testid = testId;
    element.setAttribute('aria-hidden', 'true');
    element.style.cssText = css;
    element.hidden = true;
    made.push(element);
    host.append(element);
    return element;
  };
  const part = (css: string, parent: HTMLElement): void => {
    const element = document.createElement('div');
    element.style.cssText = css;
    parent.append(element);
  };
  // Záblesk u hlavně: slunečná hvězda s papírovým jádrem, střed kousek nad spodní hranou pásu hry.
  const flash = make('railfps-muzzle-flash', `${LAYER}left:50%;width:var(--sp-space-16);height:var(--sp-space-16);margin:calc(var(--sp-space-16) / -2) 0 0 calc(var(--sp-space-16) / -2);background:var(--sp-color-sun);clip-path:${STAR};`);
  part(`position:absolute;inset:28%;background:var(--sp-color-paper);clip-path:${STAR};`, flash);
  // Paprsek: zužující se slunečný pruh od hlavně k okraji zaměřovače.
  const beam = make('railfps-beam', `${LAYER}left:50%;width:var(--sp-space-3);margin-left:calc(var(--sp-space-3) / -2);background:var(--sp-color-sun);clip-path:polygon(38% 0,62% 0,100% 100%,0 100%);`);
  // Značka zásahu: čtyři šikmé čárky kolem prstence zaměřovače, barva v `--_tick`.
  const marker = make('railfps-hit-marker', `${LAYER}left:50%;width:var(--sp-space-16);height:var(--sp-space-16);margin:calc(var(--sp-space-16) / -2) 0 0 calc(var(--sp-space-16) / -2);`);
  // Šikmá čárka je pruh přechodu ve čtverci posunutém po úhlopříčce – kit nepovoluje `rotate` (brand-guard).
  for (const [x, y] of [[1, 1], [-1, 1], [-1, -1], [1, -1]] as const) {
    const angle = x === y ? 45 : 135;
    part(
      `position:absolute;left:50%;top:50%;width:var(--sp-space-4);height:var(--sp-space-4);margin:calc(var(--sp-space-4) / -2) 0 0 calc(var(--sp-space-4) / -2);background:linear-gradient(${String(angle)}deg,transparent 30%,var(--sp-color-ink) 30% 41%,var(--_tick) 41% 59%,var(--sp-color-ink) 59% 70%,transparent 70%);transform:translate(calc((var(--sp-space-5) + var(--sp-space-0_5)) * ${String(0.7071 * x)}),calc((var(--sp-space-5) + var(--sp-space-0_5)) * ${String(0.7071 * y)}));`,
      marker,
    );
  }
  // Minutí: tenký papírový kroužek s inkoustovou linkou, roste a mizí – slabší než značka a bez její barvy.
  const miss = make('railfps-miss-marker', `${LAYER}left:50%;width:var(--sp-space-10);height:var(--sp-space-10);margin:calc(var(--sp-space-10) / -2) 0 0 calc(var(--sp-space-10) / -2);border-radius:50%;border:var(--sp-border-thin) solid var(--sp-color-paper);box-shadow:0 0 0 var(--sp-space-0_5) var(--sp-color-ink-soft);box-sizing:border-box;`);
  // Ztráta života: plný rajčatový rámeček obrazovky, bez rozmazání (jako záblesk blízkého minutí v `PacingFx`).
  const edge = make('railfps-hurt-edge', `${LAYER}inset:0;box-shadow:inset 0 0 0 var(--sp-space-3) var(--sp-color-tomato);`);

  const written = new Map<string, string>();
  const set = (element: HTMLElement, key: string, prop: string, value: string): void => {
    const id = `${element.dataset.testid ?? ''}:${key}`;
    if (written.get(id) === value) return;
    written.set(id, value);
    element.style.setProperty(prop, value);
  };
  const show = (element: HTMLElement, opacity: number): boolean => {
    const on = opacity > 0;
    if (element.hidden === on) element.hidden = !on;
    if (on) set(element, 'opacity', 'opacity', opacity.toFixed(2));
    return on;
  };
  return {
    paint(frame, rect) {
      const horizon = Math.round((rect.px.top + rect.px.bottom) / 2);
      const muzzle = Math.round(rect.px.bottom) - MUZZLE_LIFT_PX;
      if (show(flash, frame.flash)) {
        set(flash, 'top', 'top', `${String(muzzle)}px`);
        set(flash, 'transform', 'transform', `scale(${(1.15 - 0.45 * frame.flash).toFixed(2)})`);
      }
      if (show(beam, frame.beam)) {
        const top = horizon + RING_PX;
        set(beam, 'top', 'top', `${String(top)}px`);
        set(beam, 'height', 'height', `${String(Math.max(0, muzzle - top))}px`);
      }
      if (show(marker, frame.marker)) {
        set(marker, 'top', 'top', `${String(horizon)}px`);
        set(marker, 'tick', '--_tick', frame.kill ? 'var(--sp-color-tomato)' : 'var(--sp-color-sun)');
        set(marker, 'transform', 'transform', `scale(${frame.pop.toFixed(2)})`);
        const kind = frame.kill ? 'kill' : 'hit';
        if (marker.dataset.kind !== kind) marker.dataset.kind = kind;
      }
      if (show(miss, frame.miss)) {
        set(miss, 'top', 'top', `${String(horizon)}px`);
        set(miss, 'transform', 'transform', `scale(${(0.9 + 0.5 * frame.spread).toFixed(2)})`);
      }
      show(edge, frame.edge);
    },
    remove() {
      for (const element of made) element.remove();
    },
  };
}

const TONES: Readonly<Record<Tone, Color>> = { target: new Color(colorHex.sun), enemy: new Color(colorHex.tomato) };

/**
 * Odezva ve scéně a nad ní. `kick` dostane otřes záběru v px – scéna ho přičte k posunu záběru po své póze kamery.
 * Střepy jsou jedna instancovaná síť o `FEEDBACK.particles` kusech.
 */
export function RailfpsFeedback({ session, keeper, surface, kick }: { readonly session: EffectsSource; readonly keeper: number; readonly surface: RefObject<HTMLDivElement | null>; readonly kick: RefObject<FeedbackShake> }) {
  const size = useThree((three) => three.size);
  const measured = usePlayRectRef();
  const clock = useRef(0);
  const core = useRef<RailfpsFeedbackCore | null>(null);
  const overlay = useRef<Overlay | null>(null);
  const shards = useRef<InstancedMesh | null>(null);
  const scratch = useRef({ matrix: new Matrix4(), position: new Vector3(), rotation: new Quaternion(), euler: new Euler(), scale: new Vector3() });

  useEffect(() => {
    const created = createRailfpsFeedback(session, keeper, () => clock.current);
    core.current = created;
    return () => {
      created.dispose();
      core.current = null;
      kick.current = NO_SHAKE;
    };
  }, [session, keeper, kick]);

  useEffect(() => {
    const host = surface.current;
    if (host === null) return;
    const made = mountOverlay(host);
    overlay.current = made;
    return () => {
      made.remove();
      overlay.current = null;
    };
  }, [surface]);

  useEffect(() => {
    const mesh = shards.current;
    if (mesh === null) return;
    // Barvy instancí se alokují jednou; síť začíná prázdná.
    for (let i = 0; i < FEEDBACK.particles; i += 1) mesh.setColorAt(i, TONES.target);
    mesh.count = 0;
  }, []);

  useFrame((_, delta) => {
    clock.current += delta * 1000;
    const frame = core.current?.frame(clock.current);
    if (frame === undefined) return;
    kick.current = frame.shake;
    overlay.current?.paint(frame, measured.current ?? playRect(size, HUD_BAND_PX, size.height - THUMB_ZONE_PX));
    const mesh = shards.current;
    if (mesh === null || (frame.particles.length === 0 && mesh.count === 0)) return;
    const { matrix, position, rotation, euler, scale } = scratch.current;
    frame.particles.forEach((piece, i) => {
      position.set(piece.x, piece.y, piece.z);
      rotation.setFromEuler(euler.set(piece.spin, piece.spin * 0.7, 0));
      scale.setScalar(piece.size);
      mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
      mesh.setColorAt(i, TONES[piece.tone]);
    });
    mesh.count = frame.particles.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={shards} args={[undefined, undefined, FEEDBACK.particles]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
