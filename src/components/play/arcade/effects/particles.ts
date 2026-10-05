/**
 * Výbuchy částic z vizuálních událostí (P32A T4). Čistá vrstva bez rendereru:
 * `burstsOf` řekne, co má událost vypustit, `createParticleDirector` to pustí
 * přes předaný `spawn` (na plátně three.quarks) a hlídá strop živých částic.
 *
 * Do stavu hry nic nepíše – čte jen `VisualEvent` ze sběrnice. Poloha je ve
 * scéně: x jádra zrcadlí scéna stejně jako těla (`World.tsx`).
 */

import { Color } from 'three';

import { color as brand } from '@/brand/tokens';

import type { QualityTier } from '../look/rig/quality';
import type { VisualEvent } from './bus';

/** Strop živých částic celé scény; telefon na `low` jich unese míň. */
export const PARTICLE_CAP: Readonly<Record<QualityTier, number>> = { high: 2000, medium: 2000, low: 500 };

export type BurstKind = 'sparks' | 'debris' | 'flash' | 'puff' | 'confetti' | 'dust' | 'pop';

export interface Burst {
  readonly kind: BurstKind;
  /** Střed výbuchu ve scéně (m). */
  readonly at: readonly [x: number, y: number, z: number];
  readonly count: number;
  /** Barva částice náhodně mezi těmi dvěma. */
  readonly colors: readonly [from: string, to: string];
  /** Život (s), rychlost (m/s) a velikost (m) náhodně v rozsahu. */
  readonly life: readonly [number, number];
  readonly speed: readonly [number, number];
  readonly size: readonly [number, number];
  /** Tíže dolů (m/s²); záporná = stoupá. */
  readonly gravity: number;
  /** Aditivní míchání: jiskra a záblesk svítí, prach a úlomky ne. */
  readonly glow: boolean;
}

/** Barvy výbuchů ze scény: sběratelná věc, úlomky a dopad podle sady. */
export interface BurstLook {
  readonly collectible: string;
  readonly debris: string;
  /** Prach dopadu: v zasněžené sadě sníh. */
  readonly land: string;
}

/** Barva o čtvrtinu blíž bílé: jiskra zůstane v barvě věci, jen se rozsvítí. */
const lighter = (hex: string): string => `#${new Color(hex).lerp(new Color('#ffffff'), 0.25).getHexString()}`;

/** Konfety bez fialové: červená→oranžová, žlutá→zelená, tyrkys→modrá. */
const CONFETTI: readonly (readonly [string, string])[] = [
  ['#ef4444', '#f97316'],
  ['#facc15', '#22c55e'],
  ['#06b6d4', '#3b82f6'],
];

/** Co vypustí jedna událost. Změna stavu a nové tělo částice nemají. */
export function burstsOf(event: VisualEvent, look: BurstLook): Burst[] {
  const x = -event.x;
  const { y, z } = event;
  switch (event.kind) {
    case 'pickup':
      return [
        // „Pop“ (P36C T7): věc se nafoukne a zmizí – jedna rostoucí a blednoucí koule v její barvě.
        { kind: 'pop', at: [x, y + 0.4, z], count: 1, colors: [lighter(look.collectible), lighter(look.collectible)], life: [0.18, 0.2], speed: [0, 0], size: [1.1, 1.2], gravity: 0, glow: true },
        { kind: 'sparks', at: [x, y + 0.4, z], count: 24, colors: [look.collectible, lighter(look.collectible)], life: [0.3, 0.55], speed: [2, 4.5], size: [0.08, 0.16], gravity: 3, glow: true },
      ];
    case 'lose':
      // Prohra (P36C T7): tmavé úlomky a kouř z hrdiny; scéna se k tomu odbarví (`data-fx="lose"`).
      return [
        { kind: 'debris', at: [x, y + 0.5, z], count: 28, colors: [brand['ink-soft'], brand.ink], life: [0.5, 0.9], speed: [3, 6], size: [0.1, 0.22], gravity: 10, glow: false },
        { kind: 'puff', at: [x, y + 0.5, z], count: 12, colors: [brand['ink-faint'], brand['ink-soft']], life: [0.6, 0.9], speed: [0.8, 1.8], size: [0.4, 0.7], gravity: -0.6, glow: false },
      ];
    case 'hit':
      return [
        { kind: 'debris', at: [x, y + 0.5, z], count: 18, colors: [look.debris, '#1f2937'], life: [0.45, 0.8], speed: [2.5, 5], size: [0.1, 0.2], gravity: 12, glow: false },
        { kind: 'flash', at: [x, y + 0.7, z], count: 3, colors: ['#ffffff', '#fde68a'], life: [0.1, 0.16], speed: [0, 0.2], size: [1.1, 1.6], gravity: 0, glow: true },
      ];
    case 'death':
      return [{ kind: 'puff', at: [x, y + 0.4, z], count: 14, colors: ['#f8fafc', '#cbd5e1'], life: [0.5, 0.8], speed: [0.6, 1.4], size: [0.35, 0.6], gravity: -0.8, glow: false }];
    case 'win':
      return CONFETTI.map((colors) => ({ kind: 'confetti' as const, at: [x, y + 2.2, z] as const, count: 60, colors, life: [1.4, 2], speed: [3, 6], size: [0.08, 0.14], gravity: 5, glow: false }));
    case 'land':
      return [{ kind: 'dust', at: [x, y + 0.05, z], count: 12, colors: [look.land, '#ffffff'], life: [0.3, 0.5], speed: [0.8, 1.8], size: [0.12, 0.24], gravity: 2, glow: false }];
    default:
      return [];
  }
}

/** Puštěný výbuch: jeho systém částic se dá zahodit. */
export interface BurstHandle {
  dispose(): void;
}

export interface ParticleDirector {
  /** Pustí výbuchy v čase `now` (s); co by přetáhlo `cap` živých částic, ořízne nebo zahodí. Vrátí počet puštěných systémů. */
  emit(bursts: readonly Burst[], now: number, cap: number): number;
  /** Zahodí výbuchy, kterým v čase `now` doběhl život. */
  update(now: number): void;
  /** Živé částice a systémy. */
  live(): number;
  systems(): number;
  /** Zahodí všechno živé (restart relace). */
  reset(): void;
}

export function createParticleDirector(spawn: (burst: Burst) => BurstHandle): ParticleDirector {
  let active: { readonly handle: BurstHandle; readonly count: number; readonly until: number }[] = [];
  const live = (): number => active.reduce((sum, entry) => sum + entry.count, 0);
  return {
    emit: (bursts, now, cap) => {
      let emitted = 0;
      for (const burst of bursts) {
        const count = Math.min(burst.count, cap - live());
        if (count <= 0) continue;
        active.push({ handle: spawn(count === burst.count ? burst : { ...burst, count }), count, until: now + burst.life[1] });
        emitted += 1;
      }
      return emitted;
    },
    update: (now) => {
      const [done, kept] = [active.filter((entry) => entry.until <= now), active.filter((entry) => entry.until > now)];
      for (const entry of done) entry.handle.dispose();
      active = kept;
    },
    live,
    systems: () => active.length,
    reset: () => {
      for (const entry of active) entry.handle.dispose();
      active = [];
    },
  };
}
