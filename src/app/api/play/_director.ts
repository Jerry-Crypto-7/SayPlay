/**
 * Šev režiséra pro obálku (P23-D T1): `direct()` z `src/play/director`.
 *
 * Bez objednané a nakonfigurované živé větve se model nevolá vůbec a hra je
 * návrh ze slov (`source: 'draft'`, `fallbackReason: 'MODEL_UNAVAILABLE'`).
 * S ní jde každé volání přes **týž procesní strop utrácení** jako WORLDSTREAM
 * (`processSpendCap()` na `globalThis`): rezervace nejhoršího případu před
 * voláním, vyrovnání po něm. Odmítnutý strop je pro režiséra výpadek modelu,
 * takže hráč dostane návrh, ne chybu.
 *
 * Objednávka se čte jako v `/api/generate` (`WORLDSMITH_BRANCH === 'live'`)
 * a vypínač `upstream` ji ruší – klíč zděděný z jiného projektu tak placenou
 * cestu nezapne.
 *
 * Podtržítko v názvu: Next.js soubor nebere jako route.
 */

import { direct, directorCacheFromEnv, type DirectedGame } from '@/play/director';
import { killState } from '@/server/kill-switch';
import type { GenerationBranch } from '@/server/pipeline';
import { costUsd, processSpendCap } from '@/server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';

import { acquireSlot, releaseSlot } from '../worldstream/sessions/route';

export type Director = (sentence: string) => Promise<DirectedGame>;

/** Živá větev obalená stropem; `null` = model se volat nebude. */
async function cappedBranch(env: Record<string, string | undefined>): Promise<GenerationBranch | null> {
  if (env.WORLDSMITH_BRANCH !== 'live') return null;
  if ((await killState(env)).upstream) return null;
  const config = upstreamConfigFromEnv(env);
  if (config === null) return null;
  const branch = upstreamBranch(config);
  const cap = processSpendCap();
  return {
    id: branch.id,
    pricing: branch.pricing,
    worstCaseUsd: (call) => branch.worstCaseUsd(call),
    async generate(call) {
      const reservation = await cap.reserve(branch.worstCaseUsd(call));
      if (!reservation.ok) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'spend cap refused the call', usage: null };
      try {
        const outcome = await branch.generate(call);
        await reservation.settle(outcome.usage === null ? 'unknown' : costUsd(outcome.usage, branch.pricing));
        return outcome;
      } catch (thrown) {
        await reservation.settle('unknown');
        throw thrown;
      }
    },
  };
}

/** Větev bez modelu: `direct()` z ní udělá návrh ze slov, nikam se nevolá. */
const NO_MODEL: GenerationBranch = upstreamBranch(null);

/**
 * Placená větev drží po celou režii jeden slot dveří `generate` – týž čítač
 * souběžných placených volání jako `/api/generate` a relace WORLDSTREAM. Bez
 * volného slotu se model nevolá a hra je návrh: jinak by jeden volající se
 * stovkou různých vět vyčerpal strop volání celého dema (nález revize T1).
 */
export function getDirector(): Director {
  return async (sentence) => {
    const cache = directorCacheFromEnv(process.env);
    const branch = await cappedBranch(process.env);
    if (branch === null || !acquireSlot('generate')) return direct(sentence, { branch: NO_MODEL, cache, now: Date.now });
    try {
      return await direct(sentence, { branch, cache, now: Date.now });
    } finally {
      releaseSlot('generate');
    }
  };
}
