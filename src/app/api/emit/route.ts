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
 * **404** neznámý zmrazený prompt. **408** tělo, které nedorazilo do
 * `BODY_DEADLINE_MS`. **413** tělo přes strop. **503** nečitelný
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
 * ## Odmítnutí se vztahuje na `sim`, nikdy na scénu
 *
 * Zmrazený protokol to říká jednou větou a platí pro **všechna** odmítnutí, ne
 * jen pro `NO_FIT`: *„`NO_FIT` a necertifikovaný patch se vztahují VÝHRADNĚ na
 * `sim`"* (`look.emptyScreenRule`, §13.4). Odpověď proto vždy nese `emission` —
 * oloupaný dokument tak, jak přišel — takže `look` i emitovaná `sim` přežijí
 * i odmítnutí, které se stalo dřív, než mohl vzniknout `doc`. Bez toho přišly
 * `C12` a `C13` o scénu i o entity, ze kterých se skórují jejich vlastní
 * požadavky (`sceneMustBuild`, `minEntitiesByRole`).
 *
 * `doc` má oproti tomu užší význam a nechává si ho: **zapečetěný dokument**,
 * který prošel schématem. `null` znamená „nevznikl", ne „scéna se ztratila".
 *
 * ## Anotace obálky
 *
 * `simOutcome`, `refusedBeforeModel` a `clampedFrom` jedou **vedle** dokumentu
 * (`ENVELOPE_ANNOTATIONS` ve `worlddoc.ts`) a endpoint je oloupe dřív, než
 * cokoli validuje. Jmenovitá větev na dvou z nich tuhle třídu nezavřela —
 * pole navíc nesou **4 z 15** zmrazených create emisí, ne 2.
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
import {
  declinedEmissionSchema,
  peelEnvelope,
  sealSimHash,
  validateLook,
  worldEmissionSchema,
} from '../../../ir/worlddoc';
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
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Strop **času** na přečtení celého těla, ne jen jeho přebytku.
 *
 * Paměť ohraničuje `MAX_BODY_BYTES`, čas neohraničovalo nic: nekonečný chunked
 * POST držel handler až do výchozích 300 s `requestTimeout` Node, protože
 * smyčka čeká na `reader.read()` a hodiny se v ní nikdo neptá.
 *
 * **Musí to platit i POD stropem, a to je oprava první, poloviční verze.** Ta
 * armovala deadline až v okamžiku přetečení, takže stačil jeden kilobajtový kus
 * a nezavřený stream: nikdy se nepřeteklo, deadline se nenaarmoval a handler
 * visel dál — táž denial, jen za 1/64 odeslaných bajtů. Velikost a čas jsou dvě
 * nezávislé meze a nesmí se jedna podmiňovat druhou.
 *
 * Legální požadavek je jedno krátké id, takže 5 s je řádově nad čímkoli, co
 * poctivý klient potřebuje.
 *
 * Za deadlinem se zbytek **zruší**, přestože to je přesně ta cesta, kterou
 * docblock `readBody` popisuje jako škodlivou. Je to vědomá výměna: rozsynchro-
 * nizované keep-alive spojení se týká klienta, který posílá tělo pět sekund;
 * zdržený handler se týká všech ostatních.
 *
 * **Wall-clock je tu legální.** Zákaz `Date.now()` z `CLAUDE.md` platí na
 * replay cestě, kde je simulovaný tik jedinou jednotkou. Tohle je čtení HTTP
 * těla — do hashovaného stavu z něj nevstupuje nic.
 */
export const BODY_DEADLINE_MS = 5_000;

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

