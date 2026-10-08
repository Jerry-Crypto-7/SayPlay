/**
 * P44C T1/T13: výchozí čísla po větách před otevřeným slovníkem a týž běh po něm.
 *
 *   npx vitest run --config vitest.measure.mts evals/play/p44c/baseline.measure.ts
 *   P44C_AFTER=1 npx vitest run --config vitest.measure.mts evals/play/p44c/baseline.measure.ts
 *
 * Bez `P44C_AFTER` zapíše `baseline.json`, s ním `after-dev.json`. Tři otevřené sady:
 * - `p42`: vývojové měření P42 (logika `../p42/round6-development.measure.ts` nad
 *   `round5/sentences.json` → `held-out`), skóre `scoreTriples`; výstup P42 nepřepisuje.
 * - `p37a` (`dev-150`) a `p30dev`: `verbRead` a `why` slovesa z `offlineChain`.
 * U každé věty je i `intent` z `extractIntent`, aby T7 mohla porovnat `PLAY_VOCAB=off`
 * bajtově proti stavu před P44C. Zapečetěné sady se tu nečtou.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { extractIntent } from '@/play/intent/extract';
import type { IntentTriple } from '@/play/intent/contract';
import { offlineChain } from '../../../scripts/play-fidelity.mjs';
import { scoreTriples } from '../p41/score';

type Label = { id: string; sentence: string; essential: IntentTriple[]; unsupported: boolean };
type Open = { id: string; text: string; group?: string; tags?: string[] };

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

it('records per-sentence baseline on the open dev sets', async () => {
  const after = process.env.P44C_AFTER === '1';
  vi.stubEnv('PLAY_READER', 'off');
  try {
    await loadRapier();
    const corpus = readJson('evals/play/p42/round5/sentences.json') as { groups: Record<string, Label[]> };
    const p42 = [];
    for (const label of corpus.groups['held-out']!) {
      const draft = draftGameSpecWithMeta(label.sentence, 1);
      const made = arcadeWorldOf(draft.spec, 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      const honesty = await honestyForSpec(label.sentence, draft.spec, 1, made.world);
      const score = scoreTriples(label.essential, verdict.witnesses, honesty?.unmet ?? [], {
        unsupported: label.unsupported, visibleAdmission: Boolean(honesty?.reason.trim()),
      });
      p42.push({ id: label.id, sentence: label.sentence, unsupported: label.unsupported, preserved: score.preserved,
        silent: score.silent, honesty: honesty === null ? null : { kind: honesty.kind, reason: honesty.reason },
        intent: extractIntent(label.sentence) });
    }
    const open = (path: string) => {
      const sentences = (readJson(path) as { sentences: (Open & Parameters<typeof offlineChain>[0][number])[] }).sentences;
      const chain = new Map(offlineChain(sentences).sentences.map((row) => [row.id, row]));
      return sentences.map((sentence) => {
        // Offline řetěz dá u slovesa `ok` nebo důvod ztráty; `not-recognized` vzniká jen se soudcem klipu.
        const why: string | null = chain.get(sentence.id)!.items.find((item) => item.slot === 'verb')?.why ?? null;
        return { id: sentence.id, sentence: sentence.text, group: sentence.group ?? null, tags: sentence.tags ?? [],
          verbWhy: why, verbRead: why === 'ok', intent: extractIntent(sentence.text) };
      });
    };
    const p37a = open('evals/play/p37a/dev-150.json');
    const p30dev = open('evals/play/p30/dev.json');
    const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const summary = {
      p42: { sentences: p42.length, preserved: p42.filter((row) => row.preserved).length },
      p37a: { sentences: p37a.length, verbRead: p37a.filter((row) => row.verbRead).length },
      p30dev: { sentences: p30dev.length, verbRead: p30dev.filter((row) => row.verbRead).length },
    };
    const output = after ? 'evals/play/p44c/after-dev.json' : 'evals/play/p44c/baseline.json';
    writeFileSync(output, JSON.stringify({ commit, vocab: process.env.PLAY_VOCAB ?? 'default', summary, sets: { p42, p37a, p30dev } }, null, 2) + '\n');
    console.log(JSON.stringify({ output, summary }));
    expect(p42).toHaveLength(64);
    expect(p37a).toHaveLength(150);
    expect(p30dev).toHaveLength(60);
  } finally { vi.unstubAllEnvs(); }
});
