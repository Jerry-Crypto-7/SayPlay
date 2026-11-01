/**
 * P68I T7: měřicí kniha útraty. Placený měřicí běh (živá čtečka, režisér přes AI verzi) smí startovat jen do
 * vlastní knihy: `WORLDSMITH_SPEND_STORE_PREFIX` končí `-eval` a není produkční předponou (`PLAY_PROD_SPEND_PREFIX`,
 * bez ní výchozí `worldsmith:spend` ze `src/server/spend-store.ts`), a `PLAY_EVAL_SPEND_CAP_USD` je kladná částka.
 * Jinak běh měří jen rychlou hru a důvod zapíše – měření nesmí sníst peníze veřejného provozu a poroty.
 *
 * Volají ji `evals/play/p61/shots.mjs serve` a `evals/play/p58e/live.mjs` před placeným krokem.
 */

/** Výchozí základ knihy, když produkce předponu nenastaví (`BASE_PREFIX` ve `src/server/spend-store.ts`). */
const DEFAULT_PROD_PREFIX = 'worldsmith:spend';

/** @returns {{ mode: 'paid', prefix: string, capUsd: number } | { mode: 'fast-only', reason: string }} */
export function evalLedger(env) {
  const prefix = env.WORLDSMITH_SPEND_STORE_PREFIX?.trim() ?? '';
  const prod = env.PLAY_PROD_SPEND_PREFIX?.trim() || DEFAULT_PROD_PREFIX;
  if (!prefix.endsWith('-eval')) return { mode: 'fast-only', reason: 'WORLDSMITH_SPEND_STORE_PREFIX must name a separate ledger ending in -eval' };
  if (prefix === prod) return { mode: 'fast-only', reason: 'WORLDSMITH_SPEND_STORE_PREFIX is the production ledger (PLAY_PROD_SPEND_PREFIX)' };
  const cap = env.PLAY_EVAL_SPEND_CAP_USD?.trim() ?? '';
  const capUsd = /^\d+(\.\d+)?$/.test(cap) ? Number(cap) : 0;
  if (capUsd <= 0) return { mode: 'fast-only', reason: 'PLAY_EVAL_SPEND_CAP_USD must be a positive dollar amount' };
  return { mode: 'paid', prefix, capUsd };
}
