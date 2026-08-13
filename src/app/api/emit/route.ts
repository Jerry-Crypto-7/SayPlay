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
 * **404** neznámý zmrazený prompt. **413** tělo přes strop. **503** nečitelný
 * nebo podvržený zmrazený korpus — rozbité prostředí, o kterém se nesmí nic
 * skórovat. Všechno ostatní je **200 s verdiktem**: emise, která neprošla
 * schématem, nese osiřelý odkaz, nejde snížit nebo její svědek nedojde do výhry,
 * je *naměřený výsledek*, ne chyba serveru. Kdyby se z toho dělalo 5xx, měřicí
 * běh v T17 by nerozeznal vadný svět od spadlého potrubí — a přesně to je
 * rozdíl, který má celý P1 změřit.
 *
 * `rejection.stage` proto nese **atribuci**: `lowering` znamená mez naší
 * reprezentace, `references` a `schema` vadu emise, `witness` nedosažitelnou
 * výhru, `declined` poctivé systémové odmítnutí `sim` části. Scorer v T16 na
 * tom stojí.
 *
 * ## `NO_FIT` není vada schématu
 *
 * Zmrazený protokol vede `NO_FIT` jako *„systém poctivě odmítl `sim` část"*
 * a zároveň žádá, aby se **scéna postavila i tak** (§13.4). Taková emise nese
 * `simOutcome: "NO_FIT"`, `sim: null` a platný `look`. Do `worldEmissionSchema`
 * se nevejde a bez vlastní větve by ji endpoint hlásil jako `SCHEMA_VIOLATION`
 * s `doc: null` — tedy vadu emise místo systémového odmítnutí, a ještě by
 * zahodil scénu, kterou má povinnost vydat.
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
import { declinedEmissionSchema, sealSimHash, validateLook, worldEmissionSchema } from '../../../ir/worlddoc';
import { emitWorld, frozenGrammar, frozenPrompt, type ClientFailure } from '../../../model/client';
import { buildEmissionRequest } from '../../../model/prompt';
import { withRequest } from '../../../obs/trace';
import { verifyWitness } from '../../../verify/witness';

/** `AsyncLocalStorage` i čtení zmrazeného korpusu potřebují Node, ne edge. */
export const runtime = 'nodejs';

/**
 * Strop těla požadavku. Route handlery App Routeru žádný vlastní nemají, takže
 * bez tohohle by se libovolně velký POST celý nabufferoval dřív, než se vůbec
 * podíváme na `promptId`. Legální požadavek je jedno krátké id.
 */
const MAX_BODY_BYTES = 64 * 1024;

type Stage = 'schema' | 'references' | 'lowering' | 'witness' | 'look' | 'declined';

interface Rejection {
  readonly stage: Stage;
  readonly reason: string;
  readonly detail: string;
  readonly issues: readonly string[];
}

function rejected(requestId: string, promptId: string, rejection: Rejection, extra: object = {}): Response {
  return Response.json({ requestId, promptId, outcome: 'REJECTED', rejection, doc: null, ...extra });
}

/**
 * Zmrazený korpus je nečitelný nebo se rozešel s `MANIFEST.lock`.
 *
 * **Není to verdikt a nesmí se skórovat.** Start z jiného pracovního adresáře
 * nebo podvržený soubor nevypovídají o modelu nic; kdyby to endpoint vydal jako
 * 200 s odmítnutím, T17 by to započítal jako vadnou emisi.
 */
function corpusUnavailable(requestId: string, failure: ClientFailure): Response {
  return Response.json(
    { requestId, error: { code: failure.reason, message: failure.detail } },
    { status: 503 },
  );
}

/**
 * Načte tělo se stropem. Za stropem **dočítá a zahazuje**, nikdy neruší.
 *
 * Co to chrání: **paměť**. Nad stropem se nedrží nic, takže žádný upload
 * nenafoukne proces — víc než `MAX_BODY_BYTES` plus jeden kus se nikdy nesejde
 * na hromadě. Šířku pásma to nechrání a předstírat se to nebude; na to je
 * reverzní proxy, ne route handler.
 *
 * **Proč se neruší, ačkoli by to šetřilo i pásmo:** `reader.cancel()` nechá na
 * keep-alive spojení nepřečtený zbytek těla, takže server začne číst zbytek
 * uploadu jako začátek dalšího požadavku. Naměřeno proti `next start`: po
 * odmítnutém 200 kB uploadu **další velký požadavek na témže spojení uvízl** až
 * do timeoutu, zatímco krátký prošel. Vypadá to jako vada klienta a není —
 * spojení rozsynchronizuje server.
 */
async function readBody(request: Request): Promise<{ ok: true; text: string } | { ok: false }> {
  if (request.body === null) return { ok: true, text: '' };
  const reader = request.body.getReader();
  let chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      if (!overflowed) {
        overflowed = true;
        chunks = [];
      }
      continue;
    }
    chunks.push(value);
  }
  return overflowed ? { ok: false } : { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();

  return withRequest(requestId, async () => {
    const raw = await readBody(request);
    if (!raw.ok)
      return Response.json(
        {
          requestId,
          error: { code: 'PAYLOAD_TOO_LARGE', message: `request body exceeds ${MAX_BODY_BYTES} bytes` },
        },
        { status: 413 },
      );

    let body: unknown;
    try {
      body = JSON.parse(raw.text);
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
    if (!prompt.ok) return corpusUnavailable(requestId, prompt);
    if (prompt.value === null || prompt.value.kind !== 'create')
      return Response.json(
        {
          requestId,
          error: { code: 'UNKNOWN_PROMPT', message: `no frozen create prompt named ${promptId}`, field: 'promptId' },
        },
        { status: 404 },
      );

    const grammar = frozenGrammar();
    if (!grammar.ok) return corpusUnavailable(requestId, grammar);

    const upstream = buildEmissionRequest(prompt.value.prompt, grammar.value);
    const emission = emitWorld(promptId, upstream);
    if (!emission.ok) return corpusUnavailable(requestId, emission);

    const envelope = { upstream, provenance: emission.provenance };

    const parsed = worldEmissionSchema.safeParse(emission.body);
    if (!parsed.success) {
      // Poctivé odmítnutí `sim` části, ne vada emise — a scéna se vydává i tak.
      // `simHash` tu chybí schválně: není co hashovat, `sim` neexistuje.
      const declined = declinedEmissionSchema.safeParse(emission.body);
      if (declined.success) {
        const declinedLook = validateLook(declined.data.look);
        if (!declinedLook.ok)
          return rejected(
            requestId,
            promptId,
            { stage: 'look', reason: 'LOOK_INVALID', detail: declinedLook.issues[0], issues: declinedLook.issues },
            envelope,
          );

        return Response.json({
          requestId,
          promptId,
          ...envelope,
          outcome: 'NO_FIT',
          certificate: null,
          rejection: {
            stage: 'declined',
            reason: 'NO_FIT_DECLARED',
            detail: 'the emission declined the sim part; the scene is still built from look',
            issues: [],
          },
          doc: declined.data,
        });
      }

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
    }

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
