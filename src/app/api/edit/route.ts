/**
 * `POST /api/edit` — emise **patche** proti běžícímu světu. Druhá větev téhož
 * kontraktu, kterou `/api/emit` obsluhuje pro tvorbu.
 *
 * ## Vrací patch, ne svět
 *
 * `DESIGN-BOOK.md` §15 a zmrazený `editContract`: živá editace je transakční
 * patch běžícího grafu **bez resetu**. Celý přeemitovaný svět by hráči sebral
 * stav a zároveň by zrušil jedinou věc, kterou jde na editaci měřit — dosah
 * změny. Dosah celého světa je celý svět. Odpověď proto nese operace, revize
 * po commitu a rozvinutý dosah; dokument v ní není.
 *
 * ## Dráhu rozhodují cesty, ne štítek
 *
 * Router (`src/patch/router.ts`, T22) je jediný vstup na editační cestě a štítek
 * od modelu **čte a zapisuje, ale nepoužije**. Kdyby si model směl říct „tohle je
 * jen vzhled", vybíral by si sám, jestli jeho změna půjde přes verifikátor —
 * přesně ta chyba, kterou §7 zakazuje. Neshoda štítku a cest je **anomálie do
 * telemetrie, ne důvod k odmítnutí**.
 *
 * ## Dvě revize, dvě nezávislé kontroly zastaralosti
 *
 * `baseRevision` je **dvojice**, ne číslo, a to je celý smysl §13.1.1: patch
 * pravidel se posuzuje proti `simRevision` a patch vzhledu proti `lookRevision`.
 * Se sdílenou revizí by vzhledový commit uprostřed verifikace `sim` odmítl patch
 * pravidel jako zastaralý, ačkoli se na `sim` nezměnilo nic. Zastaralá revize té
 * části, do které patch **podle cest** míří, je **409** — a rozhoduje se
 * o ní dřív, než se aplikuje cokoli, aby smíšený požadavek nezůstal půl
 * commitnutý.
 *
 * ## Co je chyba a co je výsledek
 *
 * Tatáž hranice jako u `/api/emit`, protože ji konzumuje týž scorer: **400**
 * nevalidní požadavek, **404** neznámý editační prompt nebo dvojice (svět,
 * prompt), kterou zmrazení nekryje, **408** tělo bez deadlinu, **413** tělo přes
 * strop, **409** zastaralá revize, **503** nečitelný nebo podvržený korpus.
 * Všechno ostatní je **200 s verdiktem** — patch, který se nedá směrovat,
 * aplikovat, snížit nebo jehož svědek po editaci nedojde do výhry, je *naměřený
 * výsledek*, ne chyba serveru.
 *
 * ## Necertifikovaný patch se nepoužije, ale scéna zůstává
 *
 * §13.4 (`look.emptyScreenRule`): *„`NO_FIT` a necertifikovaný patch se vztahují
 * VÝHRADNĚ na `sim`."* U smíšeného požadavku se proto vzhledová půlka commitne
 * okamžitě a zůstane v platnosti i tehdy, když pravidla neprojdou verifikací.
 * `applied` říká, které půlky si volající smí nechat — a `sim` mezi nimi je jen
 * tehdy, když jeho svědek po editaci znovu došel do výhry.
 *
 * ## Endpoint NEČTE `allowedPaths`
 *
 * `allowedPaths` je pole **kontraktu z eval sady** (`contracts.v1.jsonl`),
 * autorovaného člověkem pro měření. Produkční požadavek žádný nemá a nikdy mít
 * nebude, takže vpustit eval data na produkční cestu by znamenalo měřit potrubí
 * proti datům, která v něm za HALT bránou nebudou. Endpoint proto dosah jen
 * **spočítá a vydá** (`changedLeaves`, `editContract.changedLeafRule`); soudí ho
 * oracle úlohy a po něm scorer z T16.
 */

import { randomUUID } from 'node:crypto';

import type { Operation } from 'rfc6902';

import { BODY_DEADLINE_MS, MAX_BODY_BYTES, readBody } from '../../../http/body';
import { buildRuntimeWorld } from '../../../ir/build';
import { findDanglingReferences } from '../../../ir/references';
import { commitMixed, commitPart, isStale, type PartPatch, type RevisionResult } from '../../../ir/revision';
import { migrateWorldDoc, type WorldDoc } from '../../../ir/worlddoc';
import { emitPatch, frozenGrammar, frozenPrompt, type ClientFailure } from '../../../model/client';
import { buildEditRequest } from '../../../model/edit-prompt';
import { withRequest } from '../../../obs/trace';
import type { PatchRejection } from '../../../patch/reject';
import { routePatch, type RoutedPatch } from '../../../patch/router';
import { changedLeaves } from '../../../patch/scope';
import { verifyWitness } from '../../../verify/witness';

