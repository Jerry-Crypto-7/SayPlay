/**
 * `POST /api/worldstream/sessions/:id/changes/:changeId/commit` — **commit druhé
 * věty** (P15 T22, §21).
 *
 * *„Commitne nezastaralé preview. Zastaralé je `409`, ne best-effort změna."*
 *
 * ## Nový řetěz to není a nemá být
 *
 * Operace jdou **stávající** cestou: `routePatch` rozhodne dráhu z cest,
 * `staleRevision` zavře bránu 409 a `commitRoutedParts` provede commit,
 * kontrolu odkazů, snížení do IR a ověření svědka. Tenhle soubor k tomu
 * přidává jediné, co ten řetěz neví: že za dokumentem stojí **relace se
 * sémantickými objekty**, kterým se má nebo nemá zvednout revize podoby.
 *
 * ## Tři čísla, tři nezávislé závody
 *
 * Preview vzniklo proti `representation`, `sim` a `look` (§9.8 a §13.1.1). Hlídá
 * se každé zvlášť, protože každé může posunout někdo jiný: podobu posune
 * doručení meshe z prohlížeče, `sim` a `look` posune jiný commit. Sdílené číslo
 * by z výměny podoby jednoho objektu udělalo důvod zahodit preview pravidla,
 * které se jí netýká.
 *
 * ## Atomicky z pohledu člověka, i když řetěz atomický není
 *
 * `/api/edit` u smíšeného patche vzhled commitne **okamžitě** a nechá si ho i
 * tehdy, když pravidla neprojdou verifikací (§13.4). Tady to nestačí: porotce
 * odsouhlasil **jednu** změnu popsanou jednou větou, takže její půlka je horší
 * výsledek než žádná změna — vidí svět, o který nežádal, a neví proč. Řetěz se
 * kvůli tomu nemění; mění se, kdy se jeho výsledek **uloží**. `commitRoutedParts`
 * je čistá funkce nad kopií, takže odmítnutá změna neuloží nic a `stored`
 * zůstane bajt po bajtu tam, kde byl.
 *
 * ## Revizi dostane jeden objekt, ne svět
 *
 * `session.revise()` se volá **jen když se změnil tvar** a **jen pro cíl věty**.
 * Změna jen vzhledu ho nevolá vůbec: `look` patch nezvedá `simRevision` ani
 * nepřepočítává `simHash`, takže běžící svět má po commitu tentýž runtime hash
 * a hráč si nechá stav i rozehranou podobu.
 */

import { randomUUID } from 'node:crypto';

import { commitRoutedParts, staleRevision, type CommitOutcome } from '@/app/api/edit/commit';
import type { PartPatch } from '@/ir/revision';
import type { RejectionNote } from '@/model/worldstream-refine';
import { routePatch, type RoutedPatch } from '@/patch/router';
import { killState } from '@/server/kill-switch';
import { logRateLimited } from '@/server/public-faults';
import {
  callerKey,
  rateLimitCode,
  rateLimitedResponse,
  takeRateSlot,
} from '@/server/rate-limit';
import type { WorldstreamBlueprint } from '@/worldstream/schema';
import { getSession, markRejected, peekChange, takeChange } from '@/worldstream/sessions';

