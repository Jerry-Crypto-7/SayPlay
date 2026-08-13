/**
 * Sestavení upstream požadavku pro emisi celého světa.
 *
 * Soubor je **čistý** — žádné čtení disku, žádná síť. Slovník dostává zvenčí
 * a je to schválně: gramatika je zmrazená (`evals/frozen/protocol.v1.json`),
 * takže se sem nesmí opsat. Kopie by se rozešla se zmrazeným souborem tiše, a
 * prompt, který jmenuje jiné akce než kontrakt, měří něco jiného, než co se
 * pak validuje.
 *
 * `DESIGN-BOOK.md` §5: model nikdy nepíše control flow. Systémová zpráva proto
 * jmenuje deklarativní slovník a **výslovně zakazuje** cokoli jiného; kdyby
 * model směl vydat kód, celá garance §6 padá, protože verifikátor by
 * neverifikoval graf, ale program.
 */

/** Slovník ze zmrazeného protokolu. Čte ho `./client`, sem se jen předává. */
export interface Grammar {
  readonly surfaceEvents: readonly string[];
  readonly conditions: readonly string[];
  readonly actions: readonly string[];
  /** `sim` je uvnitř hashe, `look` mimo — obojí doslova ze zmrazeného protokolu. */
  readonly simFields: readonly string[];
  readonly lookFields: readonly string[];
}

/** Co se doopravdy poslalo nahoru. Zaznamenává se, aby byl běh auditovatelný. */
export interface UpstreamRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
}

/**
 * Model, proti kterému P1 měří.
 *
 * V Phase 3 se **nevolá** — `./client` běží v režimu záznamu proti
 * `evals/frozen/responses/`. Jméno je tu proto, že se zaznamenává do
 * požadavku, a záznam bez jména modelu by po HALT bráně nešlo srovnat s živým
 * během (T18).
 */
export const EMISSION_MODEL = 'claude-opus-5';

export function buildEmissionRequest(prompt: string, grammar: Grammar): UpstreamRequest {
  const system = [
    'You emit a declarative world graph. You never write code, control flow, or expressions to be evaluated.',
    '',
    'Answer with a single JSON object and nothing else. Its top-level fields are exactly:',
    'irVersion, simRevision, lookRevision, sim, look.',
    '',
    'If the request cannot be expressed in the vocabulary below, decline instead of inventing one:',
    'answer with the same object, sim set to null, and one extra field simOutcome: "NO_FIT".',
    'look stays REQUIRED in that case — the refusal covers sim only, and the scene is built either way.',
    '',
    `sim carries: ${grammar.simFields.join(', ')}. It is inside the state hash.`,
    `look carries: ${grammar.lookFields.join(', ')}. It is outside the state hash, and its only`,
    'permitted link into sim is an entity stableId.',
    '',
    `Rules fire on these events: ${grammar.surfaceEvents.join(', ')}.`,
    `Guards use these conditions: ${grammar.conditions.join(', ')}.`,
    `Effects use these actions: ${grammar.actions.join(', ')}.`,
    'Nothing outside those three lists exists. Every counter, timer and inventory slot is bounded.',
    '',
    'sim.witness is a finite admissible input trace in canonical sim actions. It must reach win()',
    'inside the horizon of the tier it asks for. You may request a tier; you may not declare the',
    'horizon — the system does that.',
  ].join('\n');

  // Text promptu jde do zprávy **doslova**. AC T13 se ptá právě na tohle:
  // zaznamenaný požadavek musí prompt obsahovat, jinak se nedá prokázat, že
  // odpověď patří k němu a ne k jinému běhu.
  const user = `Build a playable world for this request:\n\n${prompt}`;

  return { model: EMISSION_MODEL, system, user };
}