/** `AsyncLocalStorage` i čtení zmrazeného korpusu potřebují Node, ne edge. */
export const runtime = 'nodejs';

export { BODY_DEADLINE_MS, MAX_BODY_BYTES };

type Stage = 'routing' | 'apply' | 'references' | 'lowering' | 'witness';

interface Rejection {
  readonly stage: Stage;
  readonly reason: string;
  readonly pointer: string;
  readonly detail: string;
}

function badRequest(requestId: string, code: string, message: string, field?: string): Response {
  return Response.json({ requestId, error: { code, message, ...(field === undefined ? {} : { field }) } }, { status: 400 });
}

/**
 * Zmrazený korpus je nečitelný nebo se rozešel s `MANIFEST.lock`.
 *
 * **Není to verdikt a nesmí se skórovat** — stejně jako u `/api/emit`. Odchylkou
 * jsou dva důvody, které nemluví o prostředí, ale o dotazu: `BASE_WORLD_MISMATCH`
 * a `NO_FROZEN_RESPONSE` říkají, že pro dvojici (svět, prompt) zmrazený záznam
 * není. To je 404 nad dvojicí, ne 503.
 *
 * `BASE_WORLD_MISSING` je naopak zpátky na straně prostředí: editační záznam
 * jmenuje základní svět, který v korpusu chybí. Kdyby se schoval mezi ty dva
 * nad ním, rozbitý korpus by se vydával za naměřený výsledek.
 */
function corpusUnavailable(requestId: string, failure: ClientFailure): Response {
  if (failure.reason === 'BASE_WORLD_MISMATCH' || failure.reason === 'NO_FROZEN_RESPONSE')
    return Response.json(
      { requestId, error: { code: 'UNKNOWN_PAIR', message: failure.detail, field: 'worldDoc' } },
      { status: 404 },
    );
  return Response.json({ requestId, error: { code: failure.reason, message: failure.detail } }, { status: 503 });
}

function revisionOf(doc: WorldDoc, part: 'sim' | 'look'): number {
  return part === 'sim' ? doc.simRevision : doc.lookRevision;
}

/** Revize, které klient prohlašuje za aktuální. Obě, protože obě části se patchují. */
interface BaseRevision {
  readonly sim: number;
  readonly look: number;
}

