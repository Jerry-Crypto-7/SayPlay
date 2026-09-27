/**
 * Předpečená panoramata pro prostředí, která knihovna arkády nezná (P30A T4).
 *
 * Dnes takové prostředí dogeneruje služba na autorově PC (`src/app/api/play/_env.ts`).
 * Bez ní – nasazené demo s vypnutým PC – dostane hra nejbližší panorama ze
 * statické sady `public/play/env/`, kterou předpekl `scripts/cloud/bake-panoramas.mjs`.
 *
 * Výběr: panorama, jehož slova (se synonymy) věta prostředí jmenuje nejčastěji;
 * při shodě to dřív v `baked.json`. Žádné slovo = `null` a hra zůstává u scény
 * knihovny. Bez náhody a bez hodin, takže táž věta dá vždy totéž panorama.
 */

import manifest from './baked.json';

export interface BakedEnv {
  readonly id: string;
  readonly prompt: string;
  readonly words: readonly string[];
  /** Průměrná barva pásu u horizontu – barva mlhy, jako u knihovny. */
  readonly horizon: string;
  /** Plné panorama 2048×1024 a náhled 512×256 z `public/`. */
  readonly url: string;
  readonly low: string;
}

interface ManifestEntry {
  readonly id: string;
  readonly prompt: string;
  readonly words: readonly string[];
  readonly horizon?: string;
}

/** Jen upečená: položka bez `horizon` ještě nemá soubory a vybrat se nesmí. */
export const BAKED_ENVS: readonly BakedEnv[] = (manifest.entries as readonly ManifestEntry[]).flatMap((entry) =>
  entry.horizon === undefined ? [] : [{ ...entry, horizon: entry.horizon, url: `/play/env/${entry.id}.webp`, low: `/play/env/${entry.id}-low.webp` }],
);

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Slovo i odvozený tvar (pyramid → pyramids, swing → swings) – totéž pravidlo jako štítky knihovny. */
const wordPattern = (word: string) => new RegExp(`\\b${escape(word.replace(/e$/, ''))}(?:e|es|s|y|ies)?\\b`);

export function nearestBaked(setting: string, envs: readonly BakedEnv[] = BAKED_ENVS): BakedEnv | null {
  const text = setting.toLowerCase();
  let best: BakedEnv | null = null;
  let bestHits = 0;
  for (const env of envs) {
    const hits = env.words.filter((word) => wordPattern(word).test(text)).length;
    if (hits > bestHits) {
      best = env;
      bestHits = hits;
    }
  }
  return best;
}
