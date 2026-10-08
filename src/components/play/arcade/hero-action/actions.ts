/**
 * Viditelná činnost hrdiny podle `heroAction` (P37B T2): čím hrdina pracuje
 * (rekvizita v ruce) a jak se při tom hýbe. Čisté funkce bez three – kreslí je
 * `HeroActionBody.tsx`.
 *
 * Póza je součet klidové smyčky (čas `t` v sekundách) a nápřahu po herní
 * události (`u` = podíl nápřahu 0..1, 1 = doběhl). Délky jsou v podílech
 * výšky hrdiny, úhly v radiánech; lokální +z míří po pohybu hrdiny. Kladné
 * `rx` sklopí horní konec rekvizity dopředu – nástroj držený dolů (vařečka,
 * koště, lopata) proto míří pracovním koncem dopředu se záporným `rx`. Jen obraz:
 * čas běží z kreslení, do stavu ani hashe nic nejde.
 */

import type { HeroAction } from '@/play/spec';
import { BODY, COUNTER, FLAG, HEADER, ROLE, bodyBase, targetStateOf } from '@/play/arcade/contract';

/** Read-only visual evidence, including demo/replay frames which emit no human events. */
export function actionAdvanced(before: Int32Array, after: Int32Array): boolean {
  if (after[HEADER.tick] <= before[HEADER.tick]) return false;
  for (const counter of [COUNTER.score, COUNTER.items]) {
    if (after[HEADER.counters + counter] > before[HEADER.counters + counter]) return true;
  }
  const count = Math.min(before[HEADER.bodyCount], after[HEADER.bodyCount]);
  for (let index = 0; index < count; index++) {
    const base = bodyBase(index);
    const role = after[base + BODY.role];
    if (role !== before[base + BODY.role]) continue;
    if (role === ROLE.target && targetStateOf(after, index) > targetStateOf(before, index)) return true;
    if ((role === ROLE.target || role === ROLE.enemy || role === ROLE.collectible)
      && (before[base + BODY.flags] & FLAG.alive) !== 0
      && (after[base + BODY.flags] & FLAG.alive) === 0) return true;
  }
  return false;
}

/** Jak dlouho trvá nápřah po události (s). */
export const BURST_S = 0.5;
/**
 * Pracovní takt v klidu (s): bez události hrdina nápřah zopakuje sám, aby
 * sloveso bylo vidět i v 3 s klipu, kde nic nesebere. Událost ho spustí hned.
 */
export const WORK_BEAT_S = 1.6;

export type PropKind = 'spoon' | 'nozzle' | 'crate' | 'tray' | 'broom' | 'ball' | 'shovel' | 'brush' | 'axe' | 'can' | 'needles' | 'wrench';

/** Co od rekvizity při nápřahu odletí: kapky, třísky/hlína, prach, jiskry, nic. */
export type Spill = 'drops' | 'chips' | 'dust' | 'sparks' | null;

export interface ActionPose {
  /** Posun rekvizity od ruky (podíl výšky) a její natočení. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
  /** Tělo: poskok (podíl výšky), předklon (+ dopředu), úklon do strany, otočení. */
  readonly bob: number;
  readonly pitch: number;
  readonly roll: number;
  readonly yaw: number;
  /** Síla odletu 0..1 (kapky, třísky…), jen během nápřahu. */
  readonly spill: number;
}

export interface ActionMotion {
  readonly prop: PropKind;
  readonly spill: Spill;
  /** Ruka nahoře (nese nad hlavou, drží tác) nebo dole (koště, lopata); podíl výšky od země. */
  readonly hand: number;
  pose(t: number, u: number): ActionPose;
}

const REST: ActionPose = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, bob: 0, pitch: 0, roll: 0, yaw: 0, spill: 0 };
const pose = (partial: Partial<ActionPose>): ActionPose => ({ ...REST, ...partial });

/** Oblouk nápřahu: 0 → 1 → 0 přes celý nápřah, mimo něj 0. */
export const arc = (u: number): number => (u >= 0 && u < 1 ? Math.sin(Math.PI * u) : 0);
/** Úder: rychlý nápřah dozadu (první třetina), pak švih dopředu a dojezd; −1 vzadu … +1 vpředu. */
export const strike = (u: number): number => {
  if (!(u >= 0 && u < 1)) return 0;
  if (u < 0.3) return -u / 0.3;
  const k = (u - 0.3) / 0.7;
  return -1 + 2 * Math.sin((Math.PI / 2) * Math.min(1, k * 1.6)) * (1 - 0.5 * Math.max(0, k - 0.6) / 0.4);
};

