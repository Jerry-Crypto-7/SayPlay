/**
 * Verifikátor svědka — **kroková** kontrola, ne jen „doběhlo to do výhry".
 *
 * `DESIGN-BOOK.md` §6 staví garanci na tom, že každý přijatý kandidát nese
 * svědka ověřeného replayem. Samotné „stopa došla do `win()`" ale certifikuje
 * i náhodnou procházku, takže verifikace stojí na třech nezávislých mezích:
 *
 * 1. **`H_cert`** — kolik tiků se smí hledat. Deklaruje ho **systém**
 *    (`./tiers`), ne dokument.
 * 2. **`K_input`** — kolik kanonických vstupů svědek smí nést. Jediná obrana
 *    proti dlouhé, náhodně vypadající stopě. Kontroluje se **před** replayem,
 *    takže svědek nad stropem je odmítnut, i kdyby do výhry došel.
 * 3. **proveditelnost k-tého kroku** — vstup jednající entitou, která v tom
 *    stavu není aktivní, není záznam hry. Tohle je jediná ze tří mezí, která se
 *    musí měřit **za běhu**, protože závisí na stavu, do kterého došly kroky
 *    před ní.
 *
 * Certifikát zaznamenává, co skutečně platilo (`tier`, `L_witness`, `K_input`,
 * verze runtimu, hash snapshotu), ne co si dokument přál.
 */

import { hashHex } from '../sim/hash';
import {
  RUNTIME_VERSION,
  createRuntime,
  entityActive,
  step,
  type Runtime,
  type TraceInput,
  type WorldDocRuntime,
} from '../sim/interpreter';
import { DEFAULT_REQUEST, resolvePolicy, type CertificationRequest, type Tier } from './tiers';

/** Kanonický zástupce za nepřítomný `target?`. Nerozpouští se proti entitám. */
const NO_TARGET = 'none';

export type RejectReason =
  /** Horizont je nad stropem svého tieru. Nikdy se nezvedne, nikdy nepovýší. */
  | 'NO_FIT'
  /** Svědek nese víc vstupů, než tier povoluje. */
  | 'INPUT_CAP'
  /** k-tý krok je v tom stavu neproveditelný. */
  | 'STEP_UNREACHABLE'
  /** Horizont vyčerpán bez výhry, nebo prohra. */
  | 'NO_WIN'
  /** Runtime spadl do definovaného chybového stavu. */
  | 'RUNTIME_FAULT';

export interface Certificate {
  readonly verdict: 'CERTIFIED';
  readonly tier: Tier;
  /**
   * Horizont, který certifikaci skutečně řídil. Je to **vždy** `H_cert` tieru,
   * nikdy číslo z dokumentu — `evals/frozen/protocol.v1.json` má
   * `horizonDeclaredBy: "system"` a `modelMayDeclareHorizon: false`.
   */
  readonly horizonTicks: number;
  /** `L_witness` — kolik tiků stopa doopravdy potřebovala. */
  readonly witnessLength: number;
  /** `K_input` — kolik kanonických vstupů stopa doopravdy nese. */
  readonly inputCount: number;
  readonly runtimeVersion: string;
  /** Hash zabaleného stavu v tiku výhry. */
  readonly snapshotHash: string;
}

export interface Rejection {
  readonly verdict: 'REJECTED';
  readonly reason: RejectReason;
  /** Index kroku svědka, na kterém se to zlomilo; `null` mimo kroky. */
  readonly atStep: number | null;
  readonly detail: string;
}

export type VerifyResult = Certificate | Rejection;

/** Svět plus jeho **žádost** o certifikaci. Bez žádosti platí nejkratší tier. */
export type VerifiableWorld = WorldDocRuntime & { readonly certification?: CertificationRequest };

function reject(reason: RejectReason, atStep: number | null, detail: string): Rejection {
  return { verdict: 'REJECTED', reason, atStep, detail };
}

/**
 * Cíl kanonické akce je `entityOrSocket`, ne jen entita.
 *
 * `src/ir/references.ts` typuje `onAction.target` i cíle svědkových operací jako
 * `entityOrSocket` a zmrazený korpus tak vypadá — `{ actionId: "moveTo", target:
 * "s1" }` je jeho nejběžnější tvar. Kdyby verifikátor uznával jen entity,
 * odmítal by jako neproveditelnou většinu svědků, které mu P1 vůbec pošle.
 *
 * Sokety se rozpouštějí proti **deklarovanému** layoutu, ne proti vykreslené
 * geometrii — je to táž vstupní hranice z §13.1, jen druhý jmenný prostor.
 *
 * **Jmenné prostory se nesčítají, řadí se.** Jméno, které je deklarovanou
 * entitou, se rozhoduje VÝHRADNĚ podle její aktivity; soket je až náhradník pro
 * jména, která entitou nejsou. Sjednocení („entita **nebo** soket") tu bylo
 * a bylo to tiché vypnutí jediné kontroly, kterou verifikátor umí změřit až za
 * běhu: stačí soket pojmenovaný jako entita a despawnutý cíl projde. Není to
 * teoretický tvar — ve zmrazeném korpusu má **9 ze 13** světů soket pojmenovaný
 * přesně jako entita (`exit`, `valve`, `chest`, `torch`, `bed`, `oil`) a jsou to
 * tytéž názvy, na které míří jejich svědci.
 *
 * Nic se tím neztrácí: `PULSE_FACTS.acted` má cíl jako `entityOrNone`, takže
 * jméno, které je *jen* soketem, stejně nemůže klíčovat `acted` predikát.
 *
 * **Soketový prostor je `sockets` SJEDNOCENÉ se `zones`**, ne jen `sockets`.
 * Definuje ho `src/ir/references.ts:148` a je to tentýž prostor, proti kterému
 * se rozpouštějí cíle svědkových operací. Ptát se jen na `space.sockets` je
 * půlka opravy: zóna je legitimní cíl `moveTo` a odmítnout ji znamená nevydat
 * certifikát světu, který se doopravdy vyhrát dá — tedy chybu opačným směrem,
 * ale pořád chybu.
 */
