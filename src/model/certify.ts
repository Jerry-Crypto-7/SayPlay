/**
 * Certifikace emise — **jediná implementace pro server i pro prohlížeč**.
 *
 * Pořadí kroků je součást kontraktu a je popsané u `route.ts`: odkazy se
 * rozpouštějí dřív, než se cokoli sníží do IR, hash pečetí systém a odmítnutí se
 * vždycky vztahuje jen na `sim`, nikdy na scénu.
 *
 * ## Proč to nezůstalo v `chain.ts`
 *
 * `chain.ts` bere emisi ze zmrazeného korpusu, a ten se čte z disku
 * (`node:fs` v `model/client.ts`). Prohlížečová cesta z P11 bere emisi z modelu
 * běžícího na WebGPU, takže `chain.ts` naimportovat nemůže. Zbývaly dvě
 * možnosti: opsat řetěz podruhé, nebo ho vytáhnout sem. Druhá kopie by byla
 * druhé místo, kde se dá pořadí změnit — a rozdíl by se projevil až tím, že by
 * prohlížeč přijal svět, který server odmítá. To je přesně to tvrzení, na kterém
 * celý projekt stojí („nic vadného neprojde přijetím"), takže kopie nepřipadá
 * v úvahu.
 *
 * Tenhle soubor proto **nesmí sáhnout na `node:`** ani na nic, co to dělá.
 */

import { buildRuntimeWorld } from '../ir/build';
import { findDanglingReferences } from '../ir/references';
import {
  declinedEmissionSchema,
  peelEnvelope,
  sealSimHash,
  validateLook,
  worldEmissionSchema,
} from '../ir/worlddoc';
import { verifyWitness, type Certificate } from '../verify/witness';

import type { UpstreamRequest } from './prompt';
import type { RepairNote } from './repair';

/** Fáze průběhu. Jména jsou shodná s `rejection.stage`, aby průběh a verdikt mluvily stejně. */
export type EmitPhase = 'emitted' | 'schema' | 'references' | 'look' | 'lowering' | 'witness';

export type ProgressSink = (phase: EmitPhase) => void;

/**
 * Fáze, ve které emise skončila.
 *
 * Sedm hodnot, ne šest: `request` vydává prohlížečová větev, když model doslova
 * opíše ukázku ze systémové zprávy (`./local/emit.ts`). Je to odmítnutí, které
 * vzniká **před** certifikací, ale nese tentýž tvar — jinak by se ten jediný
 * verdikt musel sestavit přetypováním a přestal by platit pro čtenáře.
 *
 * ⚠ Nepleť si to s `Rejection` z `../verify/witness.ts`. Ta je o **svědkovi**
 * (`verdict`, `atStep`), tahle o **celé emisi**. Certifikace tu witnessovou
 * zabalí do `stage: 'witness'`.
 */
export type Stage = 'schema' | 'references' | 'lowering' | 'witness' | 'look' | 'declined' | 'request';

/**
 * Důvod odmítnutí — **typ, ne `Record<string, unknown>`**.
 *
 * Nese ho každý neúspěšný verdikt a čte ho produkce (hláška pro porotce),
 * evaluace (třídy odmítnutí) i vlna 2 (věta zpátky do modelu). Dokud byl
 * schovaný v netypovaném `body`, každý z těch tří čtenářů si ho zúžil sám a
 * chyba v tom zúžení prošla překladačem.
 */
export interface Rejection {
  readonly stage: Stage;
  readonly reason: string;
  readonly detail: string;
  readonly issues: readonly string[];
}

/** Emise po schématu — odvozeno ze schématu, aby se s ním nedalo rozejít. */
type ParsedEmission = Extract<ReturnType<typeof worldEmissionSchema.safeParse>, { success: true }>['data'];

/** Dokument, jak ho zapečetil systém. `simHash` přidává `sealSimHash()`. */
export type SealedEmission = ParsedEmission & { readonly simHash: string };

