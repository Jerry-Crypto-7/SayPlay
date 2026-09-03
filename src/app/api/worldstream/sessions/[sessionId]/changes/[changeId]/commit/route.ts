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

import { commitRoutedParts, staleRevision, type CommitOutcome } from '@/app/api/edit/commit';
import type { PartPatch } from '@/ir/revision';
import { routePatch, type RoutedPatch } from '@/patch/router';
import { killState } from '@/server/kill-switch';
import type { WorldstreamBlueprint } from '@/worldstream/schema';
import { getSession, takeChange } from '@/worldstream/sessions';

export const runtime = 'nodejs';

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export async function POST(
  _request: Request,
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

  // Vyzvednutím se preview spotřebuje. Jedno preview je jeden pokus: druhý by
  // běžel proti revizi, kterou zvedl ten první, tedy proti světu, který porotce
  // v preview neviděl.
  const change = takeChange(stored, changeId);
  if (change === null)
    return fail(404, 'UNKNOWN_CHANGE', 'no preview with that id is waiting on this session');

  const { plan, basedOn } = change;
  const doc = blueprint.world;

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
    if (routing.verdict === 'REJECTED') return rejected(stored, plan.stableId, [
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
    if (committed.outcome !== 'CERTIFIED') return rejected(stored, plan.stableId, committed.rejections);
  }

  const next = nextBlueprint(blueprint, committed.after, plan.shape);
  if (typeof next === 'string')
    return rejected(stored, plan.stableId, [
      { stage: 'apply', reason: 'BLUEPRINT_INVALID', pointer: '/shapes', detail: next },
    ]);

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

interface Rejection {
  readonly stage: string;
  readonly reason: string;
  readonly pointer: string;
  readonly detail: string;
}

/** Odmítnutá změna: rámec do proudu, 200 s verdiktem, ve světě ani bajt. */
function rejected(
  stored: NonNullable<ReturnType<typeof getSession>>,
  stableId: string,
  rejections: readonly Rejection[],
): Response {
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
