/**
 * Dvojník `GenerationBranch` pro testy režiséra (P23-B T7). `mockBranch()` ze
 * `src/server/mock` odpovídá jen na zmrazené prompty a tady by vrátil
 * `NO_SOURCE`; tenhle odpovídá podle scénáře – po jednom, v pořadí volání –
 * a po vyčerpání hlásí `UPSTREAM_UNAVAILABLE`, aby test poznal volání navíc.
 * Každé volání si zapíše do `calls`.
 */

import type { GenerationBranch, GenerationCall, GenerationFailureReason, GenerationOutcome } from '@/server/pipeline';

export type ScriptedOutcome = GenerationOutcome | ((call: GenerationCall) => GenerationOutcome);

export interface FakeBranch extends GenerationBranch {
  readonly calls: GenerationCall[];
}

/** Úspěšná odpověď s tělem, které by `parseAnswerText` vrátil. */
export function answered(body: unknown): GenerationOutcome {
  return { ok: true, body, usage: null, provenance: { branch: 'fake' } };
}

export function failed(reason: GenerationFailureReason, detail = 'scripted'): GenerationOutcome {
  return { ok: false, reason, detail, usage: null };
}

export function fakeBranch(script: readonly ScriptedOutcome[]): FakeBranch {
  const calls: GenerationCall[] = [];
  const queue = [...script];
  return {
    id: 'fake',
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    calls,
    worstCaseUsd: () => 0,
    generate(call) {
      calls.push(call);
      const next = queue.shift();
      if (next === undefined) return Promise.resolve(failed('UPSTREAM_UNAVAILABLE', 'script exhausted'));
      return Promise.resolve(typeof next === 'function' ? next(call) : next);
    },
  };
}
