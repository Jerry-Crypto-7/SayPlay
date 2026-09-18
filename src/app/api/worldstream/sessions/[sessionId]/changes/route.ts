import {withSessionStorageResponse} from '@/server/session-persistence';
import {assertSessionStorageReady} from '@/worldstream/sessions';
import {ownerIdentityRejection} from '@/server/owner-identity';
import { observePhase, observePhaseAsync } from '@/model/phase-observer';
import { APPEARANCE_UNSUPPORTED, hasUnsupportedAppearance, hasUnsupportedMotion, MOTION_UNSUPPORTED, SHAPE_ONLY_MOTION_SUMMARY } from '@/server/worldstream-capabilities';
import { routePatch, type RoutedPatch } from '@/patch/router';
import { additionScopeIssue } from '@/patch/scope';
import { commitRoutedParts } from '@/app/api/edit/commit';
import type { PartPatch } from '@/ir/revision';
import {prepareComparisonCandidate} from '@/worldstream/comparison-candidate';
import { withServerMetrics, serverPhaseObserver, currentServerMetrics } from '@/server/worldstream-metrics';
/**
 * `POST /api/worldstream/sessions/:id/changes` — **preview druhé věty** (P15 T22, §21).
 *
 * Design book §4 dějství III: *„Systém ukáže rozsah dřív, než cokoli změní."*
 * Tyhle dveře tedy nic nemění. Vyrobí plán, uloží ho k relaci a vrátí, co by se
 * stalo — commit je druhá route a druhé rozhodnutí člověka.
 *
 * ## Tři brány, a jedna z nich je zadarmo
 *
 * 1. **Tvar těla.** Přijímá se `prompt` a nepovinné `stableId` (cíl vybraný
 *    klikem v T23). Klíč navíc je 400 — ze stejného důvodu jako u zakládání
 *    relace: kdyby se ignoroval, `shape` nebo `behavior` od klienta by vypadaly
 *    jako přijaté a produkt by tvrdil, že geometrii píše model, zatímco by ji
 *    směl podstrčit kdokoli.
 * 2. **Moderace**, táž jako u zakládání relace.
 * 3. **Grounding** — a ten je **před** modelem, tedy zadarmo. Nejasná věta se
 *    vrátí jako nabídka kandidátů a nestojí ani jedno placené volání. Je to
 *    zároveň jediný způsob, jak se druhá věta smí splést: nabídkou, ne odhadem.
 *    **Věta bez cíle není nejasná — zakládá nový objekt** (P21 T8): `NO_MATCH`
 *    jde k modelu jako zadání „přidej", ne zpátky jako nabídka celého světa.
 *    Nabídka zůstává tam, kde je věta doopravdy nerozhodnutá (`AMBIGUOUS`) nebo
 *    kde klient tvrdí id, které svět nemá (`UNKNOWN_ID`).
 *
 * Za nimi stojí ještě **strop souběhu** — týž čítač jako u zakládání relace.
 * Není to brána vstupu, protože se bere až těsně před placeným voláním.
 *
 * ## Rozpočet požadavku tu stál a nikdy nesepnul
 *
 * Do 4. 9. 2026 tu byla čtvrtá brána: `admit()` na promlčeném rozpočtu
 * (`CHANGE_POLICY`: 10 s rozpočtu, 2 s minimální obsluhy). **Nezávislá revize
 * ji vyvrátila měřením** — odmítala až nad 8 s čekání, jenže `receivedAtMs` se
 * bralo až uvnitř handleru, takže jediný interval, který se odsud dal změřit,
 * bylo čtení těla, a to má vlastní strop `BODY_DEADLINE_MS = 5 000`
 * (`src/http/body.ts`). Naměřeno revizí: 0 / 1 000 / 4 999 / 5 000 / 7 999 ms
 * všechno `ADMITTED`. Táž vada a totéž odstranění jako v `/api/generate`
 * (`7c1e12f`) a v zakládací routě.
 *
 * ## Meshing tady nezačne, a nezačne ani o kus dál
 *
 * Preview **nevolá `session.queue()` ani `session.revise()`**. Kdyby volalo,
 * porotce by za preview zaplatil výměnou podoby, kterou ještě neodsouhlasil —
 * a zrušené preview by po sobě nechalo objekt v `planned`, tedy prázdné místo
 * na scéně. Revize se zvedá až v commitu, jednomu jedinému objektu.
 */

