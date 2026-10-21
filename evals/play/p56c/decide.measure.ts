/**
 * „Řetěz, nebo jedna hra“ na dev sadě (P56C T8) → `decide.md`: rozdělení po rodinách a větev pravidla u každé věty.
 * Práh `GENERIC_MARGIN` se ladí jen tady; zapečetěná sada se neotvírá.
 *
 * `npx vitest run --config vitest.measure.mts evals/play/p56c/decide.measure.ts`
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { chainReasons, GENERIC_MARGIN } from '../../../src/play/chain/decide';
import { readForChain } from '../../../src/play/chain/read';
import { classifyGenre } from '../../../src/play/genre/classify';

interface DevSentence {
  readonly id: string;
  readonly family: string;
  readonly text: string;
}

const DIR = join(process.cwd(), 'evals/play/p56c');
const { sentences } = JSON.parse(readFileSync(join(DIR, 'dev.json'), 'utf8')) as { sentences: DevSentence[] };

it('splits the dev set into chains and single games', () => {
  const rows = sentences.map((sentence) => {
    const ranking = classifyGenre(sentence.text, null);
    const [top, second] = ranking.ranked;
    return {
      ...sentence,
      reasons: chainReasons(sentence.text, readForChain(sentence.text, null), ranking),
      top: `${top!.genre}.${top!.mode} ${top!.score} (náskok ${top!.score - (second?.score ?? 0)})`,
    };
  });
  const chains = (families: readonly string[]): string => {
    const family = rows.filter((row) => families.includes(row.family));
    return `${family.filter((row) => row.reasons.length > 0).length}/${family.length}`;
  };
  const singles = rows.filter((row) => row.family === 'single_verb');

  const lines = [
    '# P56C T8 – řetěz, nebo jedna hra (dev)',
    '',
    `Změřeno ${new Date().toISOString().slice(0, 10)} \`decide.measure.ts\`, čtení slovníkem, \`classifyGenre(věta, null)\`. Práh náskoku obecné buňky \`GENERIC_MARGIN\` = ${GENERIC_MARGIN}: na dev leží mezi „a goth teenage ghost with a skateboard“ (\`runner.default\`, náskok 2 → řetěz) a „steer a hot air balloon…“, „catch snowflakes…“, „herd the runaway sheep…“ (obecná buňka, náskok 4 → jedna hra). Platí každá hodnota 3–4; zapečetěná sada ho potvrdí nebo vyvrátí.`,
    '',
    '| Rodina | AC | Výsledek |',
    '|---|---|---|',
    `| \`multi_verb\` → řetěz | ≥ 10/12 | ${chains(['multi_verb'])} |`,
    `| \`no_verb\` + \`world_only\` → řetěz | ≥ 15/18 | ${chains(['no_verb', 'world_only'])} |`,
    `| \`single_verb\` → jedna hra | ≥ 8/10 | ${singles.filter((row) => row.reasons.length === 0).length}/${singles.length} |`,
    '',
    '| id | rodina | rozhodnutí | větve | první buňka |',
    '|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.id} | ${row.family} | ${row.reasons.length > 0 ? 'řetěz' : 'jedna hra'} | ${row.reasons.join(', ') || '–'} | ${row.top} |`),
    '',
  ];
  writeFileSync(join(DIR, 'decide.md'), `${lines.join('\n')}\n`);
  expect(rows.length).toBe(40);
});
