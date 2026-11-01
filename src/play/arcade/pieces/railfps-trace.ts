/**
 * Záznam hry střelnice z očí po ticích (P68-F T3): přehraje záznam vstupů jako `replay` jádra a o každém tiku
 * zapíše, co jádro udělalo – sektor natočení, ránu, zásahy, ztracené životy – a na konci výsledek a hash.
 * Jen čte: stav jádra po tiku a stopu pravidel, kterou jádro samo hlásí (`RuleTrace`). Žádná herní logika,
 * nic nepočítá znovu – testy z něj ověří, že výhra přišla z mířených zásahů, ne odjinud.
 *
 * - **Sektor natočení** (plánové `aux0`): krok natočení na držáku (`RAILFPS_SLOTS.yawStep`) zaokrouhlený na sektor.
 * - **Rána**: slot výstřelu držáku, jen v tiku, kdy ovládání běželo (v přestávce po kole svět stojí a slot drží
 *   ránu z posledního tiku kola).
 * - **Zásah**: tělo, které v tiku odstranilo pravidlo rány `railfps_shot` (stopa jádra). Podle příznaku „živé“
 *   by to nešlo: slot sraženého cíle může v témže tiku zabrat nový příchod, a nepřítel, který v tiku rány došel
 *   k hráči, by se počítal jako zásah. Sektor těla se čte ze stavu před tikem.
 * - **Ztráta života**: pokles čítače životů v tiku.
 */

import { ARCADE_LIMITS, type ArcadeWorld, COUNTER, HEADER, type InputEvent, NO_INPUT } from '../contract';
import { inBreak } from '../hooks';
import { type ArcadeLibrary, type ArcadeOutcome, hashArcade, instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { type RailfpsControlParams, YAW, foeSector, shotOf, yawStepOf } from './railfps';

export interface RailfpsTraceShot {
  readonly tick: number;
  readonly sector: number;
}

export interface RailfpsTraceHit {
  readonly tick: number;
  readonly body: number;
  /** Sektor zasaženého těla ve stavu před tikem. */
  readonly sector: number;
}

export interface RailfpsTraceLoss {
  readonly tick: number;
  readonly lives: number;
}

export interface RailfpsTrace {
  /** Sektor natočení po každém odehraném tiku (index = tik). */
  readonly sectors: readonly number[];
  readonly shots: readonly RailfpsTraceShot[];
  readonly hits: readonly RailfpsTraceHit[];
  readonly losses: readonly RailfpsTraceLoss[];
  readonly outcome: ArcadeOutcome;
  /** Odehraných tiků; poslední odehraný tik je `tick − 1`. */
  readonly tick: number;
  readonly hash: string;
}

/** Sektor kroku natočení: nejbližší, polovina od středu (souměrně vlevo i vpravo). */
const sectorOfStep = (step: number): number => Math.sign(step) * Math.round(Math.abs(step) / YAW.stepsPerSector);
const health = (state: Int32Array): number => state[HEADER.counters + COUNTER.health] as number;

/** Přehraje řídký, seřazený záznam od tiku 0 do konce běhu nebo `horizon` (jako `replay` jádra) a vrátí stopu. */
export function traceRailfps(world: ArcadeWorld, inputs: readonly InputEvent[], library: ArcadeLibrary, horizon: number = ARCADE_LIMITS.maxTicks): RailfpsTrace {
  const { keeper, hooks } = world.control.params as RailfpsControlParams;
  const shotRule = world.rules.findIndex((ref) => ref.id === 'railfps_shot');
  const program = loadProgram(world, library);
  const state = instantiate(world);
  const before = state.slice();
  const sectors: number[] = [];
  const shots: RailfpsTraceShot[] = [];
  const hits: RailfpsTraceHit[] = [];
  const losses: RailfpsTraceLoss[] = [];
  let next = 0;
  for (let tick = 0; tick < horizon && outcomeOf(state) === 'running'; tick += 1) {
    while (next < inputs.length && (inputs[next] as InputEvent).tick < tick) next += 1;
    const event = inputs[next];
    before.set(state);
    const struck: number[] = [];
    step(state, event !== undefined && event.tick === tick ? event : NO_INPUT, program, (rule, effect) => {
      if (rule === shotRule && effect.kind === 'despawn') struck.push(effect.body);
    });
    sectors.push(sectorOfStep(yawStepOf(state, keeper)));
    const shot = inBreak(before, hooks) ? null : shotOf(state, keeper);
    if (shot !== null) shots.push({ tick, sector: shot });
    for (const body of struck) hits.push({ tick, body, sector: foeSector(before, body) });
    const lost = health(before) - health(state);
    if (lost > 0) losses.push({ tick, lives: lost });
  }
  return { sectors, shots, hits, losses, outcome: outcomeOf(state), tick: state[HEADER.tick] as number, hash: hashArcade(state) };
}