import { randomUUID } from 'node:crypto';

import { bodyRefusalResponse, readBody } from '@/http/body';
import {
  groundTarget,
  planChange,
  type ChangeOutcome,
  type PendingChange,
  type RefinePlan,
} from '@/model/worldstream-refine';
import type { BlueprintEmitter } from '@/model/worldstream-repair';
import { planIncrement } from '@/model/incremental-planner';
import { withRequest } from '@/obs/trace';
import { killState } from '@/server/kill-switch';
import { moderatePrompt } from '@/server/moderation';
import { logRateLimited } from '@/server/public-faults';
import { callerKey, trustedCallerKey, rateLimitCode, rateLimitedResponse, takeRateSlot } from '@/server/rate-limit';
import { SpendRefusalError } from '@/server/spend-cap';
import {
  authoredWorldById,
  changeEmitterFor,
  chooseAuthoredChange,
} from '@/worldstream/authored';
import { preservedBy } from '@/worldstream/preserved';
import type { WorldstreamBlueprint } from '@/worldstream/schema';
import { getSession, putChange, SESSION_FAULTS } from '@/worldstream/sessions';

import { acquireSlot, cloudEmitter, releaseSlot, slotsDetail } from '../../route';

export const runtime = 'nodejs';

function fail(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ requestId, error: { code, message } }, { status });
}

interface ChangeRequest {
  readonly prompt: unknown;
  readonly stableId?: string;
  readonly comparison?: boolean;
}

type BodyRead = { ok: true; value: ChangeRequest } | { ok: false; code: string; message: string };