export const runtime = 'nodejs';

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ sessionId: string; changeId: string }> },
): Promise<Response> {
  const { sessionId, changeId } = await context.params;

  // **Commit patří pod týž vypínač jako preview.** „Public refine" z §22.4 je
  // celá druhá věta, ne jen její první polovina: vypnout preview a nechat
  // commitovat by znamenalo, že se svět dál mění — jen z previewů, které stihly
  // vzniknout dřív. Vypínač se čte tady, protože tahle route je druhé rozhodnutí
  // člověka a mezi ním a preview může uběhnout libovolně dlouhá doba.
  if (killState(process.env).refine)
    return fail(503, 'REFINE_DISABLED', 'changing worlds is switched off right now');

  /**
   * **Strop na frekvenci, hned za vypínačem** — nález nezávislé revize
   * 4. 9. 2026 (`T28-editrate`, 2. kolo). Tyhle dveře byly jediné veřejné
   * `POST`, které v `RateLimitedDoor` nebyly, a přitom vedou na `routePatch`
   * a `commitRoutedParts`, tedy na tutéž synchronní práci, kterou `/api/edit`
   * naměřilo na medián 15,3 ms.
   *
   * ⚠ **Nestačí, že preview stojí placené volání.** Zamítnutý commit preview
   * **nespotřebuje** — `takeChange` je až za všemi branami, schválně
   * (`T22-takeearly`) — takže jedno zaplacené preview koupí neomezené
   * opakování téhle práce. Brána je proto tady, ne u placení.
   */
  const requestId = randomUUID();
  const slot = takeRateSlot('commit', callerKey(request));
  if (!slot.allowed) {
    logRateLimited(
      'worldstream/commit',
      requestId,
      rateLimitCode(slot),
      `${String(slot.count)} in window`,
    );
    return rateLimitedResponse(requestId, slot);
  }

  const stored = getSession(sessionId);
  if (stored === null)
    return fail(404, 'UNKNOWN_SESSION', 'no session with that id is being served by this process');

  const blueprint = stored.blueprint;
  if (blueprint === null)
    return fail(409, 'WORLD_NOT_READY', 'this session has no world yet, so there is nothing to change');

  // Uzavřená relace už revizi nezvedne (`session.revise()` vrací `null`), takže
  // by se blueprint změnil a podoba objektu ne — přesně ta půlka, kterou tenhle
  // soubor jinde zakazuje. Brána je tady, ne uvnitř.
  const phase = stored.session.phase;
  if (phase === 'complete' || phase === 'failed')
    return fail(409, 'SESSION_CLOSED', 'this session is closed and no longer takes changes');

  // **Jen se na preview podíváme.** Spotřebuje se až tam, kde se svět opravdu
  // mění (`takeChange` níž) — „jedno preview je jeden pokus" platí pro commit,
  // který prošel, ne pro ten, který zamítla brána. Odmítnutý commit revizi
  // nezvedl a do světa nezapsal ani bajt, takže druhý pokus proti zastaralému
  // světu neběží; spálit mu preview by porotce jen donutilo zaplatit druhé
  // volání modelu za tutéž větu (`T22-takeearly`).
  const change = peekChange(stored, changeId);
  if (change === null)
    return fail(404, 'UNKNOWN_CHANGE', 'no preview with that id is waiting on this session');

  const { plan, basedOn } = change;
  const doc = blueprint.world;

  /**
   * **Preview, které už jednou prohrálo, si nesmí vzít okno, které mu otevřel
   * někdo jiný** (`T22-rejectreplay`).
   *
   * Odmítnutí preview nespálí (`T22-takeearly`), takže tentýž `changeId` jde
   * poslat znovu — a to je správně, dokud je svět tam, kde byl: opakuje se týž
   * verdikt nad týmž světem. Jakmile se svět mezitím pohnul, je druhý pokus
   * rozhodnutí o jiném světě, než jaký člověk viděl, a člověk k němu souhlas
   * nedal.
   *
   * **Nedělá to `staleRevision` a nemá.** Ta se ptá každé části zvlášť a jen na
   * ty v `routing.patches` — nezávislost částí je záměr (§13.1.1) a přebíjí
   * tuhle opravu. Zbývalo právě to, co záměr nepokrývá: preview jen nad `sim`
   * postavené nad `look` revizí 3 projde i po `look` 5. Razítko proto soudí
   * **dvojici jako celek**, a jen u preview, které už souhlas jednou vyčerpalo.
   *
   * ⚠ **Odpověď veze původní verdikt s sebou** — nález nezávislé revize
   * 4. 9. 2026. Bez něj tahle brána spolkne jedinou větu, která člověku říká,
   * proč jeho věta neprošla. U vady, která na světě nezávisí (vada tvaru
   * patche), se ta věta navíc nemá jak vrátit: verdikt se nemůže změnit, takže
   * po prvním cizím commitu by byl důvod nečitelný napořád.
   */
  const rejectedAt = change.rejectedAt;
  if (
    rejectedAt !== undefined &&
    (rejectedAt.sim !== doc.simRevision || rejectedAt.look !== doc.lookRevision)
  )
    return Response.json(
      {
        error: {
          code: 'PREVIEW_REJECTED',
          message: `this preview was already rejected when the world was at sim ${String(rejectedAt.sim)} / look ${String(rejectedAt.look)}, and the world has since moved to sim ${String(doc.simRevision)} / look ${String(doc.lookRevision)} — ask for a new preview`,
          field: 'changeId',
          rejections: rejectedAt.rejections,
        },
      },
      { status: 409 },
    );

  const representation = stored.session.revisionOf(plan.stableId);
  if (representation !== basedOn.representation)
    return Response.json(
      {
        error: {
          code: 'STALE_REVISION',
          message: `the preview was built against representation ${basedOn.representation} of ${plan.stableId}, which is now at ${representation ?? 'no revision'}`,
          field: 'basedOn/representation',
        },
      },
      { status: 409 },
    );

  const operations = [...plan.behavior, ...plan.appearance];

  /**
   * Změna jen tvaru dokument nezasáhne, takže se do řetězu vůbec nevstupuje.
   * Prázdná obálka je pro router odmítnutí (a správně — patch bez operací
   * nepojmenuje cestu, ze které by se dala rozhodnout dráha), takže poslat ji
   * tam by z legitimní změny podoby udělalo vadu.
   */
  let committed: CommitOutcome = {
    outcome: 'CERTIFIED',
    applied: [],
    changedLeaves: [],
    after: doc,
    certificate: null,
    rejections: [],
  };

  if (operations.length > 0) {
    const routing = routePatch({ operations }, doc);
    if (routing.verdict === 'REJECTED') return rejected(stored, changeId, plan.stableId, doc, [
      { stage: 'routing', reason: routing.reason, pointer: routing.pointer, detail: `${routing.detail} (expected ${routing.expected})` },
    ]);

    const stale = staleRevision(doc, { sim: basedOn.sim, look: basedOn.look }, routing.patches);
    if (stale !== null)
      return Response.json(
        {
          error: {
            code: 'STALE_REVISION',
            message: `the preview was built against ${stale.part}Revision ${stale.claimed}, the world is at ${stale.current}`,
            field: `basedOn/${stale.part}`,
          },
        },
        { status: 409 },
      );

    committed = commitRoutedParts(
      doc,
      routing.patches.map(
        (routed: RoutedPatch): PartPatch => ({
          part: routed.part,
          baseRevision: routed.part === 'sim' ? basedOn.sim : basedOn.look,
          operations: routed.operations,
        }),
      ),
    );

    // Jediné místo, kde se rozhoduje o atomičnosti: dokud tohle neprojde, do
    // `stored` se nezapsalo nic a zapsat se nemá.
    if (committed.outcome !== 'CERTIFIED')
      return rejected(stored, changeId, plan.stableId, doc, committed.rejections);
  }

  const next = nextBlueprint(blueprint, committed.after, plan.shape);
  if (typeof next === 'string')
    return rejected(stored, changeId, plan.stableId, doc, [
      { stage: 'apply', reason: 'BLUEPRINT_INVALID', pointer: '/shapes', detail: next },
    ]);

  // **Odtud dolů se svět mění, takže teď a jen teď se preview spotřebuje.**
  // Od `peekChange` výš sem nevede jediný `await`, takže mezi kontrolou a
  // vyzvednutím se nemá kdy vklínit druhý požadavek — dvojí commit téhož
  // preview pořád není možný.
  takeChange(stored, changeId);
  stored.blueprint = next;
  const revision = plan.shape === null ? null : stored.session.revise(plan.stableId);

  stored.session.events.append(
    'patch.committed',
    {
      changeId,
      stableId: plan.stableId,
      applied: committed.applied,
      changedLeaves: committed.changedLeaves,
      revisions: revisionsOf(doc, next.world),
      representation: revision,
    },
    plan.stableId,
  );

  return Response.json({
    changeId,
    outcome: 'COMMITTED',
    stableId: plan.stableId,
    summary: plan.summary,
    applied: committed.applied,
    changedLeaves: committed.changedLeaves,
    revisions: revisionsOf(doc, next.world),
    /** Nová revize podoby, nebo `null`, když se tvar neměnil a mesh zůstává. */
    representation: revision,
    certificate: committed.certificate,
  });
}

