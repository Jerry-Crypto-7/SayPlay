/**
 * Odmítnutí → věta, kterou model umí použít.
 *
 * ## Proč to překládá kód, a ne model
 *
 * Smyčka vlny 2 vrací modelu jeho vlastní vadu. Kdyby tu větu psal model,
 * přibyl by druhý běh na GPU (dalších ~40 s) a druhé místo, kde se dá věc
 * domyslet špatně. Tenhle modul je proto **čistá deterministická funkce**:
 * tentýž `Rejection` vydá tentýž řetězec, vždycky.
 *
 * ## Adresa, ne nálada
 *
 * Certifikace vrací u každé vady konkrétní místo — cestu k poli
 * (`/sim/rules/2/effects`), jméno pravidla a události (`rule warm: event
 * onTimerEnd`), nebo index kroku svědka. Věta pro model to místo **opisuje**,
 * protože „the world was rejected" mu neřekne, co přepsat, a stejný pokus se
 * v kole 2 zopakuje. Naměřeno v desátém ručním běhu vlny 1: tři ze čtyř
 * odmítnutí byly `DANGLING_REFERENCE`, tedy jméno bez deklarace — a to je vada,
 * kterou lze adresou ukázat přesně.
 *
 * ## Co tenhle modul dělat nesmí
 *
 * Nehádá význam. Nenavrhuje, jaké jméno měl model použít, ani nedomýšlí, co
 * porotce myslel — to je zakázané v Non-goals vlny a je to táž hranice, kterou
 * drží `../repair.ts`. Popisuje **vadu**, opravu píše model.
 */

import { TIER_POLICY, isTier, smallestTierFor } from '../../verify/tiers';
import { EXAMPLE_ONLY_IDENTIFIERS } from '../prompt';

import { isRecord } from './aabb';

import type { Rejection } from '../certify';
import type { TraceInput } from '../../sim/interpreter';

/**
 * Co k odmítnutí přidává emise sama.
 *
 * `Rejection` nese vadu, ne svět. Aby věta uměla říct „step 2 (player: enter →
 * arch)" místo „step 2", potřebuje svědka z emise; aby uměla doporučit tier,
 * potřebuje horizont, o který si emise řekla. Obojí je **volitelné** — bez
 * kontextu vyjde kratší, ale pořád použitelná věta.
 */
export interface RejectionContext {
  /** Kroky svědka z emise, na které ukazuje `Rejection.atStep`. */
  readonly witness?: readonly TraceInput[];
  /** Horizont, o který si emise řekla. Pro doporučení tieru u `NO_FIT`. */
  readonly horizonTicks?: number;
}

/** Jeden tah stopy. `none` je kanonický zástupce za nepřítomný cíl. */
export function describeStep(input: TraceInput): string {
  const target = input.target === undefined || input.target === 'none' ? null : input.target;
  return target === null ? `${input.actor}: ${input.actionId}` : `${input.actor}: ${input.actionId} → ${target}`;
}

/**
 * Vytáhne z emise to, co věta potřebuje navíc.
 *
 * Emise je v tomhle bodě `unknown` — je to odpověď modelu, která právě neprošla
 * certifikací, takže o jejím tvaru nic neplatí. Každý přístup je proto přes
 * strážce a rozbitá emise vydá prázdný kontext, ne výjimku.
 */
export function contextFromEmission(emission: unknown): RejectionContext {
  if (!isRecord(emission) || !isRecord(emission.sim) || !isRecord(emission.sim.witness)) return {};
  const witness = emission.sim.witness;

  const ops = Array.isArray(witness.ops) ? witness.ops.filter(isTraceInput) : null;
  const declared = typeof witness.H_cert === 'number' && Number.isInteger(witness.H_cert) ? witness.H_cert : null;
  const fromTier = typeof witness.tier === 'string' && isTier(witness.tier) ? TIER_POLICY[witness.tier].maxHorizonTicks : null;
  const horizonTicks = declared ?? fromTier;

  const context: { witness?: readonly TraceInput[]; horizonTicks?: number } = {};
  if (ops !== null) context.witness = ops;
  if (horizonTicks !== null) context.horizonTicks = horizonTicks;
  return context;
}

function isTraceInput(value: unknown): value is TraceInput {
  return (
    isRecord(value) &&
    typeof value.tick === 'number' &&
    typeof value.actor === 'string' &&
    typeof value.actionId === 'string'
  );
}

/**
 * Věta pro model. Vždycky neprázdná — i nad odmítnutím, jehož důvod tenhle
 * modul nezná, protože smyčka bez věty je smyčka, která se protočí naprázdno.
 */
export function rejectionSentence(rejection: Rejection, context: RejectionContext = {}): string {
  const what = describeFault(rejection, context);
  const todo = whatToDo(rejection, context);
  return `${what} ${todo}`;
}

