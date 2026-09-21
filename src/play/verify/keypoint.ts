/**
 * Jedno tvrzení nad skutečným runtimem (P23-A, T9).
 *
 * Postup je vždy týž: vstřik (`inject.ts`) → `hashBefore` → akce jako
 * `TraceInput` s actorem hráče → doběh `ticks` → aserce nad `readSlot`,
 * `runState` a `StepResult.fired` → `hashAfter`. Žádné čtení blueprintu:
 * tvrzení platí o tom, co runtime doopravdy udělal, ne o tom, co kompilátor
 * zamýšlel.
 *
 * Tiky akcí kopírují `planWitness` kompilátoru: `moveTo` stojí 1 tik prodlevy
 * plus 1 tik na buňku (`settle` posouvá o jednu buňku za tik), každý krok má
 * 2 tiky navíc, aby `onEnterZone` stihl hranu a `emit` doručení.
 */

import { type Runtime, type TraceInput, step } from '@/sim/interpreter';
import { hashHex } from '@/sim/hash';
import { readSlot } from '@/sim/state';

import type { CompiledGame, KeypointEvidence } from '../contracts';
import type { Cell } from '../compile/layout';
import type { VerificationAssertion } from '../spec';
import { type Injected, entitiesOfRole, injectSetup, surfaceOf } from './inject';

/** Kolik tiků nechat doběhnout, když tvrzení nic neříká. */
export const DEFAULT_KEYPOINT_TICKS = 40;

type Assert = VerificationAssertion['assert'];

const manhattan = (a: Cell, b: Cell): number => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);

/** Akce tvrzení na stopu: cíl je role, runtime chce instanci. */
function scheduleActions(compiled: CompiledGame, injected: Injected, actions: VerificationAssertion['actions']): TraceInput[] {
  const sim = surfaceOf(compiled);
  const inputs: TraceInput[] = [];
  let at = injected.cells[sim.entities[injected.player].socket];
  let tick = 0;
  for (const action of actions ?? []) {
    const target = entitiesOfRole(compiled, action.target)[0];
    if (target === undefined) continue;
    inputs.push({ tick, actor: injected.player, actionId: action.actionId, target });
    if (action.actionId === 'moveTo') {
      const cell = injected.cells[sim.entities[target].socket];
      tick += 1 + manhattan(at, cell);
      at = cell;
    }
    tick += 2;
  }
  return inputs;
}

/** Odkrokuje stopu a doběh; vrací `ruleId` všeho, co během okna spustilo. */
function play(runtime: Runtime, inputs: readonly TraceInput[], settleTicks: number): string[] {
  const lastInput = inputs.length > 0 ? (inputs[inputs.length - 1] as TraceInput).tick : 0;
  const horizon = lastInput + settleTicks;
  const fired: string[] = [];
  for (let tick = 0; tick <= horizon && runtime.runState === 'running'; tick += 1) {
    const result = step(
      runtime,
      inputs.filter((input) => input.tick === tick),
    );
    fired.push(...result.fired);
  }
  return fired;
}

/**
 * Aserce nad stavem po doběhu. `replayEqual` sem nepatří – to je tvrzení o
 * dvou bězích, ne o jednom stavu, a řeší ho volající.
 */