/** Neznámé pole je pořád `SCHEMA_VIOLATION` — obálka nic nepovoluje navíc. */
function rejectionFromSchema(issues: readonly { message: string; path: PropertyKey[] }[]): Rejection {
  return {
    stage: 'schema',
    reason: 'SCHEMA_VIOLATION',
    detail: issues[0].message,
    issues: issues.map((issue) => `/${issue.path.join('/')}: ${issue.message}`),
  };
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
 * Načte tělo pod dvěma nezávislými mezemi: **velikostí** a **časem**.
 *
 * Co chrání velikost: **paměť**. Nad stropem se nedrží nic, takže žádný upload
 * nenafoukne proces — víc než `MAX_BODY_BYTES` plus jeden kus se nikdy nesejde
 * na hromadě. Šířku pásma to nechrání a předstírat se to nebude; na to je
 * reverzní proxy, ne route handler.
 *
 * **Za stropem se dočítá a zahazuje, a ruší se až na deadlinu.** To pořadí je
 * důležité, protože `reader.cancel()` má naměřenou cenu: nechá na keep-alive
 * spojení nepřečtený zbytek těla, takže server začne číst zbytek uploadu jako
 * začátek dalšího požadavku. Naměřeno proti `next start` — po zrušeném 200 kB
 * uploadu **další velký požadavek na témže spojení uvízl** až do timeoutu,
 * zatímco krátký prošel. Vypadá to jako vada klienta a není; spojení
 * rozsynchronizuje server.
 *
 * Proto se ruší jedině tehdy, když dojdou hodiny — a **týká se to i klienta pod
 * stropem**, který jen posílá pomalu. Je to vědomá výměna zapsaná
 * u `BODY_DEADLINE_MS`: rozsynchronizované spojení platí ten, kdo posílá tělo
 * přes pět sekund, zdržený handler by platili všichni ostatní.
 */
export type BodyRead = { ok: true; text: string } | { ok: false; reason: 'TOO_LARGE' | 'TIMEOUT' };

export async function readBody(request: Request, deadlineMs = BODY_DEADLINE_MS): Promise<BodyRead> {
  if (request.body === null) return { ok: true, text: '' };
  const reader = request.body.getReader();
  // **Jedny hodiny na celé čtení**, naarmované hned. Ne až při přetečení: pod
  // stropem se nepřeteče nikdy, takže podmíněný deadline neplatí zrovna tam,
  // kde je nejlevnější ho obejít.
  const readUntil = Date.now() + deadlineMs;
  let chunks: Uint8Array[] = [];
  let size = 0;
  let overflowed = false;

  for (;;) {
    const chunk = await raceDeadline(reader.read(), readUntil - Date.now());
    if (chunk === null) {
      // Zbytek se zruší; viz `BODY_DEADLINE_MS`, proč zrovna tady.
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: overflowed ? 'TOO_LARGE' : 'TIMEOUT' };
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_BODY_BYTES) {
      if (!overflowed) {
        overflowed = true;
        chunks = [];
      }
      continue;
    }
    chunks.push(chunk.value);
  }
  return overflowed ? { ok: false, reason: 'TOO_LARGE' } : { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/** `null` znamená, že vypršel deadline dřív, než dorazil další kus. */
async function raceDeadline<T>(pending: Promise<T>, remainingMs: number): Promise<T | null> {
  if (remainingMs <= 0) return null;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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

    // Anotace se loupou **před** vším ostatním. Dokument je to, co zbude —
    // a jen na něj se ptá schéma, protože jen on se pečetí a hashuje.
    const peeled = peelEnvelope(emission.body);
    if (peeled === null)
      return rejected(
        requestId,
        promptId,
        {
          stage: 'schema',
          reason: 'NOT_A_DOCUMENT',
          detail: 'the emission body is not a JSON object',
          issues: [],
        },
        { upstream, provenance: emission.provenance, annotations: {}, emission: null },
      );

    // `emission` je v odpovědi **vždy**, i u odmítnutí. Odmítnutí se podle
    // §13.4 vztahuje výhradně na `sim`; scéna a emitované entity se s ním
    // zahazovat nesmějí, protože z nich se skórují `sceneMustBuild`
    // i `minEntitiesByRole`.
    const envelope = {
      upstream,
      provenance: emission.provenance,
      annotations: peeled.annotations,
      emission: peeled.document,
    };

    // Poctivé odmítnutí `sim` části, ne vada emise. Říká to anotace na obálce,
    // ne pole dokumentu — pod ní zbývá jen tvar `sim: null` plus platný `look`.
    if (peeled.annotations.simOutcome === 'NO_FIT') {
      const declined = declinedEmissionSchema.safeParse(peeled.document);
      if (!declined.success)
        return rejected(requestId, promptId, rejectionFromSchema(declined.error.issues), envelope);

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
        // `doc` je zapečetěný dokument, a ten tu nevznikl — není co hashovat.
        // Scéna se tím neztrácí, jede v `emission`.
        doc: null,
      });
    }

    const parsed = worldEmissionSchema.safeParse(peeled.document);
    if (!parsed.success)
      return rejected(requestId, promptId, rejectionFromSchema(parsed.error.issues), envelope);

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
