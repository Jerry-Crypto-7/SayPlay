/** Shared provider and spend reservation for world and source proposals. */
import type { UpstreamRequest } from '../model/prompt';
import type { BlueprintEmitter } from '../model/worldstream-repair';
import { killState } from './kill-switch';
import { costUsd, processSpendCap, SpendRefusalError } from './spend-cap';
import { upstreamBranch, upstreamConfigFromEnv } from './upstream';

export const WORLDSTREAM_SPEND_CAP = processSpendCap();

/**
 * Emitor, který mluví s poskytovatelem a **platí za to**.
 *
 * Vypadá jako `liveEmitter()` z měřidla T14 a je to jiná věc: ten archivuje
 * a scrubuje, protože jeho výstup jde do commitnutého souboru. Tenhle nesmí
 * ven pustit **nic** — text výjimky nese adresu koncového bodu a `fetch` ji
 * píše do hlášek celou, takže ho čte jen `runGeneration`, který ho přeloží na
 * veřejnou větu a detail pošle do logu operátora.
 *
 * `null` znamená „cloudová větev není nakonfigurovaná". Relace se i tak
 * založí a skončí `session.failed`: 503 rovnou by porotci vzalo proud, ve
 * kterém je ta příčina vidět, a `RULES.md` §3.3 mu dává právo zkoušet vlastní
 * věty i tehdy, když je nasazení bez klíče.
 */
export async function cloudEmitter(): Promise<BlueprintEmitter | null> {
  // **Kill switch `upstream` vypadá odsud stejně jako chybějící klíč**, a je to
  // schválně: obě cesty končí `session.failed` s veřejnou větou „the model could
  // not be reached", takže porotci zůstane proud, ve kterém je ta příčina vidět.
  // Vypnutý model není 503 — 503 by mu vzalo i to.
  if ((await killState(process.env)).upstream) return null;

  const config = upstreamConfigFromEnv(process.env);
  if (config === null) return null;

  const branch = upstreamBranch(config);
  const cap = WORLDSTREAM_SPEND_CAP;

  return async (request: UpstreamRequest): Promise<unknown> => {
    const call = { prompt: request.user, request };
    const reservation = await cap.reserve(branch.worstCaseUsd(call));
    // **Vlastní třída, ne holý `Error`** (P15 `T29-readinessledger`). Volající
    // chytá jedinou výjimku a musí z ní poznat, jestli se k poskytovateli
    // vůbec někdo připojoval — odmítnutý strop se do té chvíle hlásil jako
    // „the model could not be reached". Text zprávy zůstává, mění se typ.
    if (!reservation.ok) throw new SpendRefusalError(reservation);

    let outcome;
    try {
      outcome = await branch.generate(call);
    } catch (thrown) {
      // Rezervaci vyrovnat **před** rethrow, jinak visí do restartu procesu a
      // strop se sám utáhne — táž oprava jako v `runPipeline`.
      await reservation.settle('unknown');
      throw thrown;
    }

    await reservation.settle(outcome.usage === null ? 'unknown' : costUsd(outcome.usage, branch.pricing));
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.detail}`);
    return outcome.body;
  };
}
