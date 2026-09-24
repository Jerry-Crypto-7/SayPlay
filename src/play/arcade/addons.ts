/**
 * Doplňky arkády (P26D): druhá mechanika nad základním ovládáním – „jump and
 * shoot“, „run and collect“, „chased by a bear“, „three lives“.
 *
 * Doplněk je post-process: dostane hotové části základního ovládání (úroveň,
 * pravidla, robota) a přidá do nich těla, pravidla a počítadla. Robota obalí
 * kus `addon_bot` – ten zeptá základního robota a jeho vstup doplní (střela,
 * úhyb, cesta k minci). Hra bez doplňků se tudy nedotkne ničeho, takže hash
 * jejího světa zůstává. Které ovládání který doplněk bere: `CAPABILITIES`.
 */

import { z } from 'zod';

import { ADDONS, type AddonId, type GameSpecV1 } from '@/play/spec';

import {
  ARCADE_LIMITS,
  type ArcadeInput,
  type ArcadeLevel,
  type ArcadeObservation,
  BODY,
  BUTTON,
  type BotPiece,
  COUNTER,
  FLAG,
  HEADER,
  type PieceRef,
  ROLE,
  type RulePiece,
  bodyBase,
} from './contract';
import { RUNNER } from './pieces/runner';
import { type Row, nextRow } from './pieces/runner-bot';

/** Části hry, které staví základní ovládání a doplněk je rozšíří. */
export interface ArcadeParts {
  readonly control: PieceRef;
  readonly bot: PieceRef;
  readonly level: ArcadeLevel;
  readonly rules: PieceRef[];
  /** Úroveň neprošla kontrolou hratelnosti z konstrukce – svět se nestaví. */
  readonly issues?: readonly string[];
  /** Životy, které ovládání samo určí (rytmus je zastropuje, souboj bez nich nejde). */
  readonly health?: number;
}

export interface AddonContext {
  readonly spec: GameSpecV1;
  readonly seed: number;
}

/**
 * Úprava vstupu základního robota: dostane, co robot viděl a co zvolil, a
 * vrátí vstup s doplňkem (třeba přidá střelu). Čistá funkce jako `decide`.
 */
export type AddonBotStep = (observation: ArcadeObservation, input: ArcadeInput, base: PieceRef) => ArcadeInput;

export interface AddonPiece<P = unknown> {
  readonly id: AddonId;
  /** Parametry, které doplněk čte ze specu (počty, hustota). */
  readonly params: z.ZodType<P>;
  /** Životy, které doplněk dá, když je spec nemá (mechanika `health` má přednost). */
  readonly lives?: number;
  /** Parametry ovládání, které doplněk potřebuje (mince v úrovni). */
  readonly controlParams?: Readonly<Record<string, unknown>>;
  /** Přidá do úrovně těla, pravidla a počítadla. */
  apply?(parts: ArcadeParts, params: P, context: AddonContext): ArcadeParts;
  /** Úprava robota; doplněk bez ní robota neobaluje. */
  readonly bot?: AddonBotStep;
}

const noParams = z.object({}).strict();

/** `+lives`: tři životy. Náraz pak ubere život místo prohry – pravidla ovládání to podle `health` udělají sama. */
export const livesAddon: AddonPiece<z.infer<typeof noParams>> = {
  id: 'lives',
  params: noParams,
  lives: 3,
};

// ---------------------------------------------------------------------------
// +collect

/** Podíl mincí úrovně, které `+collect` chce, když věta počet neřekne. */
export const COLLECT_SHARE = 0.5;

const collectParams = z.object({ need: z.int().min(1).max(ARCADE_LIMITS.maxBodies).optional() }).strict();

/**
 * Běžec k minci uhne, jen když je mince před příští řadou překážek a její
 * pruh je v té řadě stejně dobrý jako nejlepší – robot pak z pruhu nemusí
 * zpátky a skok či skluz za něj dál řeší základní robot.
 */
