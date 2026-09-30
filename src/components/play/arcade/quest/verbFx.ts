/**
 * Efekty sloves úkolu (P32G T5): co předmět v každém stavu vypouští a čím
 * svítí, jaký model ho kreslí a čím bouchne, když ho sloveso posune dál.
 * Čistá data bez rendereru – kreslí je `TargetStates.tsx`.
 *
 * Druh slovesa (`verbKind`) dává modul žánru (`genre/quest.ts`); tady se jen
 * mapuje na vzhled. Barvy jsou z tokenů značky, žádný surový hex.
 */

import { color as brand } from '@/brand/tokens';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { type VerbKind, verbKindOf } from '@/play/genre/quest';

import type { TargetBody } from '../arena/TargetsMount';
import type { Burst } from '../effects/particles';

export type EmitterKind = 'flames' | 'embers' | 'smoke' | 'steam' | 'bubbles' | 'sparks' | 'glint' | 'flicker';

/** Stálý zdroj částic (smyčka three.quarks); jednotky jako `Burst` efektů A. */
export interface EmitterPreset {
  /** Částic za sekundu. */
  readonly rate: number;
  readonly colors: readonly [from: string, to: string];
  readonly life: readonly [number, number];
  readonly speed: readonly [number, number];
  readonly size: readonly [number, number];
  /** Tíže dolů (m/s²); záporná = stoupá. */
  readonly gravity: number;
  /** Poloměr koule, odkud částice vylétají (m). */
  readonly radius: number;
  /** Aditivní míchání: oheň a jiskra svítí, kouř a pára ne. */
  readonly glow: boolean;
  /** Kouř a pára se rozplývají do šířky, ostatní se ztrácí. */
  readonly grow: boolean;
}

export const EMITTERS: Readonly<Record<EmitterKind, EmitterPreset>> = {
  flames: { rate: 45, colors: [brand.sun, brand.tomato], life: [0.35, 0.7], speed: [0.2, 0.6], size: [0.35, 0.6], gravity: -4, radius: 0.45, glow: true, grow: false },
  embers: { rate: 8, colors: [brand['sun-soft'], brand['tomato-deep']], life: [0.8, 1.4], speed: [0.3, 0.9], size: [0.05, 0.1], gravity: -1.5, radius: 0.5, glow: true, grow: false },
  smoke: { rate: 10, colors: [brand['ink-faint'], brand['ink-soft']], life: [1.6, 2.6], speed: [0.2, 0.5], size: [0.4, 0.8], gravity: -1, radius: 0.35, glow: false, grow: true },
  steam: { rate: 8, colors: [brand.paper, brand.sky], life: [0.9, 1.5], speed: [0.1, 0.3], size: [0.12, 0.25], gravity: -1.2, radius: 0.15, glow: false, grow: true },
  bubbles: { rate: 14, colors: [brand.paper, brand['cream-deep']], life: [0.3, 0.6], speed: [0.05, 0.2], size: [0.04, 0.08], gravity: -0.6, radius: 0.15, glow: false, grow: false },
  sparks: { rate: 18, colors: [brand['sun-soft'], brand.sun], life: [0.25, 0.5], speed: [1.5, 3], size: [0.05, 0.1], gravity: 9, radius: 0.1, glow: true, grow: false },
  glint: { rate: 3, colors: [brand.paper, brand['sun-soft']], life: [0.3, 0.5], speed: [0, 0.1], size: [0.12, 0.2], gravity: 0, radius: 0.2, glow: true, grow: true },
  flicker: { rate: 12, colors: [brand['sun-soft'], brand.sun], life: [0.2, 0.4], speed: [0.05, 0.15], size: [0.06, 0.12], gravity: -1.5, radius: 0.02, glow: true, grow: false },
};

/** Zdroj částic ve výšce `y` (m nad spodkem předmětu). */
export interface EmitterAt {
  readonly kind: EmitterKind;
  readonly y: number;
}

/** Bodové světlo stavu – dostane ho jen `MAX_LIGHTS` předmětů nejblíž kameře, ostatní svítí emisí. */
export interface LightFx {
  readonly color: string;
  readonly intensity: number;
  readonly distance: number;
  readonly y: number;
}

export interface StateFx {
  readonly emitters: readonly EmitterAt[];
  readonly light?: LightFx;
}

