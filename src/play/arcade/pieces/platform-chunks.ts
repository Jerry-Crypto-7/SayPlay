/**
 * Knihovna úseků skákačky (P46D T5): schody, mezery s rostoucí šířkou,
 * pohyblivá plošina, výstup nahoru, propadající se plošiny, chodba s ostny,
 * lekníny nad vodou a odpočinek s checkpointem. Vzor je data: řada kroků
 * (mezera, výška, deska, hroty, pohyb), které `platform.ts` položí za sebe
 * a ořízne do dosahu skoku (`maxGap`, `PLATFORM.maxRise`), takže každý vzor
 * je v dosahu `jumpReach` z konstrukce a `checkPlatformLevel` to přepočítá.
 * Úroveň z úseků s `chunks: 1` je z nich skládá podle semínka a obtížnosti úseku.
 *
 * Styl úrovně (P46D R2): každá úroveň má jeden charakter – výstup na věž,
 * lekníny nad vodou, dlouhé desky s hroty, nebo schody nahoru a dolů korunami
 * stromů. Styl určuje váhy vzorů a jeho vzor otevírá první úsek, takže je
 * vidět od startu. Prostředí věty styl vybere (`platformStyleFor`), jinak semínko.
 * Vzory jsou vidět i na nejlehčím stupni: schod aspoň 0,6 m, výstup z pěti
 * schodů, mezery rostou po 0,4 m, lekníny a mezery s rampou jsou krátké desky.
 *
 * Moduly se navzájem importují: tady se z `platform.ts` nic nečte.
 */

import type { LookId } from '@/play/arcade/look';
import type { CompileRng } from '@/play/compile/rng';

export const PLATFORM_CHUNKS = ['stairs', 'widening', 'shuttle', 'climb', 'sinking', 'spike-run', 'water', 'rest'] as const;
export type PlatformChunkId = (typeof PLATFORM_CHUNKS)[number];

export interface ChunkStep {
  /**
   * Mezera před deskou: místo v rozsahu mezer obtížnosti úseku (0 nejužší, 100 nejširší),
   * nebo pevná šířka v jednotkách. Obojí pak ořízne dosah skoku.
   */
  readonly gap: number | { readonly fixed: number };
  /** Výška proti předchozí desce v jednotkách; ořízne ji `PLATFORM.maxRise` a meze výšky. */
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
  readonly minTop: number;
  readonly maxTop: number;
  /** Schod obtížnosti úseku. */
  readonly rise: number;
  /** Rozsah mezer obtížnosti úseku. */
  readonly gap: readonly [number, number];
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
  /**
   * Schody: čtyři schody po 0,6–0,8 m (schod obtížnosti v těch mezích) s mezerou
   * 1,16–1,19 m – užší by na schod 0,8 m nestačila (hrana se musí přeskočit při
   * výstupu), od 1,2 m už nejsou schody, ale skoky (hrany desek na půl jednotky
   * mezeru o kus natáhnou). Desky 3–4 m: celé schodiště je v jednom záběru boční kamery.
   */
  stairs: 4,
  stairStep: [600, 800] as const,
  stairGap: [1160, 1190] as const,
  stairSlab: [3000, 4000] as const,
  /** Výstup: pět schodů po 0,5–0,7 m (dohromady aspoň 2,5 m) s mezerami 1,4–1,8 m, nejdřív sestup, když nahoře není místo. */
  climb: 5,
  climbStep: [500, 700] as const,
  climbGap: [1400, 1800] as const,
  climbSlab: [3000, 4500] as const,
  /** Rostoucí mezery: tři krátké desky, mezera od nejužší obtížnosti roste po tolika. */
  rampSlab: 3000,
  rampGrowth: 400,
  /** Lekníny: tři krátké desky nad vodou, mezera v horní půlce rozsahu obtížnosti. */
  pads: 3,
  padSlab: 2500,
} as const;

const repeat = (count: number, step: (index: number) => ChunkStep): ChunkStep[] => Array.from({ length: count }, (_, index) => step(index));

const clamp = (value: number, [low, high]: readonly [number, number]): number => Math.max(low, Math.min(high, value));

