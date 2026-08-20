/**
 * Emise v prohlížeči — věta dovnitř, certifikovaný verdikt ven.
 *
 * ## Tentýž verdikt jako ze serveru, ne jeho obdoba
 *
 * Souzení dělá `../certify.ts`, tedy **týž kód**, který stojí za `POST
 * /api/emit`. Prohlížeč proto nemůže přijmout svět, který by server odmítl:
 * není kde se rozejít. Vlastní je tu jen zdroj emise — místo zaznamenané
 * odpovědi ze zmrazeného korpusu ji píše model běžící na WebGPU.
 *
 * ## Rozpoznávač vět je před modelem, ne za ním
 *
 * `recognize` je deterministická cesta z T7. Když větu pozná, model se
 * **nespustí vůbec** — je to rychlejší, levnější a hlavně to nezávisí na tom,
 * jestli model zrovna udrží tvar. Naměřená hodnota `schemaValid` z T5 říká, že
 * se na model spolehnout nedá (`evals/local-model/decision.md`), takže tohle
 * pořadí není optimalizace, ale hlavní cesta.
 *
 * ## Gramatika se bere ze zmrazeného protokolu
 *
 * Slovník událostí, podmínek a akcí čte server z `evals/frozen/protocol.v1.json`.
 * Prohlížeč si ho nemůže přečíst z disku, ale opsat ho do konstanty by znamenalo
 * druhý slovník, který se s tím prvním rozejde — a model by pak dostal jiná
 * pravidla, než jakými se jeho odpověď soudí. Soubor se proto importuje a
 * vytáhne se z něj totéž, co vytahuje `frozenGrammar()`.
 */

import protocol from '../../../evals/frozen/protocol.v1.json';
import { certifySteps, type ProgressSink, type Verdict } from '../certify';
import { buildEmissionRequest, type Grammar } from '../prompt';

import type { ChatEngine } from './engine';

export type { Verdict } from '../certify';

/**
 * Výsledek prohlížečové emise.
 *
 * Má tytéž dvě větve jako serverová cesta (`EmissionOutcome` v
 * `src/app/api/emit/chain.ts`) a **sdílí s ní `Verdict`**: rozbité prostředí
 * není verdikt o světě a nesmí se do něj počítat.
 */
export type LocalOutcome =
  /** Model se nespustil nebo spadl. O takovém běhu se nesmí nic skórovat. */
  | { readonly kind: 'unavailable'; readonly detail: string }
  | Verdict;

/** Slovník ze zmrazeného protokolu, týž, jaký vydává `frozenGrammar()` na serveru. */
export function localGrammar(): Grammar {
  return {
    surfaceEvents: protocol.grammar.surfaceEvents,
    conditions: protocol.grammar.conditions,
    actions: protocol.grammar.actions,
    simFields: protocol.worldDoc.sim.fields,
    lookFields: protocol.worldDoc.look.fields,
  };
}

/**
 * Deterministický rozpoznávač tvarů vět (T7). Vrátí tělo emise, nebo `null`,
 * když větu nezná — `null` není chyba, je to předání slova modelu.
 */
export type Recognizer = (sentence: string) => unknown | null;

export interface LocalEmitInput {
  readonly sentence: string;
  readonly engine: ChatEngine;
  readonly recognize?: Recognizer;
  readonly onProgress?: ProgressSink;
}

/**
 * Prožene větu celou cestou: rozpoznávač nebo model, pak certifikace.
 *
 * `promptId` verdiktu nese samotnou větu. Serverová cesta sem dává id
 * zmrazeného promptu, protože jiné nemá; tady je věta to jediné, čím se vstup
 * dá pojmenovat, a ve stopě je pak vidět, co porotce napsal.
 */
export async function emitLocally(input: LocalEmitInput): Promise<LocalOutcome> {
  // `buildEmissionRequest()` píše do požadavku serverový model (`EMISSION_MODEL`),
  // protože ho psal server. Tady se prohodí za váhy, které doopravdy odpovídaly —
  // jinak by verdikt připsal svět modelu, který se ho ani nedotkl.
  const upstream = { ...buildEmissionRequest(input.sentence, localGrammar()), model: input.engine.modelId };

  const recognized = input.recognize?.(input.sentence) ?? null;
  let body: unknown;
  let provenance: Record<string, unknown>;

  if (recognized !== null) {
    body = recognized;
    provenance = { source: 'shapes' };
  } else {
    let completion;
    try {
      completion = await input.engine.complete(upstream.system, upstream.user);
    } catch (thrown) {
      const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
      return { kind: 'unavailable', detail: message };
    }
    try {
      body = JSON.parse(stripThinking(completion.raw));
    } catch {
      // Nerozpársovatelná odpověď **je** verdikt o emisi, ne rozbité prostředí:
      // model odpověděl, jen ne JSONem. Certifikace ho odmítne jako `NOT_A_DOCUMENT`.
      body = completion.raw;
    }
    provenance = { source: 'model', model: upstream.model, finishReason: completion.finishReason };
  }

  const steps = certifySteps({ promptId: input.sentence, upstream, provenance, body });
  let next = steps.next();
  while (!next.done) {
    input.onProgress?.(next.value);
    next = steps.next();
  }
  return next.value;
}

/**
 * Qwen3 umí odpověď uvést blokem `<think>`. Šablona ho vkládá i tam, kde je
 * prázdný, takže by `JSON.parse` spadl na uvozujícím textu a emise, která tvar
 * udržela, by se odmítla. Blok se proto odřízne, a jen on — cokoli jiného před
 * `{` je skutečná vada odpovědi a nechá se být.
 */
export function stripThinking(raw: string): string {
  return raw.replace(/^\s*<think>[\s\S]*?<\/think>/, '').trim();
}