/** Tělo je `{ prompt }` a nepovinné `{ stableId }`. Klíč navíc je vada, ne přebytek. */
function readChangeBody(text: string): BodyRead {
  let body: unknown;
  try {
    body = JSON.parse(text === '' ? 'null' : text);
  } catch {
    return { ok: false, code: 'BODY_NOT_JSON', message: 'the request body is not JSON' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, code: 'BODY_NOT_AN_OBJECT', message: 'the request body is not a JSON object' };

  const extra = Object.keys(body).filter((key) => key !== 'prompt' && key !== 'stableId' && key !== 'comparison');
  if (extra.length > 0)
    return {
      ok: false,
      code: 'UNEXPECTED_FIELDS',
      message: `this endpoint takes a prompt and an optional stableId; it will not accept ${extra.join(', ')}`,
    };

  const { prompt, stableId, comparison } = body as { prompt?: unknown; stableId?: unknown; comparison?: unknown };
  if (comparison !== undefined && typeof comparison !== 'boolean') return {ok:false,code:'INVALID_COMPARISON',message:'comparison must be a boolean'};
  if (stableId !== undefined && typeof stableId !== 'string')
    return { ok: false, code: 'INVALID_STABLE_ID', message: 'stableId must be a string' };

  return { ok: true, value: { prompt, ...(comparison === undefined ? {} : { comparison }), ...(stableId === undefined ? {} : { stableId }) } };
}

async function handleDurablePOST(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
): Promise<Response> {
  const { sessionId } = await context.params;
  return createChange(request, sessionId, await cloudEmitter(sessionId));
}

/**
 * Kdo tuhle druhou větu obslouží, když živá větev není nakonfigurovaná.
 *
 * ⚠ **Pořadí je součást kontraktu, stejně jako u zakládání relace.** Živý model
 * má přednost vždycky a sklad je až za ním; kdyby předbíhal, zaplacený klíč by
 * přestal být vidět a `T40` by místo modelu měřila cache.
 *
 * Hledá se **v mezích jednoho světa a jednoho cíle**, ne přes celý sklad.
 * Uvařená změna nese `stableId` z blueprintu, nad kterým ji model psal, takže
 * cizí by ji `readRefineEmission()` odmítl jako `WRONG_TARGET` — „nejbližší
 * přes všechno" by porotci místo změny spolehlivě vrátilo odmítnutí. Objekt,
 * ke kterému se změna neuvařila, tedy druhou větu nemá a route to řekne rovnou.
 */
function authoredChangeFor(
  stored: NonNullable<ReturnType<typeof getSession>>,
  prompt: string,
  stableId: string,
): ReturnType<typeof chooseAuthoredChange> {
  if (stored.authoredWorldId === null) return null;
  const world = authoredWorldById(stored.authoredWorldId);
  return world === null ? null : chooseAuthoredChange(prompt, stableId, world);
}

/**
 * Celá route bez dvou řádků, které se v testu nedají mít: rozbalení `params`
 * a **placeného** emitoru.
 *
 * Bez toho by šťastná cesta těchhle dveří neměla oracle vůbec — `cloudEmitter()`
 * bez `.env` vrací `null`, takže by sada uměla otestovat jen odmítnutí. Vzor je
 * `runGeneration` v `src/worldstream/sessions.ts`, který je oddělený od
 * zakládací route ze stejného důvodu.
 *
 * ⚠ **Parametr je `cloud`, ne „emitor".** Sklad uvařených změn se dosazuje až
 * uvnitř, protože se hledá podle **groundnutého cíle** — a ten je známý až za
 * moderací a groundingem. Kdo sem pošle `null`, dostane tedy pořád tu větev,
 * kterou má nasazení bez klíče.
 */
export async function createChange(
  request: Request,
  sessionId: string,
  cloud: BlueprintEmitter | null,
): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, () => withServerMetrics(requestId, 'edit', async () => {
    // Vypínač `refine` je první brána, před čtením těla — táž úvaha jako
    // u zakládání relace: vypnuté dveře nesmí stát víc než přečtení souboru.
    if ((await observePhaseAsync(serverPhaseObserver, 'request-kill-switch', () => killState(process.env))).refine) {
      logRateLimited('worldstream/changes', requestId, 'REFINE_DISABLED', 'kill switch: refine');
      return fail(requestId, 503, 'REFINE_DISABLED', 'changing worlds is switched off right now');
    }

    // Strop na frekvenci, hned za vypínačem a před čtením těla. Tyhle dveře
    // stojí navíc placené volání, takže čítač souběhu níž zůstává — frekvence
    // a souběh měří dvě různé věci a jedna druhou nenahradí.
    const identityRejection=ownerIdentityRejection(request);
    if(identityRejection)return identityRejection;
    const slot = takeRateSlot('changes', trustedCallerKey(request) ?? callerKey(request));
    if (!slot.allowed) {
      logRateLimited(
        'worldstream/changes',
        requestId,
        rateLimitCode(slot),
        `${String(slot.count)} in window`,
      );
      return rateLimitedResponse(requestId, slot);
    }

    let raw;
    try {
      raw = await observePhaseAsync(serverPhaseObserver, 'request-body-read', () => readBody(request));
    } catch (thrown) {
      logRateLimited(
        'worldstream/changes',
        requestId,
        'BODY_UNREADABLE',
        thrown instanceof Error ? thrown.message : String(thrown),
      );
      return fail(requestId, 400, 'BODY_UNREADABLE', 'the request body could not be read');
    }
    // **Dva starší důvody si nechávají svůj pravopis.** Tyhle dveře vydávají
    // `TOO_LARGE`/`TIMEOUT` tam, kde ostatní vydávají `PAYLOAD_TOO_LARGE`
    // a `BODY_TIMEOUT`; sjednotit to je změna kontraktu, kterou tahle úloha
    // neobjednala. Nový důvod (plná fronta čtení) sdílí kód se všemi dveřmi,
    // a hlavně: `? 413 : 408` na něj vydávalo **408 „tělo dorazilo pomalu"**,
    // tedy tvrzení o volajícím, který neudělal nic.
    if (!raw.ok)
      return raw.reason === 'BUSY'
        ? bodyRefusalResponse(requestId, raw)
        : fail(
            requestId,
            raw.reason === 'TOO_LARGE' ? 413 : 408,
            raw.reason,
            raw.reason === 'TOO_LARGE'
              ? 'the request body is too large'
              : 'the request body arrived too slowly',
          );

    const read = observePhase(serverPhaseObserver, 'request-parse-and-validation', () => readChangeBody(raw.text));
    if (!read.ok) return fail(requestId, 400, read.code, read.message);

    const stored = getSession(sessionId);
    if (stored === null)
      return fail(
        requestId,
        404,
        'UNKNOWN_SESSION',
        'no session with that id is being served by this process',
      );

    // **Změnit se dá jen svět, který stojí.** Relace před `world.ready` blueprint
    // nemá, takže by nebylo co groundovat ani proti čemu psát operace — a 409 to
    // říká líp než 404, protože ta adresa za chvíli platit bude.
    const blueprint = stored.blueprint;
    if (blueprint === null)
      return fail(
        requestId,
        409,
        'WORLD_NOT_READY',
        'this session has no world yet, so there is nothing to change',
      );

    // Uzavřená relace preview přijmout smí, ale nikdy by ho nešlo commitnout —
    // a nechat porotce zaplatit modelem za změnu, kterou dveře o kus dál
    // odmítnou, je horší než říct to hned.
    const phase = stored.session.phase;
    if (phase === 'complete' || phase === 'failed')
      return fail(requestId, 409, 'SESSION_CLOSED', 'this session is closed and no longer takes changes');

    const verdict = moderatePrompt(read.value.prompt);
    if (!verdict.ok) return fail(requestId, 400, verdict.category, verdict.detail);

    // **Jedna věta = jeden kus** (P21 T9), rozhodnuto před groundingem a před
    // modelem. Věta bez obsahu („ok add something nice") projde moderací a model
    // by na ni objekt vymyslel — tady je odmítnutá zadarmo. Věta o víc věcech
    // jde dál jen svým prvním kusem; zbytek se vrací porotci jako fronta, aby
    // ho poslal další větou. Věta o jedné věci jde dál **doslova**, ne
    // ořezaná: sklad uvařených změn ji hledá podle textu.
    const increment = planIncrement(verdict.prompt);
    if (!increment.ok) {
      stored.session.events.append('patch.rejected', { reason: increment.reason, detail: increment.detail });
      return Response.json({ requestId, outcome: 'REJECTED', reason: increment.reason, detail: increment.detail });
    }
    const pieces =
      increment.pieces.length > 1
        ? { asked: increment.pieces[0].text, remaining: increment.pieces.slice(1).map((piece) => piece.text) }
        : null;
    const sentence = pieces === null ? verdict.prompt : pieces.asked;

    // **Grounding je před modelem, a proto je zadarmo.** Nejasná věta se vrátí
    // jako nabídka i na nasazení bez klíče: je to odpověď o světě, ne o modelu,
    // a platit za otázku, na kterou se ještě nikdo nezeptal, je čistá ztráta.
    const grounding = groundTarget(sentence, blueprint.objects, read.value.stableId);
    // `NO_MATCH` bez `stableId` je věta o něčem, co ve světě není — a od P21 T8
    // je to zadání, ne odmítnutí. `target === null` níž znamená právě tohle.
    const adding = !grounding.ok && grounding.reason === 'NO_MATCH';
    if (!grounding.ok && !adding)
      return Response.json({
        requestId,
        outcome: 'AMBIGUOUS',
        reason: grounding.reason,
        candidates: grounding.candidates,
      });
    const target = grounding.ok ? grounding.target : null;

    // **Živý model má přednost, sklad je za ním** (`T35-actsthree4`) — táž
    // záložní větev a totéž pořadí jako u zakládání relace. Sklad má jen změny
    // existujících objektů; nový objekt bez modelu nikdo nenapíše.
    const authored = cloud === null && target !== null ? authoredChangeFor(stored, sentence, target.stableId) : null;
    const emit = cloud ?? (authored === null ? null : changeEmitterFor(authored.change));

    // `null` znamená „cloudová větev není nakonfigurovaná a sklad na tenhle
    // objekt změnu nemá". Na rozdíl od zakládání relace se tu neshazuje celá
    // relace — svět běží dál a porotce ho pořád vidí; nepovedla se jen tahle
    // jedna změna.
    // ⚠ **Není to porucha modelu a nesmí se tak jmenovat** — nález nezávislé
    // revize 6. 9. 2026. `MODEL_UNAVAILABLE` znamená „model se nepodařilo
    // dovolat"; tady se žádný model nevolal, protože žádný nakonfigurovaný
    // není a sklad na tenhle objekt změnu nemá. Rozdíl není akademický:
    // uvařenou změnu má dnes pět světů z jedenácti, takže tohle je **výchozí**
    // odpověď pro porotce, který změní jiný svět — a ten má číst pravdu, ne
    // hlášku o výpadku, který se nestal.
    if (emit === null)
      return fail(
        requestId,
        503,
        'NO_AUTHORED_CHANGE',
        'no change for that object was authored ahead of time, and no model is configured to write one now',
      );

    // **Týž čítač jako u zakládání relace**, ne druhý po čtyřech. Preview je
    // placené volání modelu a je levnější na vyvolání než celý svět — relaci si
    // založí kdokoli. Kdyby měly tyhle dveře strop vlastní, útočník by je
    // střídal a v letu by běželo osm volání místo čtyř.
    //
    // `'refine'` má **vlastní strop pod dnem čítače**, stejně jako stavba
    // světa: každé dveře se zastaví o slot dřív, aby ty druhé nevyhladověly.
    // Nápor sem tedy nevypne druhou větu ani stavbu světa — celé odůvodnění
    // je u `DOOR_CEILING` v create route.
    if (!acquireSlot('refine')) {
      // **Odmítnutí musí být vidět v operátorském logu**, stejně jako
      // u zakládání relace: bez řádku se „strop nás ochránil" nedá odlišit od
      // „nikdo nepřišel". Konstantní text, objem nese `(occurrence N)`.
      // **„on this instance"** ze stejného důvodu jako u sesterských dveří: čítač
      // je stav modulu, ne nasazení.
      logRateLimited(
        'worldstream/changes',
        requestId,
        'TOO_MANY_CHANGES',
        // **Řádek jmenuje dveře, které sloty drží** (`T22-doorcounters`):
        // preview se odmítne jedině tehdy, když je plný společný součet, a
        // operátor z rozpadu pozná, jestli ho vyčerpaly světy, nebo preview.
        slotsDetail('refine'),
      );
      return fail(
        requestId,
        503,
        'TOO_MANY_CHANGES',
        'too many changes are being planned right now',
      );
    }

    currentServerMetrics()?.setProvenance(cloud === null ? 'prepared' : 'live');
    let outcome: ChangeOutcome;
    try {
      outcome = await planChange({
        observePhase: serverPhaseObserver,
        prompt: sentence,
        blueprint,
        target,
        emit,
      });
    } finally {
      // `finally`, ne řádek za `await`: `planChange` smí házet a slot, který se
      // nevrátí, strop utáhne natrvalo.
      releaseSlot('refine');
    }

    // **Ta relace tu ještě je?** Volání modelu trvá vteřiny a registr je mezitím
    // živá věc: nápor přes `MAX_LIVE_SESSIONS` ji uvolní i uprostřed rozdělané
    // práce (`T16-changeafterrelease`). Bez téhle jediné otázky by `putChange`
    // zapsal preview do objektu, který v registru už není — volající by dostal
    // 200 a `changeId`, jehož commit může navždy vrátit jen 404. Zaplaceno je
    // tak jako tak; jediné, co se dá zachránit, je pravdivá odpověď.
    if (getSession(sessionId) !== stored)
      return fail(
        requestId,
        409,
        'SESSION_CLOSED',
        'this session is closed and no longer takes changes',
      );

    if (outcome.kind === 'unavailable') {
      // **Odmítnutý strop není mlčící poskytovatel** (P15 `T29-readinessledger`).
      // Druhá věta má tutéž vadu jako stavba světa: dokud se obojí hlásilo jako
      // `MODEL_UNAVAILABLE`, četl porotce „the model could not be reached" i
      // o žádosti, která se nikam neodeslala. Rozhoduje typ výjimky, ne text.
      const code =
        outcome.cause instanceof SpendRefusalError ? 'SPEND_CAP_BLOCKED' : 'MODEL_UNAVAILABLE';
      // Detail poskytovatele ven nejde nikdy — `fetch` píše do svých hlášek celou
      // adresu koncového bodu a ta umí nést pověření. Ven kód a věta, do logu
      // operátora všechno ostatní.
      logRateLimited('worldstream/changes', requestId, code, outcome.detail);
      return fail(requestId, 503, code, SESSION_FAULTS[code]);
    }

    if (outcome.kind === 'rejected') {
      stored.session.events.append('patch.rejected', {
        reason: outcome.reason,
        detail: outcome.detail,
      });
      return Response.json({
        requestId,
        outcome: 'REJECTED',
        reason: outcome.reason,
        detail: outcome.detail,
      });
    }

    let { plan } = outcome;
    if (hasUnsupportedAppearance(plan))
      return fail(requestId, 422, 'APPEARANCE_UNSUPPORTED', APPEARANCE_UNSUPPORTED);
    if (hasUnsupportedMotion(plan, blueprint.world)) {
      if (plan.shape === null) return fail(requestId, 422, 'MOTION_UNSUPPORTED', MOTION_UNSUPPORTED);
      // Offer a new, explicit shape-only scope for the user to review. Never
      // reuse the old summary or silently narrow an already stored preview.
      plan = { ...plan, behavior: [], summary: SHAPE_ONLY_MOTION_SUMMARY };
    }
    // **Dosah přidání se soudí nad skutečným dokumentem už tady**, ne až na
    // commitu: brána je diff stavu (`additionScopeIssue`), takže potřebuje
    // dokument po patchi — a `commitRoutedParts` je čistá funkce nad kopií,
    // takže dry run do relace nezapíše nic. Porotce tak vidí `ALLOWED_PATH`
    // dřív, než by klikl na commit, a commit soudí toutéž funkcí ještě jednou.
    if (plan.addition !== null && plan.behavior.length > 0) {
      const out = additionOutOfScope(plan.behavior, blueprint.world, plan.stableId);
      if (out !== null) {
        stored.session.events.append('patch.rejected', { reason: out.reason, detail: out.detail });
        return Response.json({ requestId, outcome: 'REJECTED', reason: out.reason, detail: out.detail });
      }
    }
    // The main UI compares every behavior edit. Validate its typed/scope contract
    // before offering confirmation; a winning witness is not required for A4.
    // Přidání se nesrovnává: svět před ním ten objekt neměl, takže není s čím.
    if(read.value.comparison === true && plan.behavior.length>0 && plan.addition === null){
      if(plan.shape!==null)return fail(requestId,422,'COMPARISON_REJECTED','A rule comparison cannot also replace geometry.');
      const routed=routePatch({operations:plan.behavior},blueprint.world);
      if(routed.verdict==='REJECTED')return fail(requestId,422,'COMPARISON_REJECTED',routed.detail);
      const prepared=prepareComparisonCandidate(blueprint.world,routed.patches.map(p=>({part:p.part,baseRevision:blueprint.world.simRevision,operations:p.operations})));
      if(!prepared.ok)return fail(requestId,422,'COMPARISON_REJECTED',`${prepared.reason}: ${prepared.detail}`);
    }
    const named = plan.addition === null ? target! : plan.addition.object;
    const change: PendingChange = {
      changeId: randomUUID(),
      plan,
      basedOn: {
        // Objekt je v registru od `session.register()`, takže `null` sem nedojde;
        // 0 je poctivá odpověď i tak — objekt bez podoby je na revizi 0.
        representation: stored.session.revisionOf(plan.stableId) ?? 0,
        sim: blueprint.world.simRevision,
        look: blueprint.world.lookRevision,
      },
    };
    putChange(stored, change);

    const scope = {
      shape: plan.shape !== null,
      behavior: plan.behavior.length,
      appearance: plan.appearance.length,
      /** Věta zakládá objekt, který ve světě nebyl (P21 T8). */
      addition: plan.addition !== null,
    };

    stored.session.events.append(
      'patch.preview',
      { changeId: change.changeId, stableId: plan.stableId, summary: plan.summary, scope },
      plan.stableId,
    );

    return Response.json({
      requestId,
      changeId: change.changeId,
      outcome: 'PREVIEW',
      summary: plan.summary,
      target: { stableId: named.stableId, label: named.label },
      scope,
      // §4 ukazuje porotci vedle rozsahu i to, co změna **nechá být**. Je to
      // polovina slibu „bez resetu" a bez ní se ta věta nedá ověřit očima.
      preserved: preservedBy(blueprint.objects, plan, blueprint.world),
      // **Chybí, když změnu píše model** — týž kontrakt a týž důvod jako
      // u zakládání relace (`T45-honestlabel`). Poctivost platí i pro druhou
      // větu: přehrávanou změnu porotce odhalí tím, že dvě různé věty udělají
      // totéž, a produkt to má říct dřív než on.
      ...(authored === null ? {} : { authored: { match: authored.match } }),
      // **Jen když se věta řezala** (P21 T9): co z ní šlo modelu a co porotci
      // zbývá poslat další větou. Věta o jedné věci pole nenese.
      ...(pieces === null ? {} : { pieces }),
      basedOn: change.basedOn,
      commit: `/api/worldstream/sessions/${sessionId}/changes/${change.changeId}/commit`,
    });
  }));
}

