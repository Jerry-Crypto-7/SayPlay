export type EvalLedger =
  | { readonly mode: 'paid'; readonly prefix: string; readonly capUsd: number }
  | { readonly mode: 'fast-only'; readonly reason: string };

export function evalLedger(env: Record<string, string | undefined>): EvalLedger;
