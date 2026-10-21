/**
 * Publikační brána řetězu (P56C T6): každé kolo projde `verifyArcade` (robot, nečinný, dvojí přehrání,
 * svědci, důkaz sloves), robotovy záznamy kol složené na globální tiky vyhrají celý řetěz a jejich dvě
 * přehrání dají týž hash. Řetěz má 30–90 s, aspoň 3 různá ovládání a každé kolo hodiny, takže nejdelší možný běh
 * se vejde do záznamu Dare (T10). Par řetězu = robotův běh.
 */

import { ARCADE_HZ, ARCADE_LIMITS, type InputEvent } from '../arcade/contract';
import type { ArcadeLibrary } from '../arcade/kernel';
import { ARCADE_LIBRARY } from '../arcade/library';
import { type ArcadeVerdict, verifyArcade } from '../arcade/verify';
import { bindRoles } from '../arcade/witness';
import type { Par } from '../score/stars';
import type { ChainWorld } from './contract';
import { chainMaxTicks, replayChain, roundClock } from './run';

export const CHAIN_SECONDS = { min: 30, max: 90 } as const;
export const CHAIN_MIN_CONTROLS = 3;

export interface ChainVerdict {
  readonly rounds: readonly ArcadeVerdict[];
  /** Robotovy záznamy kol na globálních ticích – záznam, který server přijme jako Dare robota. */
  readonly inputs: readonly InputEvent[];
  readonly hash: string;
  readonly lengthSec: number;
  readonly controls: number;
  readonly par: Par | null;
  readonly failures: readonly string[];
}

/** Záznamy kol na globální tiky: kolo r začne po konci kola r − 1 (jeho `tick`) a kartě. */
export function chainBotInputs(chain: ChainWorld, runs: readonly { readonly inputs: readonly InputEvent[]; readonly tick: number }[]): InputEvent[] {
  const out: InputEvent[] = [];
  let start = 0;
  for (const run of runs) {
    for (const event of run.inputs) out.push({ ...event, tick: event.tick + start });
    start += run.tick + chain.cardTicks;
  }
  return out;
}

/** Délka řetězu v sekundách: tiky kola v jeho tempu (promile) a karta mezi koly v reálném čase. */
export function chainLengthSec(chain: Pick<ChainWorld, 'cardTicks'> & { readonly rounds: readonly { readonly rate: number }[] }, roundTicks: readonly number[]): number {
  const play = roundTicks.reduce((sum, ticks, index) => sum + ticks / (ARCADE_HZ * (chain.rounds[index]!.rate / 1000)), 0);
  return play + ((chain.rounds.length - 1) * chain.cardTicks) / ARCADE_HZ;
}

export function verifyChain(chain: ChainWorld, library: ArcadeLibrary = ARCADE_LIBRARY): ChainVerdict {
  const rounds = chain.rounds.map((round) => verifyArcade(round.world, library, bindRoles(round.spec, round.world)));
  const failures: string[] = [];
  rounds.forEach((verdict, index) => {
    const name = `round ${index + 1} (${chain.rounds[index]!.key})`;
    for (const failure of verdict.failures) {
      const [code] = failure.split(':');
      const prefix = code === 'bot_wins' ? 'chain_bot_wins' : code === 'idle_loses' ? 'chain_idle_loses' : code === 'replay_equal' ? 'chain_replay_equal' : 'chain_round';
      failures.push(`${prefix}: ${name}: ${failure}`);
    }
  });
  const inputs = chainBotInputs(chain, rounds.map((verdict) => verdict.bot));
  const first = replayChain(chain, inputs, library);
  const second = replayChain(chain, inputs, library);
  if (first.outcome !== 'won' && !failures.some((failure) => failure.startsWith('chain_bot_wins'))) {
    failures.push(`chain_bot_wins: the bot records of the rounds ${first.outcome} the chain at tick ${first.tick} (${first.results.join(', ')})`);
  }
  if (first.hash !== second.hash) failures.push('chain_replay_equal: two replays of the chain bot record ended in different states');
  const lengthSec = chainLengthSec(chain, rounds.map((verdict) => verdict.bot.tick));
  if (lengthSec < CHAIN_SECONDS.min || lengthSec > CHAIN_SECONDS.max) {
    failures.push(`chain_length: the chain plays ${lengthSec.toFixed(1)} s, outside ${CHAIN_SECONDS.min}–${CHAIN_SECONDS.max} s`);
  }
  const controls = new Set(chain.rounds.map((round) => round.spec.control)).size;
  if (controls < CHAIN_MIN_CONTROLS) failures.push(`chain_controls: ${controls} different controls, the chain needs at least ${CHAIN_MIN_CONTROLS}`);
  // Záznam Dare unese nejvýš `maxTicks` tiků (`unpackInputs`): každý běh řetězu, i s prohranými koly, musí skončit dřív (debata T9).
  chain.rounds.forEach((round, index) => {
    if (roundClock(round.world) === null) failures.push(`chain_clock: round ${index + 1} (${round.key}) has no clock, so a run of it may never end`);
  });
  const longest = chainMaxTicks(chain);
  if (longest !== null && longest > ARCADE_LIMITS.maxTicks) failures.push(`chain_ticks: the longest run of the chain is ${longest} ticks, over the ${ARCADE_LIMITS.maxTicks} a dare record holds`);
  return { rounds, inputs, hash: first.hash, lengthSec, controls, par: first.outcome === 'won' ? { score: first.score, ticks: first.tick } : null, failures };
}