export const HERO_ACTION_MOTION: Readonly<Record<Exclude<HeroAction, 'none'>, ActionMotion>> = {
  // Vařečka krouží v hrnci před hrdinou, při události rychleji a širší.
  stir: {
    prop: 'spoon',
    spill: 'drops',
    hand: 0.45,
    pose: (t, u) => {
      const s = arc(u);
      const angle = 4 * t + 7 * s;
      const r = 0.07 + 0.06 * s;
      return pose({ x: r * Math.cos(angle), z: 0.12 + r * Math.sin(angle), rx: -0.5, roll: 0.05 * Math.sin(angle), spill: s * 0.6 });
    },
  },
  // Hubice míří dopředu a přejíždí ze strany na stranu; při události trysk vody a cuknutí.
  spray: {
    prop: 'nozzle',
    spill: 'drops',
    hand: 0.55,
    pose: (t, u) => {
      const s = arc(u);
      return pose({ z: 0.1 - 0.05 * s, ry: 0.3 * Math.sin(1.6 * t), rx: -0.1 - 0.15 * s, pitch: -0.08 * s, spill: s });
    },
  },
  // Bedna v náručí; při události ji zvedne nad hlavu a položí před sebe.
  stack: {
    prop: 'crate',
    spill: 'dust',
    hand: 0.5,
    pose: (t, u) => {
      const s = arc(u);
      return pose({ x: -0.3, y: 0.03 * Math.sin(2 * t) + 0.45 * s, z: 0.18 + 0.15 * s, bob: 0.04 * s, pitch: -0.1 * s, spill: u > 0.6 && u < 1 ? 1 - u : 0 });
    },
  },
  // Tác na rameni balancuje; tělo se kolébá s ním.
  carry: {
    prop: 'tray',
    spill: null,
    hand: 0.78,
    pose: (t, u) => {
      const s = arc(u);
      const sway = Math.sin(3 * t);
      return pose({ y: 0.12 * s, rz: 0.1 * sway, ry: 0.6 * s, roll: 0.05 * sway, bob: 0.02 * Math.abs(Math.sin(6 * t)) + 0.05 * s });
    },
  },
  // Koště u země zametá obloukem; při události široký švih a prach.
  sweep: {
    prop: 'broom',
    spill: 'dust',
    hand: 0.5,
    pose: (t, u) => {
      const s = arc(u);
      const swing = Math.sin(3 * t) * (0.35 + 0.45 * s);
      return pose({ x: 0.15 * swing, z: 0.15, rx: -0.55, ry: swing, yaw: 0.2 * swing, pitch: 0.12 + 0.08 * s, spill: s });
    },
  },
  // Míček v dlani nadhazuje; při události nápřah dozadu a hod dopředu.
  throw: {
    prop: 'ball',
    spill: null,
    hand: 0.6,
    pose: (t, u) => {
      const k = strike(u);
      const flying = u > 0.45 && u < 1 ? (u - 0.45) / 0.55 : 0;
      return pose({ y: 0.08 * Math.abs(Math.sin(3 * t)) + 0.25 * Math.max(0, -k) + 0.3 * flying, z: 0.1 - 0.25 * Math.max(0, -k) + 1.4 * flying, pitch: 0.15 * k, yaw: -0.25 * k });
    },
  },
  // Lopata zabírá do země; při události zaryje, vyhodí hlínu, tělo se předkloní.
  dig: {
    prop: 'shovel',
    spill: 'chips',
    hand: 0.5,
    pose: (t, u) => {
      const s = arc(u);
      return pose({ y: -0.04 * Math.abs(Math.sin(2 * t)) - 0.2 * s, z: 0.2, rx: -0.35 - 0.5 * s, pitch: 0.1 + 0.25 * s, bob: -0.04 * s, spill: u > 0.5 && u < 1 ? s : 0 });
    },
  },
  // Štětec tahá svislé tahy; při události dlouhý tah a kapky barvy.
  paint: {
    prop: 'brush',
    spill: 'drops',
    hand: 0.55,
    pose: (t, u) => {
      const s = arc(u);
      return pose({ y: 0.12 * Math.sin(5 * t) + 0.2 * Math.sin(Math.PI * 2 * Math.min(1, u)) * s, z: 0.22, rx: -0.3, roll: 0.04 * Math.sin(5 * t), spill: s * 0.7 });
    },
  },
  // Sekera nad ramenem; při události nápřah a sek dolů, třísky.
  chop: {
    prop: 'axe',
    spill: 'chips',
    hand: 0.6,
    pose: (t, u) => {
      const k = strike(u);
      return pose({ y: 0.1, z: 0.12, rx: -0.5 + 0.05 * Math.sin(2 * t) + 1.1 * k, pitch: 0.18 * Math.max(0, k), bob: -0.03 * Math.max(0, k), spill: k > 0.6 ? 1 : 0 });
    },
  },
  // Konev se kolébá; při události se nakloní a teče z ní voda.
  water: {
    prop: 'can',
    spill: 'drops',
    hand: 0.45,
    pose: (t, u) => {
      const s = arc(u);
      return pose({ z: 0.15, rz: 0.1 * Math.sin(2 * t), rx: 0.15 + 0.75 * s, pitch: 0.08 * s, spill: s });
    },
  },
  // Jehlice před hrudí cvakají; při události rychleji a klubko poskočí.
  knit: {
    prop: 'needles',
    spill: null,
    hand: 0.6,
    pose: (t, u) => {
      const s = arc(u);
      const click = Math.sin((8 + 8 * s) * t);
      return pose({ x: -0.15, z: 0.2, rz: 0.3 * click, ry: 0.15 * click, y: 0.05 * s, bob: 0.015 * Math.abs(click), pitch: 0.1 });
    },
  },
  // Klíč povoluje matici; při události celá otočka a jiskry.
  fix: {
    prop: 'wrench',
    spill: 'sparks',
    hand: 0.5,
    pose: (t, u) => {
      const turn = u >= 0 && u < 1 ? 2 * Math.PI * u : 0;
      return pose({ z: 0.22, rx: -0.2, rz: 0.35 * Math.sin(3 * t) + turn, pitch: 0.1, spill: arc(u) });
    },
  },
};

/** Pohyb akce, nebo `null` pro `none` (hrdina se kreslí beze změny). */
export function motionOf(action: HeroAction): ActionMotion | null {
  return action === 'none' ? null : HERO_ACTION_MOTION[action];
}

/** Které efekty jádra spustí nápřah: hrdina něco udělal (bod, sebrání, kontrolní bod, výhra), ne co se stalo jemu. */
export const BURST_KINDS: ReadonlySet<string> = new Set(['score', 'despawn', 'count', 'checkpoint', 'win']);