function parseBaseRevision(value: unknown): BaseRevision | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { sim, look } = value as { sim?: unknown; look?: unknown };
  if (!Number.isInteger(sim) || !Number.isInteger(look)) return null;
  if ((sim as number) < 0 || (look as number) < 0) return null;
  return { sim: sim as number, look: look as number };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    const raw = await readBody(request);
    if (!raw.ok)
      return raw.reason === 'TOO_LARGE'
        ? Response.json(
            {
              requestId,
              error: { code: 'PAYLOAD_TOO_LARGE', message: `request body exceeds ${MAX_BODY_BYTES} bytes` },
            },
            { status: 413 },
          )
        : Response.json(
            {
              requestId,
              error: { code: 'BODY_TIMEOUT', message: `request body did not arrive within ${BODY_DEADLINE_MS} ms` },
            },
            { status: 408 },
          );

    let body: unknown;
    try {
      body = JSON.parse(raw.text);
    } catch {
      return badRequest(requestId, 'MALFORMED_BODY', 'request body is not JSON');
    }

    const { worldDoc, baseRevision, promptId } = (body ?? {}) as {
      worldDoc?: unknown;
      baseRevision?: unknown;
      promptId?: unknown;
    };

    if (typeof promptId !== 'string' || promptId.length === 0)
      return badRequest(
        requestId,
        'INVALID_REQUEST',
        'promptId must be a non-empty string naming a frozen edit prompt',
        'promptId',
      );

    const base = parseBaseRevision(baseRevision);
    if (base === null)
      return badRequest(
        requestId,
        'INVALID_REQUEST',
        'baseRevision must be { sim, look } with two non-negative integers — the two parts commit against separate revisions',
        'baseRevision',
      );

    // `migrateWorldDoc` je **jediný** vstup pro čtení dokumentu (viz poznámka na
    // konci `ir/revision.ts`): ověří tvar, verzi, konečnost čísel i to, že
    // `simHash` sedí na `sim`, kterou popisuje. Dokument, který si volající
    // upravil a hash nechal starý, se sem nedostane.
    const migrated = migrateWorldDoc(worldDoc);
    if (!migrated.ok || migrated.doc === null)
      return badRequest(requestId, 'INVALID_WORLD_DOC', migrated.reason, 'worldDoc');
    const doc = migrated.doc;

    const prompt = frozenPrompt(promptId);
    if (!prompt.ok) return corpusUnavailable(requestId, prompt);
    if (prompt.value === null || prompt.value.kind !== 'edit')
      return Response.json(
        {
          requestId,
          error: { code: 'UNKNOWN_PROMPT', message: `no frozen edit prompt named ${promptId}`, field: 'promptId' },
        },
        { status: 404 },
      );

    const grammar = frozenGrammar();
    if (!grammar.ok) return corpusUnavailable(requestId, grammar);

    const upstream = buildEditRequest(prompt.value.prompt, grammar.value, doc);
    // Vazba se ověřuje proti **obsahu** `sim`, ne proti `simHash`, který přišel
    // v požadavku. Ten je FNV-1a-32 a padělá se výpočtem, ne štěstím — viz
    // `simFingerprint` v `model/client.ts`.
    const emission = emitPatch(promptId, upstream, doc.sim);
    if (!emission.ok) return corpusUnavailable(requestId, emission);

    const envelope = {
      requestId,
      promptId,
      baseWorld: emission.baseWorld,
      upstream,
      provenance: emission.provenance,
      /** Co model poslal, doslova. Je to deliverable úlohy — patch, ne svět. */
      patch: emission.body,
      /** Štítek se zaznamenává, dráhu neurčuje. */
      label: emission.label ?? null,
    };

    const rejected = (rejection: Rejection, extra: object = {}): Response =>
      Response.json({
        ...envelope,
        outcome: 'REJECTED',
        lanes: [],
        applied: [],
        changedLeaves: [],
        revisions: revisionsOf(doc, doc),
        certificate: null,
        anomalies: [],
        rejection,
        ...extra,
      });

    // Router je jediný vstup: rozhodne dráhu z normalizovaných cest a smíšený
    // patch rozdělí na dva se stejným pořadím operací uvnitř každého. Přetypování
    // je poctivé právě proto, že router tvar obálky i operací kontroluje sám —
    // `readonly Operation[]` platí jen při překladu a tělo přišlo jako JSON.
    const routing = routePatch({ label: emission.label, operations: emission.body as readonly Operation[] });
    if (routing.verdict === 'REJECTED')
      return rejected({
        stage: 'routing',
        reason: routing.reason,
        pointer: routing.pointer,
        detail: `${routing.detail} (expected ${routing.expected})`,
      });

    // **Zastaralost se rozhoduje před aplikací čehokoli.** Kdyby se na ni přišlo
    // až uvnitř `commitMixed`, smíšený požadavek by zůstal půl commitnutý a klient
    // by dostal 409 nad světem, který se mu mezitím pod rukama pohnul.
    for (const routed of routing.patches) {
      const current = revisionOf(doc, routed.part);
      if (base[routed.part] === current) continue;
      return Response.json(
        {
          ...envelope,
          error: {
            code: 'STALE_REVISION',
            message: `patch was issued against ${routed.part}Revision ${base[routed.part]}, the document is at ${current}`,
            field: `baseRevision/${routed.part}`,
          },
          revisions: revisionsOf(doc, doc),
        },
        { status: 409 },
      );
    }

    const parts = routing.patches.map(
      (routed: RoutedPatch): PartPatch => ({
        part: routed.part,
        baseRevision: base[routed.part],
        operations: routed.operations,
      }),
    );

    // Smíšený požadavek: `look` se commitne OKAMŽITĚ a `sim` se vkládá do
    // AKTUÁLNÍHO dokumentu, tedy už do toho se vzhledem (§13.1.1). Vlastní
    // pořadí by vzhled vrátilo zpátky hráči před očima.
    const lookPatch = parts.find((patch) => patch.part === 'look');
    const simPatch = parts.find((patch) => patch.part === 'sim');
    const outcome =
      lookPatch !== undefined && simPatch !== undefined
        ? commitMixed(doc, lookPatch, simPatch)
        : singlePart(doc, parts[0]);

    const applied: ('sim' | 'look')[] = [];
    // **Obě půlky si nesou svůj důvod.** U smíšeného požadavku umí selhat každá
    // zvlášť a z jiné příčiny; nechat si jen jednu znamená, že se ta druhá ztratí
    // beze stopy a model dostane k opravě polovinu zprávy.
    const rejections: Rejection[] = [];
    let after = doc;

    if (outcome.look !== null) {
      if (outcome.look.verdict === 'COMMITTED') {
        applied.push('look');
        after = outcome.look.doc;
      } else rejections.push(fromRejection('apply', outcome.look));
    }

    let certificate: ReturnType<typeof verifyWitness> | null = null;

    if (outcome.sim !== null) {
      if (outcome.sim.verdict === 'COMMITTED') {
        // `look` se mezitím mohl commitnout, takže se bere dokument ze `sim` větve —
        // ta už ten vzhled nese.
        const committed = outcome.sim.doc;
        const verified = certifySim(committed);
        certificate = verified.certificate;
        if (verified.rejection === null) {
          applied.push('sim');
          after = committed;
        } else {
          // Necertifikovaný patch se vztahuje **výhradně na `sim`** — `look`, který
          // se commitnul, v `applied` zůstává a scéna se s ním nezahazuje.
          rejections.push(verified.rejection);
        }
      } else rejections.push(fromRejection('apply', outcome.sim));
    }

    return Response.json({
      ...envelope,
      outcome: rejections.length === 0 ? 'CERTIFIED' : 'REJECTED',
      lanes: routing.patches.map((routed) => routed.lane),
      applied,
      // Dosah **diffem stavu**, ne čtením operací (`editContract.changedLeafRule`).
      // Počítá se jen z toho, co se doopravdy použilo: necertifikovaná `sim` se
      // nikam neaplikuje, takže její listy nejsou změněné, jen navrhované.
      changedLeaves: [
        ...(applied.includes('sim') ? changedLeaves(doc.sim, after.sim, '/sim') : []),
        ...(applied.includes('look') ? changedLeaves(doc.look, after.look, '/look') : []),
      ].sort(),
      revisions: revisionsOf(doc, after),
      certificate,
      anomalies: routing.anomalies,
      rejection: rejections[0] ?? null,
      rejections,
    });
  });
}

