/**
 * Robot běžce sbírá mince (P46B R1): do pruhu s mincí před řadou zajede, jen když se z něj stihne vrátit do
 * průchodného pruhu řady; hrozbě chování uhne vždy (plánovač pruhů přebije tah k minci). Dřív jen uhýbal
 * a mince bral náhodou – mrtvý čas běžce měřil slepotu robota, ne prázdnou trať.
 */

import { describe, expect, it } from 'vitest';

import { type ArcadeInput, BODY, BUTTON, type BodyInit, bodyBase } from '../contract';
import { buildWorld, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { planLanes } from '../pieces/behaviours/lanes';
import { RUNNER } from '../pieces/runner';
import { runnerBot } from '../pieces/runner-bot';

const PLAYER: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: RUNNER.playerW, h: RUNNER.runH, d: RUNNER.playerD, solid: false };
const crate = (lane: number, z: number): BodyInit => ({ role: 'obstacle', kind: 'crate', x: lane * RUNNER.laneWidth, y: 0, z, w: 1400, h: 1500, d: 1400, solid: true });
const coin = (lane: number, z: number): BodyInit => ({ role: 'collectible', kind: 'coin', x: lane * RUNNER.laneWidth, y: 300, z, w: 500, h: 500, d: 500, solid: false });
const enemy = (lane: number, z: number): BodyInit => ({ role: 'enemy', kind: 'enemy', x: lane * RUNNER.laneWidth, y: 0, z, w: 900, h: 1500, d: 900, solid: false });
/** Tři mince v pruhu po 1,5 m jako generátor (`runner.ts`), poslední v `last`. */
const coins = (lane: number, last: number): BodyInit[] => [last - 3000, last - 1500, last].map((z) => coin(lane, z));

function world(bodies: readonly BodyInit[]) {
  const built = buildWorld({ seed: 1, control: { id: 'runner', params: { speed: 'normal' } }, rules: [], bot: { id: 'runner_bot', params: {} }, level: { bodies: [PLAYER, ...bodies], length: 100_000 } }, ARCADE_LIBRARY);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

/** Robot odehraje `ticks` tiků s pohledem `runnerBot.reactionTicks` starým (jako `runBot`); vrátí `x` hráče, když míjel `z`. */
function xWhenPassing(bodies: readonly BodyInit[], zs: readonly number[], ticks = 400): number[] {
  const built = world(bodies);
  const state = instantiate(built);
  const program = loadProgram(built, ARCADE_LIBRARY);
  const p = bodyBase(0);
  const history: Int32Array[] = [];
  const issued: ArcadeInput[] = [];
  const xs: (number | undefined)[] = zs.map(() => undefined);
  for (let tick = 0; tick < ticks; tick += 1) {
    history.push(state.slice());
    const seenAt = Math.max(0, tick - runnerBot.reactionTicks);
    const input = runnerBot.decide({ state: history[seenAt] as Int32Array, player: 0, tick: seenAt, recent: issued.slice(seenAt) }, {});
    issued.push(input);
    step(state, input, program);
    zs.forEach((z, i) => {
      if (xs[i] === undefined && (state[p + BODY.z] as number) >= z) xs[i] = state[p + BODY.x] as number;
    });
  }
  return xs.map((x) => x as number);
}

const inLane = (x: number, lane: number): boolean => Math.abs(x - lane * RUNNER.laneWidth) * 2 < 500 + RUNNER.playerW;

describe('robot běžce a mince', () => {
  it('takes coins in a lane the next row closes when there is time to leave it again', () => {
    // Bedna zavře pruh +1 v 30 m; mince v pruhu +1 končí v 13 m, robot se stihne vrátit.
    const [first, middle, last, row] = xWhenPassing([...coins(1, 13_000), crate(1, 30_000)], [10_000, 11_500, 13_000, 29_000]);
    expect([first, middle, last].every((x) => inLane(x as number, 1)), `x at coins ${String([first, middle, last])}`).toBe(true);
    expect(inLane(row as number, 1), `x at the row ${String(row)}`).toBe(false);
  });

  it('leaves coins the row is too close behind to come back from', () => {
    // Poslední mince 3 m před bednou ve stejném pruhu: návrat by nestihl (pohled 8 tiků + přejezd 8 + rezerva 8).
    const xs = xWhenPassing([...coins(1, 27_000), crate(1, 30_000)], [24_000, 25_500, 27_000, 29_000]);
    expect(xs.some((x) => inLane(x, 1)), `x ${String(xs)}`).toBe(false);
  });

  it('takes coins after the last row too', () => {
    // Bedna v pruhu 0 pošle robota vlevo; mince za ní jsou o dva pruhy vpravo.
    const xs = xWhenPassing([crate(0, 8_000), ...coins(1, 30_000)], [27_000, 28_500, 30_000]);
    expect(xs.every((x) => inLane(x, 1)), `x ${String(xs)}`).toBe(true);
  });

  it('does not cross into a lane with an enemy for coins', () => {
    // Nepřítel doplňku (`+shoot`) v pruhu +1 před mincemi: robot ho nevidí jako hrozbu chování, ale bokem do něj nevjede.
    const [atEnemy] = xWhenPassing([enemy(1, 8_000), ...coins(1, 13_000), crate(1, 30_000)], [8_000]);
    expect(inLane(atEnemy as number, 1), `x at the enemy ${String(atEnemy)}`).toBe(false);
  });

  it('dodges a row into the free lane without an enemy', () => {
    // Bedna v pruhu 0; volné jsou −1 i +1, v −1 stojí nepřítel – dřív robot volil při shodě vlevo.
    const [atRow] = xWhenPassing([enemy(-1, 15_000), crate(0, 20_000)], [20_000]);
    expect(inLane(atRow as number, 1), `x at the row ${String(atRow)}`).toBe(true);
  });

  it('a threat in the coin lane wins: the lane planner keeps the bot out', () => {
    const built = world([...coins(1, 13_000), crate(1, 30_000)]);
    const state = instantiate(built);
    state[bodyBase(0) + BODY.vz] = 150;
    const observation = { state, player: 0, tick: 0, recent: [] };
    const wanted = runnerBot.decide(observation, {});
    expect(wanted.buttons & BUTTON.RIGHT).toBe(BUTTON.RIGHT);
    // Úder v pruhu +1 přes mince: tah k nim neplatí.
    const strike = { x: RUNNER.laneWidth, y: 0, z: 3000, w: 900, h: 1500, d: 6000 };
    const input = planLanes(observation, [() => strike], wanted);
    expect(input.buttons & BUTTON.RIGHT).toBe(0);
  });
});
