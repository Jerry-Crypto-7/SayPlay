/**
 * `POST /api/emit` — emise celého světa proti zmrazenému promptu.
 *
 * Řetěz je celý tady, v jednom čitelném pořadí, protože pořadí je součást
 * kontraktu: **odkazy se rozpouštějí dřív, než se cokoli sníží do IR**. Osiřelý
 * counter je odmítnutí s adresou, ne výjimka z hloubky snižování — `references.ts`
 * kvůli tomu vznikl v T8b a do téhle úlohy neměl produkčního volajícího.
 *
 * ## Co je chyba a co je výsledek
 *
 * **400** vrací jen **nevalidní požadavek** — tělo, které není `{ promptId }`.
 * **404** neznámý zmrazený prompt. Všechno ostatní je **200 s verdiktem**:
 * emise, která neprošla schématem, nese osiřelý odkaz, nejde snížit nebo její
 * svědek nedojde do výhry, je *naměřený výsledek*, ne chyba serveru. Kdyby se
 * z toho dělalo 5xx, měřicí běh v T17 by nerozeznal vadný svět od spadlého
 * potrubí — a přesně to je rozdíl, který má celý P1 změřit.
 *
 * `rejection.stage` proto nese **atribuci**: `lowering` znamená mez naší
 * reprezentace, `references` a `schema` vadu emise, `witness` nedosažitelnou
 * výhru. Scorer v T16 na tom stojí.
 *
 * ## Část vzhledu
 *
 * Zmrazený protokol (`look.p1Status`) říká, že v P1 vzhled emituje **systém**,
 * ne model. Zmrazené odpovědi ho nesou, protože je autorovala T2 jako systémový
 * default — endpoint ho tedy jen validuje schématem a kontrolou konečnosti všech
 * číselných hodnot a připojí nezměněný. Tvrzení „scénu autoruje model" smí padnout
 * až po P5.
 */

import { randomUUID } from 'node:crypto';

import { buildRuntimeWorld } from '../../../ir/build';
import { findDanglingReferences } from '../../../ir/references';
import { sealSimHash, validateLook, worldEmissionSchema } from '../../../ir/worlddoc';
import { emitWorld, frozenGrammar, frozenPrompt } from '../../../model/client';
import { buildEmissionRequest } from '../../../model/prompt';
import { withRequest } from '../../../obs/trace';
import { verifyWitness } from '../../../verify/witness';

/** `AsyncLocalStorage` i čtení zmrazeného korpusu potřebují Node, ne edge. */
export const runtime = 'nodejs';

type Stage = 'client' | 'schema' | 'references' | 'lowering' | 'witness' | 'look';

interface Rejection {
  readonly stage: Stage;
  readonly reason: string;
  readonly detail: string;
  readonly issues: readonly string[];
}

function rejected(requestId: string, promptId: string, rejection: Rejection, extra: object = {}): Response {
  return Response.json({ requestId, promptId, outcome: 'REJECTED', rejection, doc: null, ...extra });
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { requestId, error: { code: 'MALFORMED_BODY', message: 'request body is not JSON' } },
        { status: 400 },
      );
    }

    const promptId = (body as { promptId?: unknown } | null)?.promptId;
    if (typeof promptId !== 'string' || promptId.length === 0)
      return Response.json(
        {
          requestId,
          error: {
            code: 'INVALID_REQUEST',
            message: 'promptId must be a non-empty string naming a frozen prompt',
            field: 'promptId',
          },
        },
        { status: 400 },
      );

    const prompt = frozenPrompt(promptId);
    if (prompt === null || prompt.kind !== 'create')
      return Response.json(
        {
          requestId,
          error: { code: 'UNKNOWN_PROMPT', message: `no frozen create prompt named ${promptId}`, field: 'promptId' },
        },
        { status: 404 },
      );

    const upstream = buildEmissionRequest(prompt.prompt, frozenGrammar());
    const emission = emitWorld(promptId, upstream);
    if (!emission.ok)
      return rejected(
        requestId,
        promptId,
        { stage: 'client', reason: emission.reason, detail: emission.detail, issues: [] },
        { upstream },
      );

    const envelope = { upstream, provenance: emission.provenance };

    const parsed = worldEmissionSchema.safeParse(emission.body);
    if (!parsed.success)
      return rejected(
        requestId,
        promptId,
        {
          stage: 'schema',
          reason: 'SCHEMA_VIOLATION',
          detail: parsed.error.issues[0].message,
          issues: parsed.error.issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`),
        },
        envelope,
      );

    // Před snížením do IR, ne po něm: povrchová jména (countery, sockety, zóny)
    // se do IR vůbec nedostanou, takže osiřelý odkaz se za nimi už nedá najít.
    const dangling = findDanglingReferences(parsed.data);
    if (dangling.length > 0)
      return rejected(
        requestId,
        promptId,
        {
          stage: 'references',
          reason: 'DANGLING_REFERENCE',
          detail: `${dangling[0].where} names no declared ${dangling[0].namespace} ${dangling[0].name}`,
          issues: dangling.map((found) => `${found.where}: unknown ${found.namespace} ${found.name}`),
        },
        envelope,
      );

    const look = validateLook(parsed.data.look);
    if (!look.ok)
      return rejected(
        requestId,
        promptId,
        { stage: 'look', reason: 'LOOK_INVALID', detail: look.issues[0], issues: look.issues },
        envelope,
      );

    // Hash pečetí SYSTÉM, ne model — zmrazené odpovědi ho proto nenesou a
    // dokument ho dostává až tady, ze `sim`, kterou právě prošel schématem.
    const doc = sealSimHash(parsed.data);

    const built = buildRuntimeWorld(parsed.data.sim);
    if (!built.ok)
      return rejected(
        requestId,
        promptId,
        {
          stage: 'lowering',
          reason: built.reason,
          detail: built.issues[0] ?? 'no detail',
          issues: built.issues,
        },
        { ...envelope, doc },
      );

    const verdict = verifyWitness(built.world, built.world.trace);
    if (verdict.verdict === 'REJECTED')
      return rejected(
        requestId,
        promptId,
        {
          stage: 'witness',
          reason: verdict.reason,
          detail: verdict.detail,
          issues: verdict.atStep === null ? [] : [`witness step ${verdict.atStep}`],
        },
        { ...envelope, doc },
      );

    return Response.json({
      requestId,
      promptId,
      ...envelope,
      outcome: 'CERTIFIED',
      certificate: verdict,
      rejection: null,
      doc,
    });
  });
}
