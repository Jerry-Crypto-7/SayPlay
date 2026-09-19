import {withSessionStorageResponse} from '@/server/session-persistence';
import {assertSessionStorageReady} from '@/worldstream/sessions';
import {ownerIdentityRejection} from '@/server/owner-identity';
import { observePhase, observePhaseAsync } from '@/model/phase-observer';
import { APPEARANCE_UNSUPPORTED, hasUnsupportedAppearance, hasUnsupportedMotion, MOTION_UNSUPPORTED } from '@/server/worldstream-capabilities';
import { withServerMetrics, serverPhaseObserver } from '@/server/worldstream-metrics';
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
import { takenIdentities, type Addition, type RejectionNote } from '@/model/worldstream-refine';
import { routePatch, type RoutedPatch } from '@/patch/router';
import { additionScopeIssue } from '@/patch/scope';
import { killState } from '@/server/kill-switch';
import { logRateLimited } from '@/server/public-faults';
import {
  callerKey,
  trustedCallerKey,
  rateLimitCode,
  rateLimitedResponse,
  takeRateSlot,
} from '@/server/rate-limit';
import { findBlueprintReferenceIssues } from '@/worldstream/references';
import { blueprintSchema, type WorldstreamBlueprint } from '@/worldstream/schema';
import { getSession, markRejected, peekChange, takeChange } from '@/worldstream/sessions';
import { readBody, bodyRefusalResponse } from '@/http/body';
import { compareCommitCandidate, comparisonCommitSchema, type ComparisonCommit, type BranchComparison } from '@/worldstream/accepted-branch';
import {prepareComparisonCommit} from '@/worldstream/comparison-commit';

export const runtime = 'nodejs';

