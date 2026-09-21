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
import { VersionStoreUnavailable, versionStoreFromEnv } from '@/play/version';
import { killState } from '@/server/kill-switch';
import type { GenerationBranch } from '@/server/pipeline';
import { costUsd, processSpendCap } from '@/server/spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';

import { acquireSlot, releaseSlot } from '../worldstream/sessions/route';

export type Director = (sentence: string) => Promise<DirectedGame>;

/**
 * Kolik smí trvat celá režie (R7). Routy PLAY mají `maxDuration = 300` s;
 * když platforma funkci zabije uprostřed volání, `settle()` neproběhne
 * a rezervace stropu visí do expirace knihy. Rozpočet běží od příchodu
 * požadavku, ne od začátku režie, a timeout každého volání se zkrátí na čas,
 * který z něj zbývá – nasazený timeout (285 s kvůli codex-shimu) je delší než
 * celý rozpočet, takže odmítnutí místo zkrácení by nepustilo volání nikdy
 * (revize R7). Zbylých 30 s patří kompilaci a zápisu. Kompilace čtyř semínek
 * je naměřeně pod 2 s (P23-D T3: medián 25 ms, max 445 ms na semínko), vlastní
 * strop souběhu nepotřebuje.
 */
export const DIRECTOR_BUDGET_MS = 270_000;

/** Pod tohle volání neodejde: odpověď astry trvá v mediánu desítky sekund. */
export const MIN_CALL_MS = 30_000;

/**
 * Kolik placených volání režiséra smí jeden volající za den (R8). Věta stojí
 * 1–3 volání, takže výchozích 40 je 13–40 vět; bez meze by jeden volající
 * různými větami vyčerpal sdílený `DEFAULT_CALL_CAP` celého dema.
 */
export const DEFAULT_DIRECTOR_CALLS_PER_CALLER = 40;

function callsPerCaller(env: Record<string, string | undefined>): number {
  const value = Number(env.PLAY_DIRECTOR_CALLS_PER_CALLER);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_DIRECTOR_CALLS_PER_CALLER;
}

/** Počítadlo volajícího; nedostupné úložiště volání nepustí. */
async function callerAllows(caller: string, env: Record<string, string | undefined>): Promise<boolean> {
  try {
    return await versionStoreFromEnv(env).takeDirectorCall(caller, callsPerCaller(env));
  } catch (thrown) {
    if (thrown instanceof VersionStoreUnavailable) return false;
    throw thrown;
  }
}

/** Živá větev obalená stropem; `null` = model se volat nebude. */
async function cappedBranch(env: Record<string, string | undefined>, deadline: number, caller: string): Promise<GenerationBranch | null> {
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
      const left = deadline - Date.now();
      if (left < MIN_CALL_MS) {
        console.warn(`[play] director call skipped: ${String(Math.round(left / 1000))} s left of the route budget`);
        return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'too little time left in the route', usage: null };
      }
      if (!(await callerAllows(caller, env))) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: "the caller's daily director calls are used up", usage: null };
      const bounded = left < config.timeoutMs ? upstreamBranch({ ...config, timeoutMs: left }) : branch;
      const reservation = await cap.reserve(branch.worstCaseUsd(call));
      if (!reservation.ok) return { ok: false, reason: 'UPSTREAM_REJECTED', detail: 'spend cap refused the call', usage: null };
      try {
        const outcome = await bounded.generate(call);
        await reservation.settle(outcome.usage === null ? 'unknown' : costUsd(outcome.usage, branch.pricing));
        return outcome;
      } catch (thrown) {
        await reservation.settle('unknown');
        throw thrown;
      }
    },
  };
}

/**
 * Větev bez modelu: `direct()` z ní udělá návrh ze slov, nikam se nevolá.
 * Má totéž `id` (`'live'`) jako živá, takže bez slotu se cache čte pod týmž
 * klíčem a táž věta dá tutéž hru bez ohledu na zátěž (R8).
 */
const NO_MODEL: GenerationBranch = upstreamBranch(null);

/**
 * Placená větev drží po celou režii jeden slot **vlastních dveří `play`** – pod
 * týmž celkovým stropem souběžných placených volání jako `/api/generate` a
 * relace WORLDSTREAM, ale s vlastním čítačem, aby visící režie nezavřela
 * `/api/generate` (druhé kolo revize T1). Bez volného slotu se model nevolá a
 * hra je návrh: jinak by jeden volající se stovkou různých vět vyčerpal strop
 * volání celého dema (nález revize T1).
 *
 * `startedAt` je příchod požadavku (`Date.now()`), jehož `maxDuration` režii drží.
 */
export function getDirector(startedAt: number, caller: string): Director {
  return async (sentence) => {
    const deadline = startedAt + DIRECTOR_BUDGET_MS;
    const cache = directorCacheFromEnv(process.env);
    const branch = await cappedBranch(process.env, deadline, caller);
    if (branch === null || !acquireSlot('play')) return direct(sentence, { branch: NO_MODEL, cache, now: Date.now });
    try {
      return await direct(sentence, { branch, cache, now: Date.now });
    } finally {
      releaseSlot('play');
    }
  };
}
