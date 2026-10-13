/**
 * Knihovna úseků skákačky (P46D T5): schody, mezery s rostoucí šířkou,
 * pohyblivá plošina, výstup nahoru, propadající se plošiny, chodba s ostny,
 * skok přes vodu a odpočinek s checkpointem. Vzor je data: řada kroků
 * (mezera, výška, deska, hroty, pohyb), které `platform.ts` položí za sebe
 * a ořízne do dosahu skoku (`maxGap`, `PLATFORM.maxRise`), takže každý vzor
 * je v dosahu `jumpReach` z konstrukce a `checkPlatformLevel` to přepočítá.
 * Úroveň z úseků s `chunks: 1` je z nich skládá podle semínka a obtížnosti úseku.
 *
 * Moduly se navzájem importují: tady se z `platform.ts` nic nečte.
 */

import type { CompileRng } from '@/play/compile/rng';

export const PLATFORM_CHUNKS = ['stairs', 'widening', 'shuttle', 'climb', 'sinking', 'spike-run', 'water', 'rest'] as const;
export type PlatformChunkId = (typeof PLATFORM_CHUNKS)[number];

export interface ChunkStep {
  /** Mezera před deskou: místo v rozsahu mezer obtížnosti úseku, 0 nejužší, 100 nejširší (pak ji ořízne dosah skoku). */
  readonly gap: number;
  /** Výška proti předchozí desce v násobcích schodu obtížnosti (−1 až 1). */
  readonly rise: number;
  /** Délka desky: místo v rozsahu desek obtížnosti (0–100), nebo pevná délka v jednotkách. */
  readonly slab: number | { readonly fixed: number };
  /** Hroty na desce; bez hodnoty podle hustoty obtížnosti (každá n-tá deska úseku). */
  readonly spikes?: number;
  /** `shuttle` = v mezeře kyvadlem jezdí deska. */
  readonly motion?: 'shuttle';
  /** Pod mezerou je voda. */
  readonly water?: boolean;
}

export interface ChunkContext {
  /** Horní hrana poslední desky a meze výšky. */
  readonly top: number;
  readonly maxTop: number;
  /** Schod obtížnosti úseku. */
  readonly rise: number;
}

export interface PlatformChunk {
  readonly id: PlatformChunkId;
  /** Od které obtížnosti úseku (index `PLATFORM_DIFFICULTIES`) se vzor losuje. */
  readonly from: number;
  readonly weight: number;
  readonly build: (rng: CompileRng, ctx: ChunkContext) => readonly ChunkStep[];
}

export const CHUNK_SHAPE = {
  /** Chodba s ostny: rozestup hrotů na jedné desce (deska je o rozestup delší než hroty). */
  spikePitch: 4500,
  /** Odpočinek: dlouhá deska bez hrotu. */
  restSlab: 9000,
  /**
   * Propadající se plošiny: krátké kry, každá o půl schodu níž, nad vodou. Bez svislého
   * pohybu: jádro v horním obratu svislé desky (rychlost se otočí dřív, než se počítá dopad)
   * hráče propustí skrz desku, a jádro P46D měnit nesmí.
   */
  sinkSlab: 3500,
} as const;

const repeat = (count: number, step: (index: number) => ChunkStep): ChunkStep[] => Array.from({ length: count }, (_, index) => step(index));

/** Vzory úseků; odpočinek začíná i druhý a třetí úsek a jen tam nese checkpoint (`platform.ts`). */
export const PLATFORM_CHUNK_LIBRARY: readonly PlatformChunk[] = [
  {
    // Krátké desky půlschodem jedním směrem: nahoru, když nad sebou má místo, jinak dolů.
    id: 'stairs',
    from: 0,
    weight: 3,
    build: (rng, ctx) => {
      const up = ctx.top + 2 * ctx.rise <= ctx.maxTop && rng.int(0, 1) === 1;
      // Hrot na každém druhém, delším schodu: na nejkratší desce za skokem by začátečník neměl kam dopadnout.
      return repeat(4, (index) => ({ gap: rng.int(0, 30), rise: up ? 0.5 : -0.5, slab: index % 2 === 1 ? 50 : 0, spikes: index % 2 }));
    },
  },
  { id: 'widening', from: 0, weight: 4, build: () => [0, 50, 100].map((gap) => ({ gap, rise: 0, slab: 40 })) },
  { id: 'shuttle', from: 1, weight: 5, build: () => [{ gap: 0, rise: 0, slab: 50, motion: 'shuttle' }] },
  {
    // Celé schody nahoru; bez místa nad sebou nejdřív seběhne dolů.
    id: 'climb',
    from: 0,
    weight: 3,
    build: (rng, ctx) => {
      const room = Math.max(0, Math.floor((ctx.maxTop - ctx.top) / ctx.rise));
      const drops = Math.max(0, 3 - room);
      return [...repeat(drops, () => ({ gap: rng.int(20, 50), rise: -1, slab: 20, spikes: 0 })), ...[0, 1, 1].map((spikes, index) => ({ gap: rng.int(20, 60), rise: 1, slab: index * 25, spikes }))];
    },
  },
  { id: 'sinking', from: 1, weight: 2, build: (rng) => repeat(3, () => ({ gap: rng.int(20, 60), rise: -0.5, slab: { fixed: CHUNK_SHAPE.sinkSlab }, spikes: 0, water: true })) },
  {
    id: 'spike-run',
    from: 1,
    weight: 2,
    build: (rng) => {
      const spikes = rng.int(2, 3);
      return [{ gap: 30, rise: 0, slab: { fixed: (spikes + 1) * CHUNK_SHAPE.spikePitch }, spikes }];
    },
  },
  {
    // Seběhnout k vodě a přes ni nejširším skokem úseku.
    id: 'water',
    from: 0,
    weight: 2,
    build: () => [
      { gap: 20, rise: -1, slab: 60, spikes: 0 },
      { gap: 100, rise: 0, slab: 60, spikes: 1, water: true },
    ],
  },
  { id: 'rest', from: 0, weight: 1, build: () => [{ gap: 0, rise: 0, slab: { fixed: CHUNK_SHAPE.restSlab }, spikes: 0 }] },
];

export const REST_CHUNK = PLATFORM_CHUNK_LIBRARY.find((chunk) => chunk.id === 'rest') as PlatformChunk;

/** Další vzor podle váhy: jen do obtížnosti úseku `level`, nikdy stejný jako `previous`. */
export function pickPlatformChunk(rng: CompileRng, library: readonly PlatformChunk[], level: number, previous: PlatformChunkId | undefined): PlatformChunk {
  const usable = library.filter((chunk) => chunk.from <= level);
  const fresh = usable.filter((chunk) => chunk.id !== previous);
  const pool = fresh.length > 0 ? fresh : usable;
  let roll = rng.int(0, pool.reduce((sum, chunk) => sum + chunk.weight, 0) - 1);
  return pool.find((chunk) => (roll -= chunk.weight) < 0) as PlatformChunk;
}