/**
 * Odmítnutá změna: razítko na preview, rámec do proudu, 200 s verdiktem, ve
 * světě ani bajt.
 *
 * **Razítko nese i ten verdikt**, ne jen revize. Preview se odmítnutím
 * nespotřebuje, takže se na tenhle text ještě někdo zeptá — a brána nad
 * pohnutým světem ho pak umí zopakovat místo toho, aby ho spolkla.
 *
 * Razítko nese revize světa, nad kterým se prohrálo — `doc`, ne
 * `committed.after`. U smíšeného patche vrací `commitRoutedParts` dokument
 * s commitnutou půlkou vzhledu, jenže ten se při odmítnutí nikam neuloží, takže
 * uložený svět zůstal na `doc`. Orazítkovat preview výsledkem, který se zahodil,
 * by z příštího pokusu udělalo 409 nad světem, který se ve skutečnosti nehnul.
 */
function rejected(
  stored: NonNullable<ReturnType<typeof getSession>>,
  changeId: string,
  stableId: string,
  doc: WorldstreamBlueprint['world'],
  rejections: readonly RejectionNote[],
): Response {
  markRejected(stored, changeId, { sim: doc.simRevision, look: doc.lookRevision, rejections });
  stored.session.events.append('patch.rejected', { stableId, rejections }, stableId);
  return Response.json({ outcome: 'REJECTED', stableId, rejections });
}

