/**
 * **Kolik vět korpusu dostane aspoň jednu hmotu ze slov, bez modelu (P21 T4).**
 *
 * `wordMassing()` je uzavřený slovník, ne rozpoznávač; jediné, co o něm jde
 * poctivě tvrdit, je podíl vět, nad kterými vůbec něco postaví. Měří se nad
 * všemi 120 větami `prompts.json` a hlásí po kategoriích; brána stojí nad
 * podílem **mimo** `unsupported`, `safety` a `abstract` — tam se blok
 * neslibuje (věta žádá to, co produkt neumí, nebo to, co nesmí, nebo tvar,
 * který slovník nemá jak pojmenovat). Práh je 0,8 z AC úlohy.
 *
 * Artefakt je deterministický (žádné razítko času), takže opakovaný běh bez
 * změny slovníku nehne jediným řádkem. Lék na podíl pod prahem je rozšířit
 * slovník z citátů `oracles.json`, ne uvolnit pravidla.
 *
 *     npx vitest run --config vitest.measure.mts evals/worldstream/gauntlet/word-massing.measure.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { wordMassing } from '@/scene/word-massing';

const PROMPTS_FILE = fileURLToPath(new URL('./prompts.json', import.meta.url));
const REPORT_FILE = fileURLToPath(new URL('./word-massing.json', import.meta.url));

/** Kategorie, ve kterých se blok neslibuje a do brány nepočítají. */
const EXCLUDED = ['unsupported', 'safety', 'abstract'] as const;
const THRESHOLD = 0.8;

interface PromptFile { readonly prompts: readonly { readonly id: string; readonly category: string; readonly sentence: string }[] }

describe('word massing over the gauntlet corpus', () => {
  it('writes the share of sentences with at least one block, per category and overall outside the excluded ones', () => {
    const { prompts } = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8')) as PromptFile;
    const byCategory = new Map<string, { total: number; withBlocks: number; blocks: number }>();
    const empty: string[] = [];
    const rows = prompts.map((prompt) => {
      const guess = wordMassing(prompt.sentence, { sessionSeed: 4021 });
      const labels = guess === null ? [] : [...new Set(guess.objects.map((object) => object.label))];
      const blocks = guess?.objects.length ?? 0;
      const bucket = byCategory.get(prompt.category) ?? { total: 0, withBlocks: 0, blocks: 0 };
      bucket.total += 1; bucket.blocks += blocks; if (blocks > 0) bucket.withBlocks += 1; else empty.push(prompt.id);
      byCategory.set(prompt.category, bucket);
      return { id: prompt.id, category: prompt.category, blocks, labels };
    });

    const gated = rows.filter((row) => !(EXCLUDED as readonly string[]).includes(row.category));
    const overallShare = gated.filter((row) => row.blocks > 0).length / gated.length;
    const categories = Object.fromEntries([...byCategory].map(([category, bucket]) => [category,
      { total: bucket.total, withBlocks: bucket.withBlocks, share: Number((bucket.withBlocks / bucket.total).toFixed(3)),
        blocksPerSentence: Number((bucket.blocks / bucket.total).toFixed(2)), gated: !(EXCLUDED as readonly string[]).includes(category) }]));

    writeFileSync(REPORT_FILE, `${JSON.stringify({
      source: 'evals/worldstream/gauntlet/prompts.json', measure: 'wordMassing(sentence, {sessionSeed: 4021}) — model-free lexicon',
      threshold: THRESHOLD, excluded: EXCLUDED, sentences: prompts.length, gatedSentences: gated.length,
      overallShare: Number(overallShare.toFixed(3)), categories, empty, rows,
    }, null, 2)}\n`);

    expect(overallShare, `share of gated sentences with ≥ 1 block is ${overallShare.toFixed(3)} < ${String(THRESHOLD)}; empty: ${empty.join(', ')}`)
      .toBeGreaterThanOrEqual(THRESHOLD);
  });
});
