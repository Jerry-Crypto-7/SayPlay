/** Diagnostic on OPEN round4 data. No held-out claim or changed scoring. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { verifyArcade } from '@/play/arcade/verify';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { extractIntent } from '@/play/intent/extract';
import type { IntentTriple } from '@/play/intent/contract';
import { scoreTriples, sameEnvironment } from '../p41/score';

it('reports current behavior on the opened round4 corpus without relabeling it', async () => {
  vi.stubEnv('PLAY_READER', 'off');
  const output = `evals/play/p42/round5-development-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  try {
    await loadRapier();
    const corpus = JSON.parse(readFileSync('evals/play/p42/round4/sentences.json', 'utf8')) as {
      groups: Record<string, { id: string; sentence: string; essential: IntentTriple[]; unsupported: boolean; hero: string | null; setting: string | null }[]>;
    };
    const rows = [];
    for (const label of corpus.groups['held-out']) {
      const start = performance.now();
      const draft = draftGameSpecWithMeta(label.sentence, 1);
      const milliseconds = performance.now() - start;
      const made = arcadeWorldOf(draft.spec, 1);
      if (!made.ok) throw new Error(made.issues.join('; '));
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      const honesty = await honestyForSpec(label.sentence, draft.spec, 1, made.world);
      rows.push({ id: label.id, sentence: label.sentence, milliseconds, built: verdict.publishEligible,
        intent: extractIntent(label.sentence), spec: draft.spec, witnesses: verdict.witnesses,
        score: scoreTriples(label.essential, verdict.witnesses, honesty?.unmet ?? [], {
          unsupported: label.unsupported, visibleAdmission: Boolean(honesty?.reason.trim()),
        }), honesty,
        hero: label.hero === null || draft.spec.roles.some(r => r.kind === 'player' && r.label === label.hero),
        environment: label.setting === null || sameEnvironment(draft.spec.theme.setting, label.setting),
      });
    }
    const summary = { measured: rows.length, built: rows.filter(r => r.built).length,
      preserved: rows.filter(r => r.score.preserved).length,
      silent: rows.reduce((n, r) => n + r.score.silent.length, 0),
      hero: rows.filter(r => r.hero).length, environment: rows.filter(r => r.environment).length };
    writeFileSync(output, JSON.stringify({ note: 'Open development data; original round4 labels and scorer unchanged, including documented fly/flap annotation conflict.', summary, rows }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, summary }));
    expect(rows).toHaveLength(64);
    expect(summary.built).toBe(64);
  } finally { vi.unstubAllEnvs(); }
});
