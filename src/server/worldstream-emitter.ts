import { observePhaseAsync } from '../model/phase-observer';
import { serverPhaseObserver } from './worldstream-metrics';
/** Shared provider and spend reservation for world and source proposals. */
import type { UpstreamRequest } from '../model/prompt';
import type { BlueprintEmitter } from '../model/worldstream-repair';
import { answerArchive } from './answer-archive';
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
export async function cloudEmitter(sessionId?: string): Promise<BlueprintEmitter | null> {
  // **Kill switch `upstream` vypadá odsud stejně jako chybějící klíč**, a je to
  // schválně: obě cesty končí `session.failed` s veřejnou větou „the model could
  // not be reached", takže porotci zůstane proud, ve kterém je ta příčina vidět.
  // Vypnutý model není 503 — 503 by mu vzalo i to.
  if ((await killState(process.env)).upstream) return null;

  const config = upstreamConfigFromEnv(process.env);
  if (config === null) return null;

  const branch = upstreamBranch(config);
  const cap = WORLDSTREAM_SPEND_CAP;
  // **Archiv patří sem, protože klíč a adresu drží jedině tahle vrstva.**
  // Stavba světa staví emitor dřív, než relace dostane své `sessionId`
  // (`sessions/route.ts:448` proti `:540`), takže si archiv razí vlastní id.
  // Druhá věta (`changes/route.ts`) id relace zná a předá ho — její volání
  // pak pokračují v číslování téže relace.
  const archive = answerArchive(process.env, config, sessionId);
  let archiveFailed = false;

  return async (request: UpstreamRequest): Promise<unknown> => {
    const call = { prompt: request.user, request };
    const reservation = await observePhaseAsync(serverPhaseObserver, 'spend-reservation', () => cap.reserve(branch.worstCaseUsd(call)));
    // **Vlastní třída, ne holý `Error`** (P15 `T29-readinessledger`). Volající
    // chytá jedinou výjimku a musí z ní poznat, jestli se k poskytovateli
    // vůbec někdo připojoval — odmítnutý strop se do té chvíle hlásil jako
    // „the model could not be reached". Text zprávy zůstává, mění se typ.
    if (!reservation.ok) throw new SpendRefusalError(reservation);

    let outcome;
    try {
      outcome = await observePhaseAsync(serverPhaseObserver, 'provider-transport-and-response', () => branch.generate(call));
    } catch (thrown) {
      // Rezervaci vyrovnat **před** rethrow, jinak visí do restartu procesu a
      // strop se sám utáhne — táž oprava jako v `runPipeline`.
      await reservation.settle('unknown');
      throw thrown;
    }

    await reservation.settle(outcome.usage === null ? 'unknown' : costUsd(outcome.usage, branch.pricing));

    // **Archivuje se i odmítnutá odpověď.** Otázka, kvůli které archiv vznikl
    // („kde se to akvárium ztratilo"), se u věty, kterou model odmítl napsat,
    // odpovídá právě tím odmítnutím. **Zápis nesmí nikdy zabít větu** — svět
    // pro porotce je to, o co tu jde, archiv je poznámka pro autora.
    if (archive !== null) {
      try {
        await archive.write(request, outcome.ok ? outcome.body : { error: outcome.reason, detail: outcome.detail });
      } catch (thrown) {
        // **Svět se kvůli archivu nezruší nikdy** — porotci jde o svět, archiv
        // je poznámka pro autora. Úplně tiše to ale být nesmí (nález nezávislé
        // revize): deset zaplacených volání a nula souborů vypadá přesně jako
        // běh, který se nearchivoval vůbec, a měřicí běh P19 na těch souborech
        // stojí. Hlásí se **jednou za emitor**, ne na každé volání — deset
        // stejných řádků je tentýž šum jako ticho.
        if (!archiveFailed) {
          archiveFailed = true;
          console.warn(`[worldstream] the answer archive could not be written: ${String(thrown)}`);
        }
      }
    }

    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.detail}`);
    return outcome.body;
  };
}
