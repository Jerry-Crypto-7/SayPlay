/** Per-instance pacing delegates every native movement; no position writes. */
import { z } from 'zod';
import { BODY, bodyBase, type ControlPiece, type BotPiece, type PieceRef, type ArcadeObservation } from '../contract';
import { phasesSchema, phaseSpeed } from '../../compose/progression';
const paramsSchema = z.object({ base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }), phases: phasesSchema, length: z.int().positive() });
export function makePacedControl(controls: Readonly<Record<string, ControlPiece>>): ControlPiece<z.infer<typeof paramsSchema>> {
  return { id: 'phase_control', params: paramsSchema, roles: ['player'], cost: () => ({ bodies: 0, rules: 0 }),
    step(state, player, input, params) {
      const native = controls[params.base.id];
      if (!native) throw new Error(`Unknown paced control ${params.base.id}`);
      const p = bodyBase(player), raw = params.base.params;
      const at = state[p + BODY.z]!;
      const speed = (value: number) => phaseSpeed(value, at, params.length, params.phases);
      const adjusted = { ...raw, ...(typeof raw.topSpeed === 'number' ? { topSpeed: speed(raw.topSpeed) } : {}), ...(typeof raw.speed === 'number' ? { speed: speed(raw.speed) } : {}) };
      // Original schema is parsed at compilation; scaled speed is a bounded runtime value.
      native.step(state, player, input, adjusted);
      // Plošinovka ne (P46B T6): její rychlost se k cíli rozjíždí a škálování výsledku by ji násobilo každý tik dál –
      // fáze jí škálují nejvyšší rychlost běhu `speed` (výše), jako poletování.
      if (params.base.id === 'runner') state[p + BODY.vz] = speed(state[p + BODY.vz]!);
    } };
}
export function makePacedBot(bots: Readonly<Record<string, BotPiece>>): BotPiece<z.infer<typeof paramsSchema>> {
  return { id: 'phase_bot', params: paramsSchema, roles: ['player'], reactionTicks: 8, cost: () => ({ bodies: 0, rules: 0 }),
    decide(observation, params) {
      const native = bots[params.base.id];
      if (!native) throw new Error(`Unknown paced bot ${params.base.id}`);
      const raw = params.base.params, at = observation.state[bodyBase(observation.player) + BODY.z]!;
      const speed = (value: number) => phaseSpeed(value, at, params.length, params.phases);
      return native.decide(observation, { ...raw, ...(typeof raw.topSpeed === 'number' ? { topSpeed: speed(raw.topSpeed) } : {}), ...(typeof raw.speed === 'number' ? { speed: speed(raw.speed) } : {}) });
    } };
}

/** Parametry fáze podle objektu ve světě: obal robota se ptá v každém tiku a svět se mezi tiky nemění (R5). */
const parsedPhases = new WeakMap<object, z.infer<typeof paramsSchema>>();

/** Addon aiming must still see the native movement and its current speed. */
export function pacedBotBase(ref: PieceRef, observation: ArcadeObservation): PieceRef {
  // Průběh hry (P45C) obalí robota fází; doplněk má vidět základního robota pod oběma.
  if (ref.id === 'pacing_bot') return pacedBotBase(ref.params.base as PieceRef, observation);
  if (ref.id !== 'phase_bot') return ref;
  let params = parsedPhases.get(ref.params);
  if (params === undefined) parsedPhases.set(ref.params, (params = paramsSchema.parse(ref.params)));
  const raw = params.base.params;
  const at = observation.state[bodyBase(observation.player) + BODY.z]!;
  const speed = (value: number) => phaseSpeed(value, at, params.length, params.phases);
  return { ...params.base, params: { ...raw, ...(typeof raw.topSpeed === 'number' ? { topSpeed: speed(raw.topSpeed) } : {}), ...(typeof raw.speed === 'number' ? { speed: speed(raw.speed) } : {}) } };
}