/**
 * Sáhly by operace přidání na něco, co už ve světě stálo?
 *
 * Dry run stávajícím řetězem — router rozhodne dráhu, `commitRoutedParts`
 * provede patch nad kopií — a pak diff `sim` před a po. Odmítnutí routeru nebo
 * commitu se vrací pod svým jménem: jsou to jiné vady než cizí cesta a porotce
 * má číst tu pravou.
 */
function additionOutOfScope(
  operations: RefinePlan['behavior'],
  doc: WorldstreamBlueprint['world'],
  stableId: string,
): { readonly reason: string; readonly detail: string } | null {
  const routing = routePatch({ operations }, doc);
  if (routing.verdict === 'REJECTED') return { reason: routing.reason, detail: routing.detail };

  const patches = routing.patches.map(
    (routed: RoutedPatch): PartPatch => ({
      part: routed.part,
      baseRevision: routed.part === 'sim' ? doc.simRevision : doc.lookRevision,
      operations: routed.operations,
    }),
  );
  const committed = commitRoutedParts(doc, patches);
  if (committed.outcome === 'REJECTED')
    return { reason: committed.rejections[0].reason, detail: committed.rejections[0].detail };

  const issue = additionScopeIssue(doc.sim, committed.after.sim, stableId);
  return issue === null ? null : { reason: 'ALLOWED_PATH', detail: issue.detail };
}

export async function POST(...args:Parameters<typeof handleDurablePOST>):Promise<Response> {
  return withSessionStorageResponse(async()=>{assertSessionStorageReady();return handleDurablePOST(...args);});
}
