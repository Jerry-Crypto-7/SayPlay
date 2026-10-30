/**
 * Robot díry (P66 T6): jede k věci, která za cestu dá nejvíc – body třídy × vzácnost na vzdálenost – a kterou
 * díra už polkne; věc za větší věcí (díra by o ni zavadila a klouzala) má cenu menší. Jakmile jde polknout největší
 * věc (stupeň 4 v posledním kole), jede rovnou k ní. Vidí stav o reakci starší, polohu díry si posune o její
 * rychlost za tiky, které ve stavu ještě nejsou.
 *
 * **Slabý robot** (`mistakes`, ‰ oken po `HOLE_BOT.window` ticích): v okně chyby jede do nejbližší věci, která je
 * na díru moc velká – nepozná práh velikosti a stojí o ni opřený. Ze semínka oken (celá čísla), ne z náhody.
 */

import { z } from 'zod';

import { type ArcadeInput, type ArcadeObservation, ARCADE_LIMITS, BODY, type BotPiece, FLAG, NO_INPUT, UNIT, bodyBase } from '../contract';
import { rarityOf } from '../hooks';
import { RARITY_SCORE } from '../hooks/contract';
import { arenaAxis } from './arena';
import { HOLE, blockDistance, classOf, tierOf } from './hole';

const index = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);
const botParams = z
  .object({
    half: z.int().min(UNIT).max(100 * UNIT),
    keeper: index,
    rounds: z.int().min(HOLE.rounds.min).max(HOLE.rounds.max),
    need: z.int().min(1).max(9999),
    first: index,
    count: z.int().min(1).max(ARCADE_LIMITS.maxBodies),
    finale: index,
    /** Slabý robot: ‰ oken, ve kterých jede do věci větší než díra. */
    mistakes: z.int().min(0).max(1000).optional(),
  })
  .strict();
export type HoleBotParams = z.infer<typeof botParams>;

export const HOLE_BOT = {
  /** K ceně věci se přičte tolik jednotek vzdálenosti – blízká drobnost nepřebije o kus dál ležící větší věc. */
  reach: 2000,
  /** Cena věci za větší věcí (‰). */
  blocked: 300,
  /** Okno chyby slabého robota (tiky). */
  window: 30,
} as const;

const alive = (state: Int32Array, body: number): boolean => ((state[bodyBase(body) + BODY.flags] as number) & FLAG.alive) !== 0;

interface Spot {
  readonly body: number;
  readonly x: number;
  readonly z: number;
  readonly size: number;
}

/** Vzdálenost bodu `(px, pz)` od úsečky `(ax, az) → (bx, bz)` (na druhou). */
function segmentGap2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ux = bx - ax;
  const uz = bz - az;
  const span = ux * ux + uz * uz;
  const t = span === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * ux + (pz - az) * uz) / span));
  const dx = px - (ax + ux * t);
  const dz = pz - (az + uz * t);
  return dx * dx + dz * dz;
}

/** Okno chyby slabého robota? Celočíselný rozptyl čísla okna. */
export const mistakeWindow = (tick: number, mistakes: number): boolean => mistakes > 0 && (Math.imul(Math.floor(tick / HOLE_BOT.window) + 1, 0x9e3779b1) >>> 0) % 1000 < mistakes;

export function holeDecide(observation: ArcadeObservation, params: HoleBotParams): ArcadeInput {
  const { state, player, recent } = observation;
  const base = bodyBase(player);
  const x = (state[base + BODY.x] as number) + (state[base + BODY.vx] as number) * recent.length;
  const z = (state[base + BODY.z] as number) + (state[base + BODY.vz] as number) * recent.length;
  const hole = HOLE.tiers[tierOf(state, params)] as number;
  const spots: Spot[] = [];
  for (const body of [params.finale, ...Array.from({ length: params.count }, (_, k) => params.first + k)]) {
    if (!alive(state, body)) continue;
    const at = bodyBase(body);
    spots.push({ body, x: state[at + BODY.x] as number, z: state[at + BODY.z] as number, size: state[at + BODY.w] as number });
  }
  const blockers = spots.filter((spot) => spot.size >= hole);
  const edible = spots.filter((spot) => spot.size < hole);
  if (params.mistakes !== undefined && mistakeWindow(observation.tick, params.mistakes) && blockers.length > 0) {
    const wrong = blockers.reduce((best, spot) => ((spot.x - x) ** 2 + (spot.z - z) ** 2 < (best.x - x) ** 2 + (best.z - z) ** 2 ? spot : best));
    return { buttons: 0, axis: arenaAxis(wrong.x - x, wrong.z - z) };
  }
  const finale = edible.find((spot) => spot.body === params.finale);
  let target: Spot | undefined = finale;
  if (target === undefined) {
    let best = -1;
    for (const spot of edible) {
      const rarity = rarityOf(state, spot.body);
      const value = (HOLE.points[Math.max(0, classOf(spot.size))] as number) * (rarity === undefined ? 1 : RARITY_SCORE[rarity]);
      const far = Math.sqrt((spot.x - x) ** 2 + (spot.z - z) ** 2) + HOLE_BOT.reach;
      const stuck = blockers.some((block) => segmentGap2(block.x, block.z, x, z, spot.x, spot.z) < blockDistance(hole, block.size) ** 2);
      const worth = (value * (stuck ? HOLE_BOT.blocked : 1000)) / far;
      if (worth > best) {
        best = worth;
        target = spot;
      }
    }
  }
  if (target === undefined) return NO_INPUT;
  return { buttons: 0, axis: arenaAxis(target.x - x, target.z - z) };
}

export const holeBot: BotPiece<HoleBotParams> = {
  id: 'hole_bot',
  params: botParams,
  roles: ['player', 'collectible'],
  reactionTicks: 8,
  cost: () => ({ bodies: 0, rules: 0 }),
  decide: holeDecide,
};