/** Co je špatně — s adresou, kterou certifikace vrátila. */
function describeFault(rejection: Rejection, context: RejectionContext): string {
  const { stage, reason, detail, issues } = rejection;

  switch (stage) {
    case 'schema':
      // `issues` u schématu nese `/cesta/k/poli: zpráva`, tedy přesně tu adresu,
      // kterou model potřebuje. Když chybí, `detail` je pořád celá věta.
      return issues.length === 0
        ? `Your world was rejected before it could run: ${detail}.`
        : `Your world does not match the required shape at ${issues.slice(0, 3).join('; ')}.`;

    case 'references':
      // `detail` už je hotová anglická věta tvaru
      // "sim.rules[x].event.zone names no declared socket y".
      return `Your world uses a name it never declares: ${detail}.`;

    case 'lowering':
      return `The interpreter cannot run one of your rules: ${detail}.`;

    case 'look':
      return `The look part is invalid: ${detail}.`;

    case 'declined':
      return `You declined to write the sim part, so there is nothing to play: ${detail}.`;

    case 'request':
      return (
        'You copied the syntax example instead of writing a world for the request. ' +
        `None of these identifiers belong in your answer unless the request itself asks for them: ${EXAMPLE_ONLY_IDENTIFIERS.join(', ')}.`
      );

    case 'witness':
      return describeWitnessFault(reason, detail, rejection.atStep, context);
  }
}

function describeWitnessFault(
  reason: string,
  detail: string,
  atStep: number | null,
  context: RejectionContext,
): string {
  switch (reason) {
    case 'NO_WIN':
      return `The winning route you attached never reaches a win: ${detail}.`;

    case 'STEP_UNREACHABLE':
      return `The winning route you attached breaks${stepAddress(atStep, context)}: ${detail}.`;

    case 'INPUT_CAP':
      return `The winning route you attached has more moves than the tier allows: ${detail}.`;

    case 'RUNTIME_FAULT':
      return `Running your world hit a fault${stepAddress(atStep, context)}: ${detail}.`;

    case 'NO_FIT':
      return `The horizon your world asks for does not fit the tier it declares: ${detail}.`;

    default:
      // Dopředná kompatibilita: důvod z novější verze ověřovače nesmí vydat
      // prázdno. Kód se opíše doslova, takže z věty je pořád poznat, co padlo.
      return `The winning route you attached was rejected as ${reason}${detail === '' ? '' : `: ${detail}`}.`;
  }
}

/** ` at step 2 (player: enter → arch)`, nebo prázdno — nikdy `step null`. */
function stepAddress(atStep: number | null, context: RejectionContext): string {
  if (atStep === null) return '';
  const step = context.witness?.[atStep];
  return step === undefined ? ` at step ${String(atStep)}` : ` at step ${String(atStep)} (${describeStep(step)})`;
}

/** Co s tím má model udělat. Popis vady bez instrukce se čte jako stížnost. */
function whatToDo(rejection: Rejection, context: RejectionContext): string {
  if (rejection.stage === 'references')
    return 'Declare that name in the world first, or point the reference at a name you already declared. Do not invent a rule to hide it.';

  if (rejection.stage === 'lowering')
    return 'Use only the events, conditions and actions listed in the request, and give every one of them all of its required arguments.';

  if (rejection.stage === 'request')
    return 'Write a new world whose sockets, entities and rules come from the request itself.';

  if (rejection.stage === 'declined')
    return 'Write a playable sim part, or keep declining only if the request truly cannot be built from the listed events, conditions and actions.';

  if (rejection.stage === 'witness') return witnessTodo(rejection, context);

  return 'Fix exactly that field and send the whole world back, keeping everything that was already correct.';
}

function witnessTodo(rejection: Rejection, context: RejectionContext): string {
  switch (rejection.reason) {
    case 'NO_WIN':
      return 'Rewrite sim.witness.ops so the moves actually trigger the rule whose action is win, or fix the rule that was supposed to fire.';

    case 'STEP_UNREACHABLE':
      return 'Remove or reorder that move so every move is possible in the state the one before it leaves behind.';

    case 'INPUT_CAP':
      return 'Shorten sim.witness.ops, or declare a longer tier in sim.witness.tier.';

    case 'NO_FIT': {
      // Horizont bere z emise, ne z věty o odmítnutí: `detail` je text pro
      // člověka a jeho tvar není kontrakt. Regulární výraz zůstává jen jako
      // záloha pro odmítnutí, ke kterému se emise nedonesla.
      const parsed = rejection.detail.match(/horizon (\d+)/);
      const horizon = context.horizonTicks ?? (parsed === null ? null : Number(parsed[1]));
      const smallest = horizon === null ? null : smallestTierFor(horizon);
      return smallest === null
        ? `No tier is long enough for that horizon (the longest is ${String(TIER_POLICY.long.maxHorizonTicks)} ticks). Shorten sim.witness.H_cert and the route it certifies.`
        : `Declare sim.witness.tier as "${smallest}", or lower sim.witness.H_cert to fit the tier you already declared.`;
    }

    default:
      return 'Fix the winning route in sim.witness.ops and send the whole world back.';
  }
}
