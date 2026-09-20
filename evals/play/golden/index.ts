/**
 * Zlatý korpus PLAY (P23-B T1): 40 anglických vět, na kterých se měří
 * režisér – návrh ze slov (`src/play/draft`), prompt, a jednou i živý model.
 *
 * Patnáct řádků je doslova z balíčku GPT (`docs/play/pack/golden_prompts.csv`);
 * `bucket` nese jeho původní jméno (`hazard_platforming`), `expectArchetype`
 * už jméno z registru (`hazard_crossing`), protože runtime je mřížkový a skok
 * nemá. Zbytek doplňuje každý archetyp na čtyři věty; osm vět bez archetypu
 * (`ambiguity`, `contradiction`, `scale`, `remix`, `count`, `relation`) drží
 * hrany, na kterých se režisér nesmí rozbít.
 */

import type { ArchetypeId } from '@/play/registry';

import corpus from './prompts.json';

export const GOLDEN_SCHEMA = 'play-golden-v1' as const;

export interface GoldenPrompt {
  readonly id: string;
  /** Kbelík z balíčku – archetyp, nebo druh hrany (`ambiguity`, `remix`, …). */
  readonly bucket: string;
  readonly prompt: string;
  /** Co musí hra prokazatelně mít (`must_test` z CSV, rozdělené `;`). */
  readonly mustTest: readonly string[];
  /** Archetyp, který má režisér trefit; `null` u vět bez jednoho správného. */
  readonly expectArchetype: ArchetypeId | null;
}

/** Celý korpus v pořadí souboru. Věty s `expectArchetype` jdou první. */
export function goldenPrompts(): readonly GoldenPrompt[] {
  return corpus.prompts as readonly GoldenPrompt[];
}

/** Osm bucketových vět balíčku – jedna na archetyp, ty měří živý běh (T9). */
export function packBucketPrompts(): readonly GoldenPrompt[] {
  return goldenPrompts().filter((entry) => entry.id.endsWith('-1') && entry.expectArchetype !== null);
}
