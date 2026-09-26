/**
 * Kolik vět korpusu věrnosti dostane pozadí, které ukazuje jejich prostředí (P29C T4).
 *
 *   npx vitest run --config vitest.measure.mts evals/play/env/coverage.measure.ts
 *
 * Theme píše návrh ze slov (`draftGameSpec`) – týž, který hra dostane bez
 * modelu –, panorama vybírá `envFor`, tedy funkce, kterou jeviště volá. Shoda
 * = některý štítek vybraného panoramatu je slovem prostředí z checklistu věty.
 * Věty bez prostředí v checklistu jsou v seznamu, ale do podílu se nepočítají.
 */

import { writeFileSync } from 'node:fs';

import { it } from 'vitest';

import { envFor } from '@/play/arcade/look/env';
import { draftGameSpec } from '@/play/draft';

import fidelity from '../fidelity/corpus.json';
import judge from '../fidelity/judge-10.json';

interface Row {
  readonly id: string;
  readonly text: string;
  readonly setting: string;
  readonly env: string;
  readonly tags: readonly string[];
  /** Slova prostředí z checklistu; prázdné = věta prostředí nejmenuje. */
  readonly asked: readonly string[];
  readonly shown: boolean;
}

const shows = (tags: readonly string[], words: readonly string[]) =>
  tags.some((tag) => words.some((word) => tag === word || tag.includes(word) || word.includes(tag)));

export function measureEnvCoverage() {
  const sentences: Row[] = [...fidelity.sentences, ...judge.sentences].map((sentence) => {
    const { theme } = draftGameSpec(sentence.text);
    const env = envFor(theme, 1);
    const asked = sentence.checklist.filter((item) => item.slot === 'setting').flatMap((item) => item.match);
    return { id: sentence.id, text: sentence.text, setting: theme.setting, env: env.id, tags: env.tags, asked, shown: asked.length > 0 && shows(env.tags, asked) };
  });
  const scored = sentences.filter((row) => row.asked.length > 0);
  const hits = scored.filter((row) => row.shown).length;
  return { about: 'P29C T4: envFor over the 30 + 10 fidelity sentences, theme from draftGameSpec, seed 1.', share: Number((hits / scored.length).toFixed(3)), hits, scored: scored.length, sentences };
}

it('writes evals/play/env/coverage.json', () => {
  writeFileSync('evals/play/env/coverage.json', `${JSON.stringify(measureEnvCoverage(), null, 1)}\n`);
});
