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

import type { ArcadeInput, ArcadeLevel, ArcadeObservation, BotPiece, PieceRef } from './contract';

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

export const ADDON_PIECES: Readonly<Record<AddonId, AddonPiece | undefined>> = {
  lives: livesAddon as AddonPiece,
  shoot: undefined,
  collect: undefined,
  chaser: undefined,
};

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