function fail(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function handleDurablePOST(
  request: Request,
  context: { params: Promise<{ sessionId: string; changeId: string }> },
): Promise<Response> {
  const { sessionId, changeId } = await context.params;
  const requestId = randomUUID();
  return withServerMetrics(requestId, 'edit', async () => {

  // **Commit patří pod týž vypínač jako preview.** „Public refine" z §22.4 je
  // celá druhá věta, ne jen její první polovina: vypnout preview a nechat
  // commitovat by znamenalo, že se svět dál mění — jen z previewů, které stihly
  // vzniknout dřív. Vypínač se čte tady, protože tahle route je druhé rozhodnutí
  // člověka a mezi ním a preview může uběhnout libovolně dlouhá doba.
  if ((await observePhaseAsync(serverPhaseObserver, 'request-kill-switch', () => killState(process.env))).refine)
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
  const identityRejection=ownerIdentityRejection(request);
  if(identityRejection)return identityRejection;
  const slot = takeRateSlot('commit', trustedCallerKey(request) ?? callerKey(request));
  if (!slot.allowed) {
    logRateLimited(
      'worldstream/commit',
      requestId,
      rateLimitCode(slot),
      `${String(slot.count)} in window`,
    );
    return rateLimitedResponse(requestId, slot);
  }

  // Read before resolving mutable session state: no await is permitted between
  // the revision check, comparison gate and the single accepted snapshot write.
  let comparisonRequest: ComparisonCommit | null = null;
  if (request.body !== null) {
    const raw = await readBody(request);
    if (!raw.ok) return bodyRefusalResponse(requestId, raw);
    // Next may expose an empty stream for a bodyless POST. It is the same
    // legacy shape-only commit as Request.body === null, not malformed JSON.
    if (raw.text.length > 0) {
      let body: unknown;
      try { body = JSON.parse(raw.text); } catch { return fail(400, 'INVALID_COMPARISON', 'Expected a comparison request.'); }
      const parsed = comparisonCommitSchema.safeParse(body);
      if (!parsed.success) return fail(400, 'INVALID_COMPARISON', 'Expected bounded comparison ticks and visitor inputs.');
      comparisonRequest = parsed.data;
    }
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
  // Stored/authored previews must pass the same capability gate as new ones.
  // Reject the entire mixed change before routing, revision checks or writes.
  if (hasUnsupportedAppearance(plan))
    return fail(422, 'APPEARANCE_UNSUPPORTED', APPEARANCE_UNSUPPORTED);
  if (hasUnsupportedMotion(plan, blueprint.world))
    return fail(422, 'MOTION_UNSUPPORTED', MOTION_UNSUPPORTED);
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
   *
   * ⚠ **Čítače jsou tři, ne dva** — druhé kolo téže revize. Commit preview,
   * které mění jen tvar, nenese jedinou operaci, takže `sim` i `look` stojí
   * a hne se jen revize podoby; dokud ji tahle brána nečetla, takový retry
   * propadl o pár řádků níž na `STALE_REVISION`, které verdikt nenese.
   *
   * ⚠ **Rovnost revizí znamená „týž svět" jen dokud revize rostou**
   * (`T22-rewindrevision`). Porovnání přes `!==` je správně proto, že do
   * `stored.blueprint` píšou dvě místa a obě jen dopředu; přetáčení času
   * (`T24`) je celé v prohlížeči a serverové dveře nedostalo. Ten předpoklad
   * hlídá `changes.test.ts` nad grafem importů, ne tenhle odstavec. **Až
   * přetočení dveře dostane, nestačí vyměnit `!==` za `<`** — návrat ze `sim` 5
   * na `sim` 3 dorovná razítko a obě podoby brány otevře stejně. Zbývá pak
   * jediná cesta: zahodit razítka při přetočení celá.
   */
  const representation = stored.session.revisionOf(plan.stableId);
  const rejectedAt = change.rejectedAt;
  if (
    rejectedAt !== undefined &&
    (rejectedAt.sim !== doc.simRevision ||
      rejectedAt.look !== doc.lookRevision ||
      rejectedAt.representation !== (representation ?? 0))
  )
    return Response.json(
      {
        error: {
          code: 'PREVIEW_REJECTED',
          message: `this preview was already rejected when the world was at sim ${String(rejectedAt.sim)} / look ${String(rejectedAt.look)} / representation ${String(rejectedAt.representation)}, and the world has since moved to sim ${String(doc.simRevision)} / look ${String(doc.lookRevision)} / representation ${String(representation ?? 0)} — ask for a new preview`,
          field: 'changeId',
          rejections: rejectedAt.rejections,
        },
      },
      { status: 409 },
    );

  // **Nový objekt revizi ještě nemá** (P21 T8): registr ho pozná až po tomhle
  // commitu, takže `revisionOf` vrací `null` a preview ho poctivě založilo na
  // nule. Bez dorovnání by každé přidání padlo na `STALE_REVISION`.
  if ((representation ?? 0) !== basedOn.representation)
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
   * **Jméno nového objektu se soudí znovu, nad světem, jaký je teď** (P21 T8).
   * `readAdditionEmission` ho ověřilo nad světem z doby preview; mezi preview
   * a commitem mohl jiný commit totéž jméno založit, a `registerBlueprint` by
   * pak na `Registered object has changed` shodil dveře pětistovkou místo
   * verdiktu, který se dá přečíst.
   */
  if (plan.addition !== null) {
    const taken = takenIdentities(blueprint);
    const clash = [plan.addition.object.stableId, plan.addition.shape.shapeId].find((name) => taken.has(name));
    if (clash !== undefined)
      return rejected(stored, changeId, plan.stableId, doc, [
        {
          stage: 'apply',
          reason: 'IDENTITY_TAKEN',
          pointer: '/objects',
          detail: `${clash} is already used in this world; a new object needs a name nothing else carries`,
        },
      ]);
  }

  /**
   * Změna jen tvaru dokument nezasáhne, takže se do řetězu vůbec nevstupuje.
   * Prázdná obálka je pro router odmítnutí (a správně — patch bez operací
   * nepojmenuje cestu, ze které by se dala rozhodnout dráha), takže poslat ji
   * tam by z legitimní změny podoby udělalo vadu.
   */
  let comparison: BranchComparison | null = null;
  if(comparisonRequest!==null&&plan.shape!==null)return fail(422,'COMPARISON_REJECTED','A rule comparison cannot also replace geometry.');
  // Přidání se nesrovnává — svět před ním ten objekt neměl, takže není s čím
  // (preview to odmítá stejně; tady se to opakuje, protože tělo commitu píše
  // klient a preview mu v tom nezabrání).
  if (comparisonRequest !== null && plan.addition !== null)
    return fail(422, 'COMPARISON_REJECTED', 'A new object has no earlier future to compare against.');
  let committed: Omit<CommitOutcome,'outcome'>&{outcome:CommitOutcome['outcome']|'COMPARISON_VALIDATED'} = {
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

    const patches = routing.patches.map(
        (routed: RoutedPatch): PartPatch => ({
          part: routed.part,
          baseRevision: routed.part === 'sim' ? basedOn.sim : basedOn.look,
          operations: routed.operations,
        }),
      );
    if(comparisonRequest!==null){
      const prepared=observePhase(serverPhaseObserver,'edit-comparison-validation',()=>prepareComparisonCommit(doc,patches,comparisonRequest));
      if(!prepared.ok)return fail(422,'COMPARISON_REJECTED',`${prepared.reason}: ${prepared.detail}`);
      committed=prepared;comparison=prepared.comparison;
    }else committed=observePhase(serverPhaseObserver,'edit-commit-validation',()=>commitRoutedParts(doc,patches));

    // Jediné místo, kde se rozhoduje o atomičnosti: dokud tohle neprojde, do
    // `stored` se nezapsalo nic a zapsat se nemá.
    if (committed.outcome === 'REJECTED')
      return rejected(stored, changeId, plan.stableId, doc, committed.rejections);

    // **Dosah přidání je diff stavu, ne cesty operací** — táž brána jako na
    // preview (`additionScopeIssue`), znovu, protože tady se svět doopravdy
    // ukládá a preview mohlo vzniknout nad jiným `sim`, než jaký je teď.
    if (plan.addition !== null) {
      const issue = additionScopeIssue(doc.sim, committed.after.sim, plan.stableId);
      if (issue !== null)
        return rejected(stored, changeId, plan.stableId, doc, [
          { stage: 'routing', reason: 'ALLOWED_PATH', pointer: issue.pointer, detail: issue.detail },
        ]);
    }
  }

  const next = observePhase(serverPhaseObserver, 'edit-next-blueprint', () => nextBlueprint(blueprint, committed.after, plan.shape, plan.addition));
  if (!('world' in next))
    return rejected(stored, changeId, plan.stableId, doc, [
      { stage: 'apply', reason: 'BLUEPRINT_INVALID', pointer: next.pointer, detail: next.detail },
    ]);

  if (comparisonRequest !== null && comparison===null) {
    if (plan.shape !== null) return fail(422, 'COMPARISON_REJECTED', 'A rule comparison cannot also replace geometry.');
    const compared = observePhase(serverPhaseObserver, 'edit-branch-comparison',
      () => compareCommitCandidate(doc, next.world, comparisonRequest));
    if (compared.verdict === 'REJECTED')
      return fail(422, 'COMPARISON_REJECTED', `${compared.reason}: ${compared.detail}`);
    comparison = compared.snapshot.comparison;
  }

  // **Odtud dolů se svět mění, takže teď a jen teď se preview spotřebuje.**
  // Od `peekChange` výš sem nevede jediný `await`, takže mezi kontrolou a
  // vyzvednutím se nemá kdy vklínit druhý požadavek — dvojí commit téhož
  // preview pořád není možný.
  //
  // **Registr podob dřív než dokument a než spotřeba preview.** Nový objekt
  // vstupuje do registru na revizi 0 a ve stavu `planned`, přesně jako objekty
  // první věty; ty dosavadní `registerBlueprint` nechá být (reconnect je pro něj
  // totéž). Bez registrace by doručení meshe nového tvaru padlo na
  // `UNKNOWN_OBJECT`. Je to jediný krok tady dole, který umí vyhodit — když se
  // někdy registr rozejde s dokumentem (`Registered object has changed`, dnes
  // bez volajícího, který by to způsobil) — a výjimka **před** zápisem nechá
  // preview i svět tam, kde byly, místo půlky commitu, kterou tenhle soubor
  // nahoře zakazuje (nález revize `bae05c0`).
  if (plan.addition !== null) stored.session.registerBlueprint(next);
  takeChange(stored, changeId);
  stored.blueprint = next;
  stored.comparisonOrigin = comparison === null ? null : { original: structuredClone(doc),
    acceptedSimHash: next.world.simHash, acceptedSimRevision: next.world.simRevision, stableId: plan.stableId };
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
    validation: comparison===null?'classic':'comparison-only',
    // This is the very snapshot stored above, not another independently built world.
    ...(comparison === null ? {} : { acceptedBlueprint: next, comparison }),
  });
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
  markRejected(stored, changeId, {
    sim: doc.simRevision,
    look: doc.lookRevision,
    representation: stored.session.revisionOf(stableId) ?? 0,
    rejections,
  });
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
 *
 * **Přidání** (P21 T8) objekt i tvar **připojí**, nic nevyměňuje — a protože
 * je to jediná cesta, kterou do hotového světa vstupuje nový řádek `objects`,
 * projde výsledek celým schématem i kontrolou odkazů, stejně jako blueprint
 * první věty. Dosavadní objekty jdou dál týmiž referencemi, takže registr je
 * při `registerBlueprint` pozná jako nezměněné.
 *
 * **Kontrola odkazů běží nad každým kandidátem, ne jen nad přidáním** (P22
 * T19, nález nezávislé revize fáze 4). Věta, která odstraní příznak nebo
 * čítač, nechá `lookBindings[].variable` a `binding.signalFlag` ukazovat do
 * prázdna – a protože `lookBindings` ani `objects` nejsou směrovatelná část,
 * žádná další věta to už neopraví; `session-store` pak takový záznam odmítne
 * a s ním celé trvalé úložiště. Odmítá se, neprořezává: prořezaná vazba by
 * tiše změnila svět, o který porotce žádal.
 */
function nextBlueprint(
  blueprint: WorldstreamBlueprint,
  world: WorldstreamBlueprint['world'],
  shape: WorldstreamBlueprint['shapes'][number] | null,
  addition: Addition | null,
): WorldstreamBlueprint | { pointer: string; detail: string } {
  if (addition !== null) {
    const candidate: WorldstreamBlueprint = {
      ...blueprint,
      world,
      objects: [...blueprint.objects, addition.object],
      shapes: [...blueprint.shapes, addition.shape],
    };
    const parsed = blueprintSchema.safeParse(candidate);
    // Ukazatel míří tam, kde schéma nebo odkazy selhaly, ne paušálně na
    // `/objects`: plný rozpočet tvarů (`shapes: too big`, když mezi preview a
    // commitem přibyl jiný objekt) je vada `/shapes`, a porotce má číst tu.
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { pointer: `/${issue.path.join('/')}`, detail: issue.message };
    }
    return referenced(candidate);
  }

  if (shape === null) return referenced({ ...blueprint, world });

  let replaced = 0;
  const shapes = blueprint.shapes.map((program) => {
    if (program.shapeId !== shape.shapeId) return program;
    replaced += 1;
    return shape;
  });

  return replaced === 1
    ? referenced({ ...blueprint, world, shapes })
    : { pointer: '/shapes', detail: `the world has ${replaced} hero shapes named ${shape.shapeId}, so the new form has nowhere to land` };
}

/** Kandidát, jehož odkazy sedí – nebo první osiřelý odkaz s cestou k němu. */
function referenced(candidate: WorldstreamBlueprint): WorldstreamBlueprint | { pointer: string; detail: string } {
  const issues = findBlueprintReferenceIssues(candidate);
  return issues.length === 0 ? candidate : { pointer: `/${issues[0].where}`, detail: issues[0].detail };
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

export async function POST(...args:Parameters<typeof handleDurablePOST>):Promise<Response> {
  return withSessionStorageResponse(async()=>{assertSessionStorageReady();return handleDurablePOST(...args);});
}
