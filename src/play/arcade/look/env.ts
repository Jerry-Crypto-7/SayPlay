/**
 * Panorama za hrou podle `theme.setting` (P29C T4). Knihovna je
 * `env-catalog.json` (píše `ops/env/batch.py catalog`); každé panorama nese
 * štítky – slova prostředí, která ukazuje.
 *
 * Výběr: panorama, které nese nejvíc slov prostředí („snowy forest“ → sníh
 * i les, ne jen sníh); při shodě to, jehož look vybrala scéna. Když se nechytí
 * žádné slovo, jedna ze tří variant `lookOf(theme)`. Mezi rovnocennými
 * rozhoduje seed, takže tatáž hra má vždy totéž pozadí.
 *
 * Bez runtime importů mimo JSON – jako `index.ts` ho čte i skript měření.
 */

import catalog from './env-catalog.json';
import { type LookId, lookOf } from './index';

export interface EnvEntry {
  readonly id: string;
  readonly look: LookId | null;
  readonly tags: readonly string[];
  readonly prompt: string;
  /** Plné panorama 2048×1024 a náhled 512×256 z `public/`. */
  readonly url: string;
  readonly low: string;
  /** Průměrná barva pásu u horizontu – barva mlhy, aby přechod z ploché barvy neskočil. */
  readonly horizon: string;
  readonly license: string;
}

export const ENV_ENTRIES: readonly EnvEntry[] = catalog.entries as readonly EnvEntry[];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Štítek ve větě i v odvozeném tvaru: snow → snowy, ice → icy, tree → trees. */
function tagPattern(tag: string): RegExp {
  return new RegExp(`\\b${escape(tag.replace(/e$/, ''))}(?:e|es|s|y|ies)?\\b`);
}

const PATTERNS: ReadonlyMap<string, RegExp> = new Map(ENV_ENTRIES.flatMap((entry) => entry.tags).map((tag) => [tag, tagPattern(tag)]));

/** Štítky panoramatu, které věta prostředí jmenuje. */
export function envTagsIn(entry: EnvEntry, setting: string): string[] {
  const text = setting.toLowerCase();
  return entry.tags.filter((tag) => PATTERNS.get(tag)!.test(text));
}

/** Seed výběru z id hry (FNV-1a): tatáž hra má vždy totéž pozadí, různé hry téhož místa se liší. */
export function seedOf(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0;
  return hash;
}

const pick = <T>(items: readonly T[], seed: number): T => items[((Math.floor(seed) % items.length) + items.length) % items.length];

export function envFor(theme: { readonly setting: string; readonly mood: string; readonly look?: LookId }, seed: number): EnvEntry {
  const look = lookOf(theme);
  let best = 0;
  let found: EnvEntry[] = [];
  for (const entry of ENV_ENTRIES) {
    const score = envTagsIn(entry, theme.setting).length;
    if (score > best) [best, found] = [score, [entry]];
    else if (score === best && score > 0) found.push(entry);
  }
  if (found.length > 0) {
    const sameLook = found.filter((entry) => entry.look === look);
    return pick(sameLook.length > 0 ? sameLook : found, seed);
  }
  return pick(
    ENV_ENTRIES.filter((entry) => entry.look === look),
    seed,
  );
}
