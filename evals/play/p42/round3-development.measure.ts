/** All previously opened data only; never reads round3/sentences.json. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import type { IntentTriple } from '@/play/intent/contract';
import { scoreTriples } from '../p41/score';

it('all 367 opened development sentences publish without silent omissions', async () => {
  vi.stubEnv('PLAY_READER', 'off');
  try {
    await loadRapier();
    const corpus = JSON.parse(readFileSync('evals/play/p42/round2/sentences.json', 'utf8')) as {
      groups: Record<string, { id: string; sentence: string; essential: IntentTriple[]; unsupported: boolean }[]>;
    };
    const rows = [];
    for (const [group, labels] of Object.entries(corpus.groups)) for (const label of labels) {
      try {
        const draft = draftGameSpecWithMeta(label.sentence, 1);
        const made = arcadeWorldOf(draft.spec, 1);
        if (!made.ok) throw new Error(made.issues.join('; '));
        const verdict = verifyArcade(made.world, undefined, made.roleBindings);
        const honesty = await honestyForSpec(label.sentence, draft.spec, 1, made.world);
        rows.push({ group, id: label.id, sentence: label.sentence, built: verdict.publishEligible,
          score: scoreTriples(label.essential, verdict.witnesses, honesty?.unmet ?? [], {
            unsupported: label.unsupported, visibleAdmission: Boolean(honesty?.reason.trim()),
          }), honesty });
      } catch (error) { rows.push({ group, id: label.id, sentence: label.sentence, built: false, error: String(error) }); }
    }
    const summary = { measured: rows.length, built: rows.filter(row => row.built).length,
      preserved: rows.filter(row => row.built && row.score?.preserved).length,
      silent: rows.reduce((sum, row) => sum + (row.score?.silent.length ?? 0), 0) };
    writeFileSync('evals/play/p42/round3-development.json', JSON.stringify({ summary, rows }, null, 2) + '\n');
    console.log(JSON.stringify(summary));
    expect(summary.measured).toBe(367);
    expect(summary.built).toBe(367);
    expect(summary.silent).toBe(0);
  } finally { vi.unstubAllEnvs(); }
});