const collectStep: AddonBotStep = ({ state, player, recent }, input, base) => {
  if (base.id !== 'runner_bot' || (input.buttons & (BUTTON.TAP | BUTTON.DOWN)) !== 0) return input;
  const p = bodyBase(player);
  let lane = state[p + BODY.aux0] as number;
  for (const seen of recent) {
    if ((seen.buttons & BUTTON.LEFT) !== 0) lane = Math.max(-1, lane - 1);
    if ((seen.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(1, lane + 1);
  }
  const pz = (state[p + BODY.z] as number) + (state[p + BODY.vz] as number) * recent.length;
  const row = nextRow(state, player);
  let coinZ = Number.POSITIVE_INFINITY;
  let coinLane = lane;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    if (state[b + BODY.role] !== ROLE.collectible || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const z = state[b + BODY.z] as number;
    if (z <= pz || z >= coinZ || (row !== null && z >= row.z)) continue;
    coinZ = z;
    coinLane = Math.round((state[b + BODY.x] as number) / RUNNER.laneWidth);
  }
  if (coinZ === Number.POSITIVE_INFINITY) return input;
  if (row !== null) {
    const status = (l: number) => (row.lanes[l + 1] as Row['lanes'][number]).status;
    if (status(coinLane) !== Math.min(status(-1), status(0), status(1))) return input;
  }
  if (coinLane < lane) return { buttons: BUTTON.LEFT, axis: 0 };
  if (coinLane > lane) return { buttons: BUTTON.RIGHT, axis: 0 };
  return input;
};

/**
 * Mince běžce do pruhu, který příští řada překážek nechává volný (nejbližší
 * k původnímu) – stopa mincí pak ukazuje bezpečnou cestu a hráč, který ji
 * sbírá, nemusí před řadou přebíhat. Řada bez volného pruhu mince nechá.
 */
function coinsOnFreeLanes(level: ArcadeLevel): ArcadeLevel {
  const rows = new Map<number, Set<number>>();
  for (const body of level.bodies) {
    if (body.role !== 'obstacle') continue;
    rows.set(body.z, (rows.get(body.z) ?? new Set()).add(Math.round(body.x / RUNNER.laneWidth)));
  }
  const zs = [...rows.keys()].sort((a, b) => a - b);
  const bodies = level.bodies.map((body) => {
    if (body.role !== 'collectible') return body;
    const next = zs.find((z) => z > body.z);
    const taken = next === undefined ? undefined : rows.get(next);
    const lane = Math.round(body.x / RUNNER.laneWidth);
    if (taken === undefined || !taken.has(lane)) return body;
    const free = [0, -1, 1].filter((candidate) => !taken.has(candidate)).sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane));
    return free.length === 0 ? body : { ...body, x: (free[0] as number) * RUNNER.laneWidth };
  });
  return { ...level, bodies };
}

/**
 * `+collect`: mince, které generátor už klade na dosažitelná místa (běžec
 * mezi řady, plošinovka na desky, poletování do průletu), se počítají do
 * `items` a cíl pustí dál jen s aspoň `need` mincemi – jinak prohra.
 */
export const collectAddon: AddonPiece<z.infer<typeof collectParams>> = {
  id: 'collect',
  params: collectParams,
  controlParams: { coins: true },
  apply: (input, params) => {
    const parts = input.control.id === 'runner' ? { ...input, level: coinsOnFreeLanes(input.level) } : input;
    const kinds = [...new Set(parts.level.bodies.map((body) => body.kind))];
    const coins = parts.level.bodies.filter((body) => body.role === 'collectible' && body.kind === 'coin').length;
    if (coins === 0) return { ...parts, issues: [...(parts.issues ?? []), 'collect: the level has no coins to collect'] };
    const need = Math.min(coins, params.need ?? Math.max(1, Math.round(coins * COLLECT_SHARE)));
    const rules = parts.rules.map((rule) => (rule.id === 'finish' ? { id: 'finish_collected', params: { need } } : rule));
    rules.push({ id: 'collect_count', params: { kind: kinds.indexOf('coin') } });
    return { ...parts, rules };
  },
  bot: collectStep,
};

const countParams = z.object({ kind: z.int().min(0).max(ARCADE_LIMITS.maxBodies) }).strict();