function revisionsOf(before: WorldDoc, after: WorldDoc): object {
  return {
    sim: { before: before.simRevision, after: after.simRevision },
    look: { before: before.lookRevision, after: after.lookRevision },
  };
}

/** Jednodílný patch ve stejném tvaru, v jakém vrací výsledek `commitMixed`. */
function singlePart(
  doc: WorldDoc,
  patch: PartPatch,
): { look: RevisionResult | null; sim: RevisionResult | null } {
  const result = commitPart(doc, patch);
  return patch.part === 'look' ? { look: result, sim: null } : { look: null, sim: result };
}

function fromRejection(stage: Stage, result: PatchRejection): Rejection {
  return {
    stage,
    // `isStale` sem dojít nemá — zastaralost se odbavuje 409 před aplikací —
    // ale kdyby se ta hranice někdy posunula, ať to řekne verdikt, ne mlčení.
    reason: isStale(result) ? 'STALE_REVISION' : result.reason,
    pointer: result.pointer,
    detail: `${result.detail} (expected ${result.expected})`,
  };
}

/**
 * Svědek po editaci — **znovu ověřený nad commitnutou `sim`**, ne převzatý.
 *
 * Editace, která pravidla změní tak, že svědek přestane docházet do výhry, je
 * přesně ta věc, kterou má editační větev umět zachytit. Převzít starý
 * certifikát by znamenalo tvrdit o novém světě něco, co bylo naměřené nad jiným.
 */
function certifySim(doc: WorldDoc): {
  certificate: ReturnType<typeof verifyWitness> | null;
  rejection: Rejection | null;
} {
  // Před snížením do IR, ne po něm: povrchová jména se do IR nedostanou, takže
  // odkaz osiřelý po editaci by se za nimi už nedal najít.
  const dangling = findDanglingReferences(doc);
  if (dangling.length > 0)
    return {
      certificate: null,
      rejection: {
        stage: 'references',
        reason: 'DANGLING_REFERENCE',
        pointer: '/sim',
        detail: `${dangling[0].where} names no declared ${dangling[0].namespace} ${dangling[0].name}`,
      },
    };

  const built = buildRuntimeWorld(doc.sim);
  if (!built.ok)
    return {
      certificate: null,
      rejection: {
        stage: 'lowering',
        reason: built.reason,
        pointer: '/sim',
        detail: built.issues[0] ?? 'no detail',
      },
    };

  const verdict = verifyWitness(built.world, built.world.trace);
  if (verdict.verdict === 'REJECTED')
    return {
      certificate: verdict,
      rejection: {
        stage: 'witness',
        reason: verdict.reason,
        pointer: '/sim/witness',
        detail: verdict.detail,
      },
    };

  return { certificate: verdict, rejection: null };
}