/** Co nese každý verdikt bez ohledu na výsledek. */
interface VerdictEnvelope {
  readonly promptId: string;
  readonly upstream: UpstreamRequest;
  /** Odkud emise přišla. Prochází beze změny. */
  readonly provenance: unknown;
  readonly annotations: Record<string, unknown>;
  /** Co doopravdy napsal model, včetně anotací — i u odmítnutí. */
  readonly emission: unknown;
  /**
   * Vyplňuje **jen prohlížečová větev**: dokument po deterministické opravě a
   * seznam zásahů (`./repair.ts`). Server neopravuje, takže je nemá.
   */
  readonly repairedEmission?: unknown;
  readonly repairs?: readonly RepairNote[];
}

/**
 * Tělo verdiktu, **rozlišené podle `outcome`**.
 *
 * Rozlišení je celý smysl typu: `if (body.outcome === 'REJECTED')` zúží
 * `rejection` na `Rejection`, takže se čte bez přetypování, a naopak na
 * certifikovaném verdiktu je `rejection` typově `null` — nedá se na něj ptát.
 *
 * **Data se tím nemění ani o bajt.** Klíče, pořadí i hodnoty jsou tytéž, jaké
 * `certifySteps()` vracelo předtím; pinuje to `__tests__/certify.test.ts`.
 */
export type VerdictBody =
  | (VerdictEnvelope & {
      readonly outcome: 'CERTIFIED';
      readonly certificate: Certificate;
      readonly rejection: null;
      readonly doc: SealedEmission;
    })
  | (VerdictEnvelope & {
      readonly outcome: 'NO_FIT';
      readonly certificate: null;
      readonly rejection: Rejection;
      readonly doc: null;
    })
  | (VerdictEnvelope & {
      readonly outcome: 'REJECTED';
      readonly rejection: Rejection;
      /**
       * `null` píše jen prohlížečová větev u `stage: 'request'`; serverová cesta
       * klíč vůbec nemá. Volitelný je proto, aby se **data nehnula** — obě
       * podoby existují dnes a obě musí projít beze změny.
       */
      readonly certificate?: null;
      /** Zapečetěný dokument existuje jen u odmítnutí po `sealSimHash()`. */
      readonly doc: SealedEmission | null;
    });

/**
 * Verdikt nad jednou emisí. **Tohle je ten sdílený tvar**: server i prohlížeč
 * vracejí tenhle typ a nic jiného, takže se jejich odpovědi nedají rozejít.
 */
export interface Verdict {
  readonly kind: 'verdict';
  readonly body: VerdictBody;
}

export interface CertifyInput {
  /** Jméno vstupu ve verdiktu. Server sem dává id zmrazeného promptu, prohlížeč větu. */
  readonly promptId: string;
  /** Co se doopravdy poslalo modelu. Zaznamenává se, aby byl běh auditovatelný. */
  readonly upstream: UpstreamRequest;
  /** Odkud emise přišla. Prochází beze změny do verdiktu. */
  readonly provenance: unknown;
  /** Syrové tělo emise, ještě s anotacemi obálky. */
  readonly body: unknown;
}

/**
 * Odmítnutý verdikt. `extra` je obálka, ne libovolný objekt — dokud byla
 * `object`, spread ji roztavil na nic a `doc` se dal přepsat čímkoli.
 */
function rejected(
  promptId: string,
  rejection: Rejection,
  extra: Omit<VerdictEnvelope, 'promptId'> & { readonly doc?: SealedEmission },
): Verdict {
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
 * Prožene emisi celým řetězem.
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
export function* certifySteps(input: CertifyInput): Generator<EmitPhase, Verdict, void> {
  const { promptId, upstream, provenance, body } = input;
  yield 'emitted';

  // Anotace se loupou **před** vším ostatním. Dokument je to, co zbude —
  // a jen na něj se ptá schéma, protože jen on se pečetí a hashuje.
  const peeled = peelEnvelope(body);
  if (peeled === null)
    return rejected(
      promptId,
      { stage: 'schema', reason: 'NOT_A_DOCUMENT', detail: 'the emission body is not a JSON object', issues: [] },
      { upstream, provenance, annotations: {}, emission: null },
    );

  // `emission` je v odpovědi **vždy**, i u odmítnutí. Odmítnutí se podle
  // §13.4 vztahuje výhradně na `sim`; scéna a emitované entity se s ním
  // zahazovat nesmějí, protože z nich se skórují `sceneMustBuild`
  // i `minEntitiesByRole`.
  const envelope = {
    upstream,
    provenance,
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