/** Vzory úseků; odpočinek začíná i druhý a třetí úsek a jen tam nese checkpoint (`platform.ts`). */
export const PLATFORM_CHUNK_LIBRARY: readonly PlatformChunk[] = [
  {
    // Čtyři schody jedním směrem: nahoru, když nad sebou má místo, jinak dolů.
    id: 'stairs',
    from: 0,
    weight: 3,
    build: (rng, ctx) => {
      const step = clamp(ctx.rise, CHUNK_SHAPE.stairStep);
      const span = CHUNK_SHAPE.stairs * step;
      const room = { up: ctx.maxTop - ctx.top >= span, down: ctx.top - ctx.minTop >= span };
      const up = room.up && room.down ? rng.int(0, 1) === 1 : room.up || (!room.down && ctx.maxTop - ctx.top > ctx.top - ctx.minTop);
      return repeat(CHUNK_SHAPE.stairs, () => ({ gap: { fixed: rng.int(CHUNK_SHAPE.stairGap[0], CHUNK_SHAPE.stairGap[1]) }, rise: up ? step : -step, slab: { fixed: rng.int(CHUNK_SHAPE.stairSlab[0], CHUNK_SHAPE.stairSlab[1]) }, spikes: 0 }));
    },
  },
  {
    // Tři krátké desky, mezera roste po `rampGrowth` od nejužší mezery obtížnosti.
    id: 'widening',
    from: 0,
    weight: 4,
    build: (_rng, ctx) => [0, 1, 2].map((k) => ({ gap: { fixed: ctx.gap[0] + k * CHUNK_SHAPE.rampGrowth }, rise: 0, slab: { fixed: CHUNK_SHAPE.rampSlab }, spikes: 0 })),
  },
  { id: 'shuttle', from: 1, weight: 5, build: () => [{ gap: 0, rise: 0, slab: 50, motion: 'shuttle' }] },
  {
    // Pět schodů nahoru; bez místa nad sebou nejdřív seběhne dolů (po celém schodu jádra).
    id: 'climb',
    from: 0,
    weight: 3,
    build: (rng, ctx) => {
      const step = clamp(ctx.rise, CHUNK_SHAPE.climbStep);
      const drops = Math.max(0, Math.ceil((ctx.top + CHUNK_SHAPE.climb * step - ctx.maxTop) / 1000));
      return [
        ...repeat(drops, () => ({ gap: rng.int(20, 60), rise: -1000, slab: 20, spikes: 0 })),
        ...repeat(CHUNK_SHAPE.climb, () => ({ gap: { fixed: rng.int(CHUNK_SHAPE.climbGap[0], CHUNK_SHAPE.climbGap[1]) }, rise: step, slab: { fixed: rng.int(CHUNK_SHAPE.climbSlab[0], CHUNK_SHAPE.climbSlab[1]) }, spikes: 0 })),
      ];
    },
  },
  { id: 'sinking', from: 1, weight: 2, build: (rng, ctx) => repeat(3, () => ({ gap: rng.int(20, 60), rise: -Math.round(ctx.rise / 2), slab: { fixed: CHUNK_SHAPE.sinkSlab }, spikes: 0, water: true })) },
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
    // Lekníny: krátké desky ve stejné výšce, pod každou mezerou voda.
    id: 'water',
    from: 0,
    weight: 2,
    build: (rng) => repeat(CHUNK_SHAPE.pads, () => ({ gap: rng.int(55, 85), rise: 0, slab: { fixed: CHUNK_SHAPE.padSlab }, spikes: 0, water: true })),
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

// ---------------------------------------------------------------------------
// Styl úrovně (P46D R2)

export const PLATFORM_STYLES = ['canopy', 'pads', 'runway', 'tower'] as const;
export type PlatformStyleId = (typeof PLATFORM_STYLES)[number];

export interface PlatformStyle {
  readonly id: PlatformStyleId;
  /** Vzor, který styl nese: otevírá první úsek a losuje se od nejlehčího stupně. */
  readonly signature: PlatformChunkId;
  /** Váhy vzorů; vzor bez váhy se v tomhle stylu nelosuje. */
  readonly weights: Readonly<Partial<Record<PlatformChunkId, number>>>;
}

/**
 * Koruny stromů (schody nahoru a dolů), lekníny nad vodou, dlouhé desky
 * s hroty a výstup na věž. Každý styl má od nejlehčího stupně aspoň dva vzory,
 * takže se vzor nikdy neopakuje hned po sobě. Schody jsou lehké (krátké mezery,
 * bez hrotu), proto je koruny dál od startu ředí kyvadly a hroty: se schody
 * na váze 6 vyhrál začátečník v lese 19 her z 20, s těmito vahami 11.
 */
export const PLATFORM_STYLE_LIBRARY: Readonly<Record<PlatformStyleId, PlatformStyle>> = {
  canopy: { id: 'canopy', signature: 'stairs', weights: { stairs: 4, shuttle: 5, 'spike-run': 3, widening: 2, climb: 1, water: 1, rest: 1 } },
  pads: { id: 'pads', signature: 'water', weights: { water: 6, sinking: 3, widening: 2, shuttle: 1, rest: 1 } },
  runway: { id: 'runway', signature: 'spike-run', weights: { 'spike-run': 6, widening: 2, shuttle: 2, stairs: 1, rest: 1 } },
  tower: { id: 'tower', signature: 'climb', weights: { climb: 6, stairs: 2, widening: 1, 'spike-run': 1, shuttle: 1, rest: 1 } },
};

/** Knihovna vzorů stylu: jeho váhy a jeho vzor od nejlehčího stupně. */
export function styledChunks(style: PlatformStyle, library: readonly PlatformChunk[] = PLATFORM_CHUNK_LIBRARY): PlatformChunk[] {
  return library.flatMap((chunk) => {
    const weight = style.weights[chunk.id] ?? 0;
    return weight === 0 ? [] : [{ ...chunk, weight, from: chunk.id === style.signature ? 0 : chunk.from }];
  });
}

/**
 * Styl podle sady prostředí: les a louka = koruny, džungle (bažina) a voda =
 * lekníny, město, poušť a obchod = dlouhé desky s hroty, hrad, jeskyně, sopka
 * a vesmír = výstup. Sada, kterou tabulka nezná, nechá styl na semínku.
 */
const STYLE_OF_LOOK: Readonly<Partial<Record<LookId, PlatformStyleId>>> = {
  forest: 'canopy',
  meadow: 'canopy',
  snow: 'canopy',
  graveyard: 'canopy',
  jungle: 'pads',
  beach: 'pads',
  ocean: 'pads',
  underwater: 'pads',
  city: 'runway',
  desert: 'runway',
  mall: 'runway',
  supermarket: 'runway',
  living_room: 'runway',
  factory: 'runway',
  castle: 'tower',
  cave: 'tower',
  volcano: 'tower',
  space: 'tower',
};

export const platformStyleFor = (look: LookId | null): PlatformStyleId | undefined => (look === null ? undefined : STYLE_OF_LOOK[look]);
