/** Ordinary-input adversarial shot: aim at the physical keeper, not the goal. */
import { baseControlOf } from '../addons';
import { AXIS_MAX, BODY, BUTTON, COUNTER, FLAG, HEADER, NO_INPUT, ROLE, bodyBase, type ArcadeInput, type ArcadeWorld } from '../contract';
import { BALL, ballFlight, ballSpeed, type BallGoal } from './ball';

export function ballKeeperProbeInput(world: ArcadeWorld, state: ArrayLike<number>, keeper: number, recent: readonly ArcadeInput[] = []): ArcadeInput {
  const k = bodyBase(keeper), p = bodyBase(state[HEADER.player]!);
  // A paced game (P51, `pacing_control`) wraps the ball control; the probe asks for the control underneath.
  if (baseControlOf(world.control).id !== 'ball' || state[k + BODY.role] !== ROLE.enemy || !(state[k + BODY.flags]! & FLAG.alive) || state[HEADER.counters + COUNTER.cooldown]! > recent.length || recent.some(input => input.buttons & BUTTON.TAP)) return NO_INPUT;
  const goal = world.rules.find(rule => rule.id === 'ball_launch')?.params.goal as BallGoal | undefined;
  if (goal !== 'goal' && goal !== 'hoop' && goal !== 'hole') return NO_INPUT;
  let chargeNow = Math.max(0, state[p + BODY.aux1]!);
  for (const input of recent) chargeNow = input.buttons & BUTTON.DOWN ? 0 : Math.min(BALL.maxCharge, chargeNow + Number(Boolean(input.buttons & BUTTON.HOLD)));
  // Search the complete box depth: a lob can meet its rear/top edge on descent.
  // Keep the contact above the floor, which cannot prove keeper interference.
  let charge = 0, flightTicks = 0, error = Infinity;
  for (let candidate = 1; candidate <= BALL.maxCharge; candidate++) {
    const first = Math.max(1, Math.floor((state[k + BODY.z]! - state[k + BODY.d]! / 2 - BALL.size / 2 - BALL.launchZ) / ballSpeed(candidate)));
    const last = Math.ceil((state[k + BODY.z]! + state[k + BODY.d]! / 2 + BALL.size / 2 - BALL.launchZ) / ballSpeed(candidate));
    for (let time = first; time <= last; time++) {
      const y = ballFlight(goal, candidate, time).y + BALL.size / 2;
      if (y < state[k + BODY.y]! + 300 || y > state[k + BODY.y]! + state[k + BODY.h]! - 200) continue;
      const distance = Math.abs(y - (state[k + BODY.y]! + state[k + BODY.h]! * (goal === 'hoop' ? 0.7 : 0.5)));
      if (distance < error) { error = distance; charge = candidate; flightTicks = time; }
    }
  }
  if (charge === 0) return NO_INPUT;
  let x = state[k + BODY.x]!, vx = state[k + BODY.vx]!, phase = state[k + BODY.aux0]!;
  const period = state[k + BODY.aux1]!;
  for (let t = 0; t < recent.length + Math.max(0, charge - chargeNow) + flightTicks + 1; t++) {
    x += vx;
    if (++phase >= period && period > 0) { phase = 0; vx = -vx; }
  }
  const aim = Math.round(AXIS_MAX * x / (ballSpeed(charge) * flightTicks));
  if (Math.abs(aim) > AXIS_MAX) return NO_INPUT;
  return { axis: aim, buttons: chargeNow < charge ? BUTTON.HOLD : BUTTON.TAP };
}