function targetReachable(doc: VerifiableWorld, runtime: Runtime, target: string): boolean {
  if (runtime.entityDecls.has(target)) return entityActive(runtime, target);
  return Object.hasOwn(doc.space.sockets, target) || Object.hasOwn(doc.space.zones, target);
}

/**
 * Vlastnosti svědka, které nezávisí na stavu: pořadí a rozsah tiků.
 *
 * Kontrolují se předem, protože replay smyčka doručuje vstupy podle tiku —
 * vstup s tikem menším než už odkrokovaný by se jí prostě minul a stopa by
 * skončila jako `NO_WIN` místo jako neplatná. Tichý rozdíl mezi „nedošlo to do
 * výhry" a „ten svědek nedává smysl" je přesně ten druh záměny, kvůli kterému
 * certifikát přestane něco znamenat.
 */
function shapeOfWitness(witness: readonly TraceInput[], horizonTicks: number): Rejection | null {
  let previousTick = -1;
  for (let k = 0; k < witness.length; k += 1) {
    const input = witness[k];
    if (!Number.isInteger(input.tick) || input.tick < 0)
      return reject('STEP_UNREACHABLE', k, `tick ${String(input.tick)} is not a tick index`);
    if (input.tick < previousTick)
      return reject('STEP_UNREACHABLE', k, `tick ${input.tick} goes back before ${previousTick}`);
    if (input.tick >= horizonTicks)
      return reject('STEP_UNREACHABLE', k, `tick ${input.tick} is at or beyond the horizon ${horizonTicks}`);
    previousTick = input.tick;
  }
  return null;
}

/**
 * Ověří svědka krok po kroku a buď vydá certifikát, nebo řekne, kde se to
 * zlomilo.
 *
 * Pořadí kontrol je součást kontraktu: `NO_FIT` a `INPUT_CAP` padnou **před**
 * prvním tikem. Svědek nad stropem tieru se tedy odmítne, i kdyby do `win()`
 * došel — kdyby se kontrolovaly až po replayi, stačilo by výhru najít a strop by
 * byl dekorace.
 */
export function verifyWitness(doc: VerifiableWorld, witness: readonly TraceInput[]): VerifyResult {
  const request = doc.certification ?? DEFAULT_REQUEST;
  const policy = resolvePolicy(request);
  if (policy === null)
    return reject(
      'NO_FIT',
      null,
      `horizon ${String(request.horizonTicks)} does not fit tier ${String(request.tier)}`,
    );

  if (witness.length > policy.maxInputs)
    return reject(
      'INPUT_CAP',
      policy.maxInputs,
      `witness carries ${witness.length} inputs, tier ${policy.tier} allows ${policy.maxInputs}`,
    );

  // `H_cert` tieru, NIKDY číslo z dokumentu. Žádost směla jen říct, o který tier
  // jde, a `resolvePolicy` už ověřila, že se do něj vejde.
  const horizonTicks = policy.maxHorizonTicks;
  const malformed = shapeOfWitness(witness, horizonTicks);
  if (malformed !== null) return malformed;

  const runtime = createRuntime(doc);
  let cursor = 0;

  for (let tick = 0; tick < horizonTicks && runtime.runState === 'running'; tick += 1) {
    const inputs: TraceInput[] = [];
    for (let k = cursor; k < witness.length && witness[k].tick === tick; k += 1) {
      const input = witness[k];
      // Proveditelnost se měří TEĎ, proti stavu, do kterého došly kroky před
      // tímhle — ne proti výchozímu světu.
      if (!entityActive(runtime, input.actor))
        return reject('STEP_UNREACHABLE', k, `actor ${input.actor} is not an active entity at tick ${tick}`);
      const target = input.target;
      if (target !== undefined && target !== NO_TARGET && !targetReachable(doc, runtime, target))
        return reject(
          'STEP_UNREACHABLE',
          k,
          `target ${target} is neither an active entity nor a declared socket or zone at tick ${tick}`,
        );
      inputs.push(input);
    }
    cursor += inputs.length;

    const result = step(runtime, inputs);
    if (result.runState === 'runtimeFault')
      return reject('RUNTIME_FAULT', cursor, `${String(result.fault)} at tick ${tick}`);
    if (result.runState === 'lost') return reject('NO_WIN', cursor, `run was lost at tick ${tick}`);
    if (result.runState === 'won') {
      // Kroky za výhrou by se nikdy nezkontrolovaly — běh už skončil, takže
      // proveditelné nejsou, a přesto by se počítaly do `K_input`. Certifikát by
      // tak vykazoval délku stopy, kterou nikdo neověřil.
      if (cursor < witness.length)
        return reject(
          'STEP_UNREACHABLE',
          cursor,
          `step lies after the run ended at tick ${tick}, so it was never played`,
        );
      return {
        verdict: 'CERTIFIED',
        tier: policy.tier,
        horizonTicks,
        witnessLength: runtime.tick,
        inputCount: witness.length,
        runtimeVersion: RUNTIME_VERSION,
        snapshotHash: hashHex(runtime.state),
      };
    }
  }

  return reject('NO_WIN', cursor, `horizon ${horizonTicks} exhausted in state ${runtime.runState}`);
}
