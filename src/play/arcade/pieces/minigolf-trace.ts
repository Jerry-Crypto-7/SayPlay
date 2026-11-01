/**
 * Důkaz hry minigolfu (P68 T7): přehraje záznam v Node od tiku 0 a vydá, co se na dráze opravdu stalo – výhradně ze
 * stavu po každém tiku, nikdy z efektu `win` nebo `score`. Brána a testy věří tomuhle, ne výsledku pravidla.
 *
 * - `strokes` – čítač ran ve stavu na konci (`strokesOf`); `shots` – tiky záznamu s `TAP` (rána ze vstupu). Bez návratu
 *   z mimo dráhy a bez puštění za pohybu platí `strokes = shots` (zmrazená aserce P68 `strokes-counted`).
 * - `aimChanges` – tiky, ve kterých se změnilo míření hráče (`aux0`); `chargeTicks` – tiky, ve kterých nabití (`aux1`) rostlo.
 * - `bounces` – tiky, ve kterých se jedoucí míček odrazil: rychlost po tiku je jiná, než jakou by dal samotný útlum.
 * - `outOfBounds` – návraty z mimo dráhy (čítač stavu); `holed` – na konci leží střed míčku v kruhu jamky a míček
 *   jede nejvýš `holeSpeed` (spadl do jamky); `outcome` – stav běhu jádra; `ticks` – délka běhu.
 */

import { ARCADE_LIMITS, type ArcadeWorld, BODY, BUTTON, HEADER, type InputEvent, NO_INPUT, bodyBase, nativeRule } from '../contract';
import { type ArcadeOutcome, instantiate, loadProgram, outcomeOf, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { outOfBoundsOf, strokesOf } from './minigolf';
import type { MinigolfLayout } from './minigolf-hole';
import { MINIGOLF, isqrt, minigolfDamp } from './minigolf-roll';

export interface MinigolfEvidence {
  readonly strokes: number;
  readonly shots: number;
  readonly aimChanges: number;
  readonly chargeTicks: number;
  readonly bounces: number;
  readonly outOfBounds: number;
  readonly holed: boolean;
  readonly outcome: ArcadeOutcome;
  readonly ticks: number;
}

/** Rozložení jamky ze světa – pravidlo `minigolf_hole` ho nese i pod obalem složené hry. */
export function minigolfLayoutOf(world: ArcadeWorld): MinigolfLayout {
  const rule = nativeRule(world.rules, 'minigolf_hole');
  if (rule === undefined) throw new Error('minigolf: the world has no minigolf_hole rule');
  return rule.params.layout as MinigolfLayout;
}

export function minigolfEvidence(world: ArcadeWorld, inputs: readonly InputEvent[]): MinigolfEvidence {
  const layout = minigolfLayoutOf(world);
  const program = loadProgram(world, ARCADE_LIBRARY);
  const state = instantiate(world);
  const byTick = new Map(inputs.map((event) => [event.tick, event]));
  const p = bodyBase(state[HEADER.player] as number);
  let aimChanges = 0;
  let chargeTicks = 0;
  let bounces = 0;
  while (outcomeOf(state) === 'running' && (state[HEADER.tick] as number) < ARCADE_LIMITS.maxTicks) {
    const aim = state[p + BODY.aux0] as number;
    const charge = state[p + BODY.aux1] as number;
    const vx = state[p + BODY.vx] as number;
    const vz = state[p + BODY.vz] as number;
    step(state, byTick.get(state[HEADER.tick] as number) ?? NO_INPUT, program);
    if ((state[p + BODY.aux0] as number) !== aim) aimChanges += 1;
    if ((state[p + BODY.aux1] as number) > charge) chargeTicks += 1;
    const nvx = state[p + BODY.vx] as number;
    const nvz = state[p + BODY.vz] as number;
    const [dvx, dvz] = minigolfDamp(vx, vz);
    if ((vx !== 0 || vz !== 0) && (nvx !== 0 || nvz !== 0) && (nvx !== dvx || nvz !== dvz)) bounces += 1;
  }
  const h = bodyBase(layout.hole);
  const dx = (state[p + BODY.x] as number) - (state[h + BODY.x] as number);
  const dz = (state[p + BODY.z] as number) - (state[h + BODY.z] as number);
  const size = state[h + BODY.w] as number;
  const speed = isqrt((state[p + BODY.vx] as number) ** 2 + (state[p + BODY.vz] as number) ** 2);
  return {
    strokes: strokesOf(state),
    shots: inputs.filter((event) => (event.buttons & BUTTON.TAP) !== 0).length,
    aimChanges,
    chargeTicks,
    bounces,
    outOfBounds: outOfBoundsOf(state),
    holed: 4 * (dx * dx + dz * dz) <= size * size && speed <= MINIGOLF.holeSpeed,
    outcome: outcomeOf(state),
    ticks: state[HEADER.tick] as number,
  };
}