/**
 * Blueprint po commitu, nebo věta o tom, proč se nedá složit.
 *
 * Nová podoba se vymění **na místě**, tedy pod týmž `shapeId` i `stableId`, na
 * které ukazuje `objects[].source`. Ten oboustranný odkaz se proto nemá jak
 * pohnout a znovu se nekontroluje — `readRefineEmission` obě jména připnula
 * k cíli věty a schéma tvaru už proběhlo tam.
 *
 * Co se kontrolovat **musí**, je počet výměn. Tvar, který v blueprintu není, by
 * `map` tiše přešel: commit by prošel, revize podoby by se zvedla a prohlížeč
 * by přemeshoval **starou** podobu — změna, kterou porotce odsouhlasil a která
 * se nikdy nestala.
 */
function nextBlueprint(
  blueprint: WorldstreamBlueprint,
  world: WorldstreamBlueprint['world'],
  shape: WorldstreamBlueprint['shapes'][number] | null,
): WorldstreamBlueprint | string {
  if (shape === null) return { ...blueprint, world };

  let replaced = 0;
  const shapes = blueprint.shapes.map((program) => {
    if (program.shapeId !== shape.shapeId) return program;
    replaced += 1;
    return shape;
  });

  return replaced === 1
    ? { ...blueprint, world, shapes }
    : `the world has ${replaced} hero shapes named ${shape.shapeId}, so the new form has nowhere to land`;
}

function revisionsOf(
  before: WorldstreamBlueprint['world'],
  after: WorldstreamBlueprint['world'],
): object {
  return {
    sim: { before: before.simRevision, after: after.simRevision },
    look: { before: before.lookRevision, after: after.lookRevision },
  };
}
