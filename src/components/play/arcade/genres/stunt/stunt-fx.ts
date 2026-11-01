/**
 * Odezva nárazu závodu s triky (P68V T4): jiskry a prach z událostí tiku. Události dává sběrnice efektů
 * (`effects/bus.ts`), která relaci jen poslouchá; tahle vrstva je čistá – události → částice, částice a tik kresby →
 * poloha a velikost. Kreslí scéna dvěma sítěmi instancí (`StuntScene`), nejvýš `STUNT_FX.max` částic naráz: nová
 * dávka vytlačí nejstarší.
 *
 * - zásah hráče (náraz do mantinelu, `damage` pravidla `stunt_crash`) → jiskry od auta;
 * - nová troska (hromada se nárazem rozletěla, `spawn` pravidla `stunt_impact`) → prach u každé trosky;
 * - dopad hráče (`land` sběrnice) → prach pod autem.
 *
 * Záblesk, úlomky a obláček sdílené vrstvy (`effects/Effects.tsx`) jedou dál vedle – tohle je jiskra a prach navíc.
 * Směry jsou z tiku a pořadí částice, ne z náhody: týž záznam jiskří stejně. Mimo stav i hash.
 */

import type { VisualEvent } from '../../effects/bus';

export const STUNT_FX = {
  /** Strop živých částic naráz (obou druhů dohromady). */
  max: 24,
  /** Jiskry: počet za událost, život (tiky), rychlost do strany a nahoru (m/tik), velikost (m), tíže (m/tik²), výška zrodu. */
  spark: { count: 10, life: 18, speed: 0.13, lift: 0.08, size: 0.1, gravity: 0.008, rise: 0.4 },
  /** Prach: pomalejší, u země, roste a řídne. Malý a krátký (T4-R1): na telefonu dřív zakrýval auto i počítadla. */
  dust: { count: 3, life: 22, speed: 0.03, lift: 0.012, size: 0.28, gravity: 0, rise: 0.05 },
} as const;

export type StuntParticleKind = 'spark' | 'dust';

/** Částice ve scéně (m, x zrcadlené jako těla), rychlost v m/tik, zrozená v tiku `born`. */
export interface StuntParticle {
  readonly kind: StuntParticleKind;
  readonly born: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
}

function burst(kind: StuntParticleKind, event: VisualEvent): StuntParticle[] {
  const spec = STUNT_FX[kind];
  return Array.from({ length: spec.count }, (_, k) => {
    // Rovnoměrně dokola, pootočené tikem a tělem – dvě dávky téhož tiku se nepřekryjí.
    const angle = ((k + 0.5) / spec.count) * 2 * Math.PI + event.tick * 0.61 + event.body * 1.7;
    const lift = spec.lift * (0.6 + 0.1 * ((k * 3) % 5));
    return { kind, born: event.tick, x: -event.x, y: event.y + spec.rise, z: event.z, vx: Math.cos(angle) * spec.speed, vy: lift, vz: Math.sin(angle) * spec.speed };
  });
}

/** Částice z událostí jednoho tiku; `player` = index hráče. */
export function stuntParticlesOf(events: readonly VisualEvent[], player: number): StuntParticle[] {
  return events.flatMap((event) => {
    if (event.kind === 'hit' && event.body === player) return burst('spark', event);
    if (event.kind === 'land' && event.body === player) return burst('dust', event);
    if (event.kind === 'spawn' && event.body !== player) return burst('dust', event);
    return [];
  });
}

const alive = (particle: StuntParticle, now: number): boolean => now >= particle.born && now - particle.born < STUNT_FX[particle.kind].life;

/** Živé částice a nová dávka v tiku `now`, nejvýš `STUNT_FX.max` – nejstarší odpadnou. Restart (tik zpět) zahodí staré. */
export function keepParticles(pool: readonly StuntParticle[], fresh: readonly StuntParticle[], now: number): StuntParticle[] {
  return [...pool.filter((particle) => alive(particle, now)), ...fresh].slice(-STUNT_FX.max);
}

/** Poloha a velikost částice v tiku kresby `now` (tik + podíl rozběhnutého); `null` = mrtvá. */
export function particleAt(particle: StuntParticle, now: number): { readonly x: number; readonly y: number; readonly z: number; readonly size: number } | null {
  if (!alive(particle, now)) return null;
  const spec = STUNT_FX[particle.kind];
  const age = now - particle.born;
  const left = 1 - age / spec.life;
  return {
    x: particle.x + particle.vx * age,
    y: Math.max(0.03, particle.y + particle.vy * age - (spec.gravity * age * age) / 2),
    z: particle.z + particle.vz * age,
    // Jiskra hasne a zmenšuje se, prach se rozplývá do šířky.
    size: particle.kind === 'spark' ? spec.size * left : spec.size * (0.5 + 0.8 * (1 - left)),
  };
}
