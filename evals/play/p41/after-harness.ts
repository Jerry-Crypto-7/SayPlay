import type { IntentTriple } from '@/play/intent/contract';

/** Compose verifies synchronously, so its physics dependency must be ready before any draft. */
export async function prepareDrafting<A extends unknown[], R>(initialize: () => Promise<unknown>, draft: (...args: A) => R) {
  let startupError: string | null = null;
  try { await initialize(); } catch (error) { startupError = String(error); }
  return { startupError, draft: (...args: A): R => {
    if (startupError !== null) throw new Error(`Measurement startup failed: ${startupError}`);
    return draft(...args);
  } };
}

/** No published candidate exists on failure; keep it in the preservation denominator. */
export function failedMeasurement(triples: readonly IntentTriple[]) {
  return { preserved: false, total: triples.length, proved: 0, missing: [...triples], silent: [] as IntentTriple[] };
}