export function assertFailures(compiled: CompiledGame, runtime: Runtime, expect: Assert, fired: readonly string[]): string[] {
  const failures: string[] = [];
  const slot = (id: string): number => readSlot(runtime.layout, runtime.state, id);
  const declared = (id: string): boolean => runtime.layout.index.has(id);

  if (expect.runState !== undefined && runtime.runState !== expect.runState) {
    failures.push(`runState is ${runtime.runState}, expected ${expect.runState}`);
  }
  for (const [id, value] of Object.entries(expect.counters ?? {})) {
    if (!declared(`c:${id}`)) failures.push(`counters: the world declares no counter ${id}`);
    else if (slot(`c:${id}`) !== value) failures.push(`counter ${id} is ${slot(`c:${id}`)}, expected ${value}`);
  }
  for (const [id, value] of Object.entries(expect.flags ?? {})) {
    if (!declared(`f:${id}`)) failures.push(`flags: the world declares no flag ${id}`);
    else if ((slot(`f:${id}`) === 1) !== value) failures.push(`flag ${id} is ${String(slot(`f:${id}`) === 1)}, expected ${String(value)}`);
  }
  for (const [roleId, value] of Object.entries(expect.entityStates ?? {})) {
    const instances = entitiesOfRole(compiled, roleId);
    if (instances.length === 0) failures.push(`entityStates: no entity for role ${roleId}`);
    for (const id of instances) {
      const table = runtime.entityStates.get(id);
      const state = table?.values[slot(`e:${id}:state`)];
      if (state !== value) failures.push(`entity ${id} is in state ${String(state)}, expected ${value}`);
    }
  }
  for (const [roleId, value] of Object.entries(expect.locked ?? {})) {
    const instances = entitiesOfRole(compiled, roleId);
    if (instances.length === 0) failures.push(`locked: no entity for role ${roleId}`);
    for (const id of instances) {
      if ((slot(`e:${id}:locked`) === 1) !== value) failures.push(`entity ${id} locked is ${String(slot(`e:${id}:locked`) === 1)}, expected ${String(value)}`);
    }
  }
  failures.push(...firedFailures(compiled, expect.firedMechanics ?? [], fired));
  return failures;
}

/**
 * „Mechanika spustila právě jednou“ se počítá **po pravidlech** z
 * `MechanicBinding.ruleIds`: aspoň jedno pravidlo mechaniky musí spustit a
 * žádné víc než jednou. Součet přes celou mechaniku by to neuměl – sběr páté
 * houby spustí pravidlo výběru i práh `onCounterReaches`, tedy dvě různá
 * pravidla po jednom, a to je správně odehraná mechanika, ne dvojité spuštění.
 */
function firedFailures(compiled: CompiledGame, mechanics: readonly string[], fired: readonly string[]): string[] {
  const failures: string[] = [];
  for (const mechanicId of mechanics) {
    const binding = compiled.mechanics.find((candidate) => candidate.mechanicId === mechanicId);
    if (binding === undefined) {
      failures.push(`firedMechanics: the compilation has no mechanic ${mechanicId}`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const ruleId of fired) {
      if (binding.ruleIds.includes(ruleId)) counts.set(ruleId, (counts.get(ruleId) ?? 0) + 1);
    }
    if (counts.size === 0) failures.push(`firedMechanics: ${mechanicId} never fired`);
    for (const [ruleId, times] of counts) {
      if (times !== 1) failures.push(`firedMechanics: rule ${ruleId} fired ${times}x, expected once`);
    }
  }
  return failures;
}

/** Jeden keypoint: vlastní `createRuntime`, vlastní vstřik, vlastní okno. */
export function runKeypoint(compiled: CompiledGame, assertion: VerificationAssertion): KeypointEvidence {
  const injected = injectSetup(compiled, assertion.setup);
  const inputs = scheduleActions(compiled, injected, assertion.actions);
  const settle = assertion.ticks ?? DEFAULT_KEYPOINT_TICKS;
  const hashBefore = hashHex(injected.runtime.state);
  const fired = play(injected.runtime, inputs, settle);
  const hashAfter = hashHex(injected.runtime.state);

  const failures = [...injected.failures, ...assertFailures(compiled, injected.runtime, assertion.assert, fired)];
  if (assertion.assert.replayEqual === true) {
    const again = injectSetup(compiled, assertion.setup);
    play(again.runtime, scheduleActions(compiled, again, assertion.actions), settle);
    if (hashHex(again.runtime.state) !== hashAfter) failures.push('replayEqual: the same setup and actions ended in a different state');
  }

  return {
    assertionId: assertion.id,
    mechanicId: assertion.mechanic ?? null,
    passed: failures.length === 0,
    hashBefore,
    hashAfter,
    ticks: injected.runtime.tick,
    failures,
  };
}
