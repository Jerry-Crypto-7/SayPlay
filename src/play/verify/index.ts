/**
 * Verifikátor her (P23-A, T9): `CompiledGame` → `QualityReport`.
 *
 * Zpráva je **brána publikace**, proto se každé tvrzení specu dokazuje nad
 * skutečným runtimem a nic se nedovozuje z blueprintu. Každé tvrzení dostane
 * vlastní `createRuntime`, takže žádné nevidí stav, který za sebou nechalo
 * jiné.
 *
 * Čtyři druhy důkazu:
 * - `keypoint` – vstřik, akce, aserce (`keypoint.ts`),
 * - `reachability` – replay autorského svědka přes `verifyWitness`; ten
 *   svědka krok po kroku odehraje a certifikuje jen výhru, takže „hra jde
 *   vyhrát“ je dokázaná stejně, jako ji dokazuje certifikace emise. Hledač
 *   (`solveWitnessDetailed`) by hledal *jinou* cestu k témuž tvrzení za
 *   desítky sekund na svět (naměřeno 20. 9. 2026: 2 623 uzlů, 48 s), proto
 *   se nevolá,
 * - `termination` – svědek dojde do výhry uvnitř horizontu svého tieru,
 * - `replay` – dva nezávislé běhy téhož svědka končí týmž hashem stavu.
 *
 * `count` a `relation` runtime neumí odlišit od obyčejné aserce po svědkovi;
 * dostanou proto tentýž replay a soudí je `assertFailures`.
 */

import { buildRuntimeWorld } from '@/ir/build';
import { hashHex } from '@/sim/hash';
import { type Runtime, type TraceInput, createRuntime, step } from '@/sim/interpreter';
import { TIER_POLICY, isTier } from '@/verify/tiers';
import { verifyWitness } from '@/verify/witness';

import type { CompiledGame, KeypointEvidence, QualityReport } from '../contracts';
import type { VerificationAssertion } from '../spec';
import { surfaceOf } from './inject';
import { assertFailures, runKeypoint } from './keypoint';

export { DEFAULT_KEYPOINT_TICKS, runKeypoint } from './keypoint';
export { injectSetup } from './inject';

interface WitnessRun {
  readonly runtime: Runtime;
  readonly hashBefore: string;
  readonly hashAfter: string;
  readonly ticks: number;
  readonly fired: readonly string[];
  readonly certified: boolean;
  readonly winsAtTick: number | null;
  readonly detail: string | null;
}

/** Postaví svět a odehraje jeho vlastního svědka až do konce běhu nebo horizontu. */
function replayWitness(compiled: CompiledGame): WitnessRun {
  const sim = surfaceOf(compiled);
  const built = buildRuntimeWorld(sim);
  if (!built.ok) throw new Error(`verifyGame: ${built.issues.join('; ')}`);
  const verdict = verifyWitness(built.world, built.world.trace);

  const runtime = createRuntime(built.world);
  const hashBefore = hashHex(runtime.state);
  const trace = built.world.trace as readonly TraceInput[];
  const horizon = TIER_POLICY[isTier(sim.witness.tier) ? sim.witness.tier : 'short'].maxHorizonTicks;
  const fired: string[] = [];
  for (let tick = 0; tick < horizon && runtime.runState === 'running'; tick += 1) {
    const result = step(
      runtime,
      trace.filter((input) => input.tick === tick),
    );
    fired.push(...result.fired);
  }

  return {
    runtime,
    hashBefore,
    hashAfter: hashHex(runtime.state),
    ticks: runtime.tick,
    fired,
    certified: verdict.verdict === 'CERTIFIED',
    winsAtTick: verdict.verdict === 'CERTIFIED' ? verdict.witnessLength : null,
    detail: verdict.verdict === 'CERTIFIED' ? null : `${verdict.reason}: ${verdict.detail}`,
  };
}

function evidence(assertion: VerificationAssertion, run: WitnessRun, failures: readonly string[]): KeypointEvidence {
  return {
    assertionId: assertion.id,
    mechanicId: assertion.mechanic ?? null,
    passed: failures.length === 0,
    hashBefore: run.hashBefore,
    hashAfter: run.hashAfter,
    ticks: run.ticks,
    failures,
  };
}

export function verifyGame(compiled: CompiledGame): QualityReport {
  const sim = surfaceOf(compiled);
  const witness = replayWitness(compiled);
  const second = replayWitness(compiled);
  const replayEqual = witness.hashAfter === second.hashAfter;
  const horizon = TIER_POLICY[isTier(sim.witness.tier) ? sim.witness.tier : 'short'].maxHorizonTicks;

  const keypoints = compiled.spec.verification.map((assertion): KeypointEvidence => {
    if (assertion.kind === 'keypoint') return runKeypoint(compiled, assertion);

    const failures = [...assertFailures(compiled, witness.runtime, assertion.assert, witness.fired)];
    if (assertion.kind === 'reachability' && !witness.certified) failures.push(`reachability: ${String(witness.detail)}`);
    if (assertion.kind === 'termination') {
      if (witness.winsAtTick === null) failures.push(`termination: the witness never won (${String(witness.detail)})`);
      else if (witness.winsAtTick > horizon) failures.push(`termination: the witness won at tick ${witness.winsAtTick}, past the ${horizon} tick horizon`);
    }
    if (assertion.assert.replayEqual === true && !replayEqual) failures.push('replayEqual: two runs of the witness ended in a different state');
    return evidence(assertion, witness, failures);
  });

  const budgets = {
    entities: Object.keys(sim.entities).length,
    rules: Object.keys(sim.rules).length,
    // Trojúhelníky zná až prohlížeč, který geometrii zkompiluje; kompilátor
    // jich žádné nepočítá, a vymyšlené číslo by rozpočet jen předstíralo.
    triangles: null,
  };
  const withinBudgets = budgets.entities <= compiled.spec.budgets.maxEntities && budgets.rules <= compiled.spec.budgets.maxRules;

  return {
    specHash: compiled.specHash,
    worldHash: compiled.worldHash,
    keypoints,
    witness: { certified: witness.certified, winsAtTick: witness.winsAtTick },
    replayEqual,
    budgets,
    publishEligible: keypoints.every((keypoint) => keypoint.passed) && witness.certified && replayEqual && withinBudgets,
  };
}