/** Model z katalogu a velikost kresby (m); kreslí se větší než tělo jádra, srážky jsou jen v x/z. */
export interface KindBody {
  readonly model: string;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

export const KIND_BODY: Readonly<Record<Exclude<VerbKind, 'grow'>, KindBody>> = {
  fire: { model: 'oak-tree', w: 1.8, h: 2.6, d: 1.8 },
  // Svíčka velká jako hrdina (1,3 m): z kamery arény by jinak byla čárka.
  flame: { model: 'cc0-candle', w: 0.5, h: 1.3, d: 0.5 },
  // Pánev s rukojetí k +z; mísa má střed −0,4 délky modelu od středu obrysu.
  cook: { model: 'cc0-pan', w: 0.55, h: 0.1, d: 0.9 },
  repair: { model: 'steam-machine', w: 1, h: 1.5, d: 0.8 },
  free: { model: 'gen3d-iron-cage', w: 0.9, h: 1.2, d: 0.9 },
};

const NONE: StateFx = { emitters: [] };

/** Stavy po řadě: hoří → kouří → uhašeno, knot → plamínek, syrová → peče se → zlatá… */
export const VERB_FX: Readonly<Record<VerbKind, readonly StateFx[]>> = {
  fire: [{ emitters: [{ kind: 'flames', y: 1.55 }, { kind: 'embers', y: 2 }], light: { color: brand.tomato, intensity: 40, distance: 9, y: 1.8 } }, { emitters: [{ kind: 'smoke', y: 1.9 }] }, NONE],
  flame: [NONE, { emitters: [{ kind: 'flicker', y: 1.42 }], light: { color: brand['sun-soft'], intensity: 12, distance: 5, y: 1.6 } }],
  cook: [NONE, { emitters: [{ kind: 'bubbles', y: 0.07 }, { kind: 'steam', y: 0.12 }] }, { emitters: [{ kind: 'glint', y: 0.12 }] }],
  repair: [{ emitters: [{ kind: 'sparks', y: 1.05 }, { kind: 'smoke', y: 1.5 }] }, { emitters: [], light: { color: brand.mint, intensity: 15, distance: 6, y: 1.65 } }],
  free: [NONE, NONE],
  grow: [NONE, NONE, { emitters: [{ kind: 'glint', y: 1.15 }] }],
};

/** Efekty stavu; stav nad posledním drží poslední. */
export function fxOf(kind: VerbKind | null, state: number): StateFx {
  if (kind === null) return NONE;
  const states = VERB_FX[kind];
  return states[Math.min(state, states.length - 1)] as StateFx;
}

/** Záblesk přechodu stavu (bez polohy) a výška nad spodkem předmětu, kde bouchne (m). */
type BurstFx = Omit<Burst, 'at'> & { readonly y: number };

const STATE_BURST: Readonly<Record<VerbKind | 'plain', BurstFx>> = {
  // Voda na oheň: obláček páry.
  fire: { kind: 'puff', y: 1.6, count: 16, colors: [brand.paper, brand.sky], life: [0.5, 0.9], speed: [0.8, 1.6], size: [0.4, 0.7], gravity: -1.5, glow: false },
  flame: { kind: 'flash', y: 1.42, count: 3, colors: [brand.paper, brand['sun-soft']], life: [0.12, 0.2], speed: [0, 0.2], size: [0.6, 0.9], gravity: 0, glow: true },
  cook: { kind: 'sparks', y: 0.15, count: 16, colors: [brand.sun, brand['sun-soft']], life: [0.3, 0.5], speed: [1, 2], size: [0.05, 0.1], gravity: 3, glow: true },
  repair: { kind: 'sparks', y: 1.2, count: 24, colors: [brand['sun-soft'], brand.mint], life: [0.3, 0.6], speed: [1.5, 3], size: [0.05, 0.1], gravity: 6, glow: true },
  free: { kind: 'confetti', y: 0.8, count: 30, colors: [brand.mint, brand.sun], life: [0.8, 1.2], speed: [2, 3.5], size: [0.06, 0.1], gravity: 5, glow: false },
  grow: { kind: 'sparks', y: 0.5, count: 16, colors: [brand.mint, brand.grass], life: [0.4, 0.7], speed: [0.8, 1.6], size: [0.06, 0.12], gravity: 1, glow: true },
  plain: { kind: 'sparks', y: 0.8, count: 16, colors: [brand.sun, brand.paper], life: [0.3, 0.5], speed: [1, 2.2], size: [0.06, 0.12], gravity: 3, glow: true },
};

/**
 * Záblesky cílů, které od minula postoupily o stav. `seen` si pamatuje poslední
 * stav každého cíle: první snímek nic nevydá a restart (stav zpět na 0) taky ne –
 * to není sloveso. Poloha je v metrech scény jako cíl.
 */
export function risenBursts(seen: Map<number, number>, targets: readonly TargetBody[], kind: VerbKind | null): Burst[] {
  const bursts: Burst[] = [];
  const { y, ...burst } = STATE_BURST[kind ?? 'plain'];
  for (const target of targets) {
    const was = seen.get(target.index);
    seen.set(target.index, target.state);
    if (was !== undefined && target.state > was) bursts.push({ ...burst, at: [target.x, target.y + y, target.z] });
  }
  return bursts;
}

/** Víc bodových světel naráz telefon neunese; jejich počet je ve scéně stálý, ať se shadery nepřekládají. */
export const MAX_LIGHTS = 4;

export interface LightSpot extends Omit<LightFx, 'y'> {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Světla svítících předmětů, nejblíž místu `from` (kamera) první, nejvýš `MAX_LIGHTS`. */
export function lightsOf(targets: readonly TargetBody[], kind: VerbKind | null, from: { readonly x: number; readonly z: number }): LightSpot[] {
  const spots: LightSpot[] = [];
  for (const target of targets) {
    const light = fxOf(kind, target.state).light;
    if (light !== undefined) spots.push({ ...light, x: target.x, y: target.y + light.y, z: target.z });
  }
  const gap = (spot: LightSpot): number => Math.hypot(spot.x - from.x, spot.z - from.z);
  return spots.sort((a, b) => gap(a) - gap(b)).slice(0, MAX_LIGHTS);
}

export interface QuestVerb {
  /** `null` = sloveso bez druhu („paint“): tvar v paletě. */
  readonly kind: VerbKind | null;
  readonly states: number;
}

/** Sloveso a počet stavů z pravidla `interact` světa; svět bez něj úkol není. */
export function questVerbOf(world: Pick<ArcadeWorld, 'rules'>): QuestVerb | null {
  const rule = world.rules.find((one) => one.id === 'interact');
  if (rule === undefined) return null;
  const { verb, when } = rule.params as { readonly verb: string; readonly when: { readonly interact: { readonly states: number } } };
  return { kind: verbKindOf(verb), states: when.interact.states };
}
