/**
 * Řetěz emise — jedna implementace pro `POST /api/emit` i pro jeho SSE variantu.
 *
 * Pořadí kroků je součást kontraktu a je popsané u `route.ts`: **odkazy se
 * rozpouštějí dřív, než se cokoli sníží do IR**, hash pečetí systém a odmítnutí
 * se vždycky vztahuje jen na `sim`, nikdy na scénu.
 *
 * Sem se to přestěhovalo, protože kanál s průběhem potřebuje tentýž řetěz
 * s odbočkou po každém kroku. Druhá kopie by byla druhé místo, kde se dá pořadí
 * změnit — a rozdíl mezi nimi by se projevil až tím, že by průběh popisoval
 * něco jiného, než co endpoint doopravdy dělá.
 *
 * `route.ts` si nechává čtení těla a překlad na `Response`; tady je jen verdikt.
 */

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
import { verifyWitness } from '../../../verify/witness';

/** Fáze průběhu. Jména jsou shodná s `rejection.stage`, aby průběh a verdikt mluvily stejně. */
export type EmitPhase = 'emitted' | 'schema' | 'references' | 'look' | 'lowering' | 'witness';

export type ProgressSink = (phase: EmitPhase) => void;

export type EmissionOutcome =
  /** Rozbité prostředí, ne verdikt. O takovém běhu se nesmí nic skórovat. */
  | { readonly kind: 'unavailable'; readonly failure: ClientFailure }
  | { readonly kind: 'unknown-prompt' }
  | { readonly kind: 'verdict'; readonly body: Record<string, unknown> };

type Stage = 'schema' | 'references' | 'lowering' | 'witness' | 'look' | 'declined';

interface Rejection {
  readonly stage: Stage;
  readonly reason: string;
  readonly detail: string;
  readonly issues: readonly string[];
}

function rejected(promptId: string, rejection: Rejection, extra: object = {}): EmissionOutcome {
  return { kind: 'verdict', body: { promptId, outcome: 'REJECTED', rejection, doc: null, ...extra } };
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
 * Spustí celý řetěz nad zmrazeným promptem.
 *
 * Je to **generátor**, ne funkce s callbackem, a je to ten rozdíl, kvůli
 * kterému má kanál s průběhem vůbec smysl. Řetěz je čistě synchronní; kdyby
 * fáze jen volaly callback, doběhly by všechny dřív, než by první rámec opustil
 * socket, a průběh by dorazil naráz s verdiktem. Na `yield` se dá počkat, takže
 * `stream/route.ts` mezi kroky pustí smyčku událostí a rámec skutečně odejde.
 *
 * Fáze se ohlašuje po každém kroku, který **prošel**. Odmítnutí fázi
 * neohlašuje: kdo poslouchá průběh, dostane verdikt a v něm `rejection.stage`,
 * takže by se tatáž informace hlásila dvakrát a pokaždé jinak.
 */
export function* emissionSteps(promptId: string): Generator<EmitPhase, EmissionOutcome, void> {
  const prompt = frozenPrompt(promptId);
  if (!prompt.ok) return { kind: 'unavailable', failure: prompt };
  if (prompt.value === null || prompt.value.kind !== 'create') return { kind: 'unknown-prompt' };

  const grammar = frozenGrammar();
  if (!grammar.ok) return { kind: 'unavailable', failure: grammar };

  const upstream = buildEmissionRequest(prompt.value.prompt, grammar.value);
  const emission = emitWorld(promptId, upstream);
  if (!emission.ok) return { kind: 'unavailable', failure: emission };
  yield 'emitted';

  // Anotace se loupou **před** vším ostatním. Dokument je to, co zbude —
  // a jen na něj se ptá schéma, protože jen on se pečetí a hashuje.
  const peeled = peelEnvelope(emission.body);
  if (peeled === null)
    return rejected(
      promptId,
      { stage: 'schema', reason: 'NOT_A_DOCUMENT', detail: 'the emission body is not a JSON object', issues: [] },
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
    if (!declined.success) return rejected(promptId, rejectionFromSchema(declined.error.issues), envelope);

    const declinedLook = validateLook(declined.data.look);
    if (!declinedLook.ok)
      return rejected(
        promptId,
        { stage: 'look', reason: 'LOOK_INVALID', detail: declinedLook.issues[0], issues: declinedLook.issues },
        envelope,
      );

    return {
      kind: 'verdict',
      body: {
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
      },
    };
  }

  const parsed = worldEmissionSchema.safeParse(peeled.document);
  if (!parsed.success) return rejected(promptId, rejectionFromSchema(parsed.error.issues), envelope);
  yield 'schema';

  // Před snížením do IR, ne po něm: povrchová jména (countery, sockety, zóny)
  // se do IR vůbec nedostanou, takže osiřelý odkaz se za nimi už nedá najít.
  const dangling = findDanglingReferences(parsed.data);
  if (dangling.length > 0)
    return rejected(
      promptId,
      {
        stage: 'references',
        reason: 'DANGLING_REFERENCE',
        detail: `${dangling[0].where} names no declared ${dangling[0].namespace} ${dangling[0].name}`,
        issues: dangling.map((found) => `${found.where}: unknown ${found.namespace} ${found.name}`),
      },
      envelope,
    );
  yield 'references';

  const look = validateLook(parsed.data.look);
  if (!look.ok)
    return rejected(
      promptId,
      { stage: 'look', reason: 'LOOK_INVALID', detail: look.issues[0], issues: look.issues },
      envelope,
    );
  yield 'look';

  // Hash pečetí SYSTÉM, ne model — zmrazené odpovědi ho proto nenesou a
  // dokument ho dostává až tady, ze `sim`, kterou právě prošel schématem.
  const doc = sealSimHash(parsed.data);

  const built = buildRuntimeWorld(parsed.data.sim);
  if (!built.ok)
    return rejected(
      promptId,
      { stage: 'lowering', reason: built.reason, detail: built.issues[0] ?? 'no detail', issues: built.issues },
      { ...envelope, doc },
    );
  yield 'lowering';

  const verdict = verifyWitness(built.world, built.world.trace);
  if (verdict.verdict === 'REJECTED')
    return rejected(
      promptId,
      {
        stage: 'witness',
        reason: verdict.reason,
        detail: verdict.detail,
        issues: verdict.atStep === null ? [] : [`witness step ${verdict.atStep}`],
      },
      { ...envelope, doc },
    );
  yield 'witness';

  return {
    kind: 'verdict',
    body: { promptId, ...envelope, outcome: 'CERTIFIED', certificate: verdict, rejection: null, doc },
  };
}

/**
 * Řetěz doběhnutý synchronně. `/api/emit` průběh nikoho nezajímá, takže se
 * generátor jen protočí; `onProgress` je tu pro volajícího, který ho chce
 * a nepotřebuje mezi kroky uvolnit smyčku událostí.
 */
export function runEmission(promptId: string, onProgress?: ProgressSink): EmissionOutcome {
  const steps = emissionSteps(promptId);
  let next = steps.next();
  while (!next.done) {
    onProgress?.(next.value);
    next = steps.next();
  }
  return next.value;
}
