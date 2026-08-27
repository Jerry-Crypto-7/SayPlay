/**
 * Řetěz emise nad **zmrazeným korpusem** — pro `POST /api/emit` i pro jeho SSE variantu.
 *
 * Sem se to přestěhovalo, protože kanál s průběhem potřebuje tentýž řetěz
 * s odbočkou po každém kroku. Druhá kopie by byla druhé místo, kde se dá pořadí
 * změnit — a rozdíl mezi nimi by se projevil až tím, že by průběh popisoval
 * něco jiného, než co endpoint doopravdy dělá.
 *
 * Samotné souzení emise tu **není**: od P11 T6 ho drží `src/model/certify.ts`,
 * protože je musí volat i prohlížečová cesta, která `node:fs` nemá. Tady zbývá
 * jen to, co je vlastní zmrazenému zdroji — vyzvednout prompt, gramatiku a
 * zaznamenanou odpověď.
 *
 * `route.ts` si nechává čtení těla a překlad na `Response`; tady je jen verdikt.
 */

import { certifySteps, type EmitPhase, type Verdict } from '../../../model/certify';
import { emitWorld, frozenGrammar, frozenPrompt, type ClientFailure } from '../../../model/client';
import { buildEmissionRequest } from '../../../model/prompt';

export type { EmitPhase, ProgressSink } from '../../../model/certify';

export type EmissionOutcome =
  /** Rozbité prostředí, ne verdikt. O takovém běhu se nesmí nic skórovat. */
  | { readonly kind: 'unavailable'; readonly failure: ClientFailure }
  | { readonly kind: 'unknown-prompt' }
  | Verdict;

/**
 * Spustí celý řetěz nad zmrazeným promptem.
 *
 * Je to **generátor**, ne funkce s callbackem, a je to ten rozdíl, kvůli
 * kterému má kanál s průběhem vůbec smysl. Řetěz je čistě synchronní; kdyby
 * fáze jen volaly callback, doběhly by všechny dřív, než by první rámec opustil
 * socket, a průběh by dorazil naráz s verdiktem. Na `yield` se dá počkat, takže
 * `stream/route.ts` mezi kroky pustí smyčku událostí a rámec skutečně odejde.
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

  return yield* certifySteps({ promptId, upstream, provenance: emission.provenance, body: emission.body });
}

/**
 * Řetěz doběhnutý synchronně. `/api/emit` průběh nikoho nezajímá, takže se
 * generátor jen protočí; `onProgress` je tu pro volajícího, který ho chce
 * a nepotřebuje mezi kroky uvolnit smyčku událostí.
 */
export function runEmission(promptId: string, onProgress?: (phase: EmitPhase) => void): EmissionOutcome {
  const steps = emissionSteps(promptId);
  let next = steps.next();
  while (!next.done) {
    onProgress?.(next.value);
    next = steps.next();
  }
  return next.value;
}