/** Sebraná mince (předmět role `collectible` s modelem `kind`) → `items` + 1. Zmizení řeší `pickup`. */
export const collectCount: RulePiece<z.infer<typeof countParams>> = {
  id: 'collect_count',
  params: countParams,
  roles: ['player', 'collectible'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) => {
    const b = bodyBase(other);
    return state[b + BODY.role] === ROLE.collectible && state[b + BODY.kind] === params.kind ? [{ kind: 'count', counter: 'items', amount: 1 }] : [];
  },
};

const needParams = z.object({ need: z.int().min(1).max(ARCADE_LIMITS.maxBodies) }).strict();

/** Cíl s mincemi: aspoň `need` sebraných = výhra, míň = prohra (hráč vidí, kolik chybělo). */
export const finishCollected: RulePiece<z.infer<typeof needParams>> = {
  id: 'finish_collected',
  params: needParams,
  roles: ['player', 'goal'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) => {
    if (state[bodyBase(other) + BODY.role] !== ROLE.goal) return [];
    return (state[HEADER.counters + COUNTER.items] as number) >= params.need ? [{ kind: 'win' }] : [{ kind: 'lose' }];
  },
};

export const ADDON_RULES = { collect_count: collectCount, finish_collected: finishCollected } as const;

export const ADDON_PIECES: Readonly<Record<AddonId, AddonPiece | undefined>> = {
  lives: livesAddon as AddonPiece,
  collect: collectAddon as AddonPiece,
  shoot: undefined,
  chaser: undefined,
};

/** Parametry ovládání, které doplňky vyžadují (mince pro `+collect`), přes ty ze specu. */
export function addonControlParams(spec: GameSpecV1): Readonly<Record<string, unknown>> | undefined {
  const forced = piecesOf(spec).flatMap((piece) => (piece.controlParams === undefined ? [] : [piece.controlParams]));
  return forced.length === 0 ? spec.controlParams : Object.assign({}, spec.controlParams, ...forced);
}

const piecesOf = (spec: GameSpecV1): AddonPiece[] =>
  (spec.addons ?? []).map((id) => ADDON_PIECES[id]).filter((piece): piece is AddonPiece => piece !== undefined);

/** Životy od doplňků, když spec nemá mechaniku `health`. */
export function addonLives(spec: GameSpecV1): number | undefined {
  const lives = piecesOf(spec).flatMap((piece) => (piece.lives === undefined ? [] : [piece.lives]));
  return lives.length === 0 ? undefined : Math.max(...lives);
}

/** Aplikuje doplňky v pořadí `spec.addons` a obalí robota, pokud to některý chce. */
export function applyAddons(parts: ArcadeParts, context: AddonContext): ArcadeParts {
  const pieces = piecesOf(context.spec);
  let next = parts;
  for (const piece of pieces) if (piece.apply !== undefined) next = piece.apply(next, piece.params.parse({}), context);
  const botted = pieces.filter((piece) => piece.bot !== undefined).map((piece) => piece.id);
  if (botted.length === 0) return next;
  return { ...next, bot: { id: 'addon_bot', params: { base: next.bot, addons: botted } } };
}

const addonBotParams = z
  .object({
    base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict(),
    addons: z.array(z.enum(ADDONS)).min(1).max(3),
  })
  .strict();

/**
 * Robot s doplňky: základní robot rozhodne, doplňky v pořadí vstup upraví.
 * `bases` jsou roboti knihovny – předávají se zvenku, ať knihovna a doplňky
 * nemají kruhový import.
 */
export function makeAddonBot(bases: Readonly<Record<string, BotPiece>>): BotPiece<z.infer<typeof addonBotParams>> {
  return {
    id: 'addon_bot',
    params: addonBotParams,
    roles: ['player'],
    // Všichni základní roboti reagují s 8 tiky; obal musí vidět stejně staré stavy.
    reactionTicks: 8,
    cost: () => ({ bodies: 0, rules: 0 }),
    decide: (observation, params) => {
      const base = bases[params.base.id];
      if (base === undefined) throw new Error(`arcade: unknown bot ${params.base.id}`);
      let input = base.decide(observation, base.params.parse(params.base.params));
      for (const id of params.addons) {
        const step = ADDON_PIECES[id]?.bot;
        if (step !== undefined) input = step(observation, input, params.base);
      }
      return input;
    },
  };
}
