/**
 * P44C T14: jediné otevření zapečetěné sady, `PLAY_VOCAB=off` i `on` nad týmž commitem.
 *
 *   P44C_OPEN_SEALED_ONCE=1 npx vitest run --config vitest.measure.mts evals/play/p44c/sealed.measure.ts -- --open-sealed-once
 *
 * Sadu čte jen `openSealedOnce` (pečeť `sealed-opened.json`, druhé spuštění skončí chybou). Vitest
 * argumenty za `--` do procesu testu nepředá, proto přepínač nese i proměnná – obojí znamená totéž.
 *
 * - **U** / **F1**: podíl vět `unknown-verb` / `fantasy`, jejichž trojice hra hraje (svědek, `scoreTriples`).
 * - **F2**: podíl fantasy podstatných jmen z trojic, která hra kreslí modelem (`offlineChain`, `why === 'ok'`).
 * - **N**: věty `non-game` bez namapovaného slovesa (`mapped`).
 * - **H**: každá věta s namapovaným slovesem má v přiznání `played_as` nebo `actions`.
 * - `control`: zachované věty se proti `off` nemění.
 */
import { writeFileSync } from 'node:fs';
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
import { openSealedOnce } from './open-sealed';

type Row = { id: string; sentence: string; tags: string[]; essential: IntentTriple[]; unsupported: boolean };

const PLAYER = new Set(['player', 'hero', 'you', 'i', 'we']);
const nounsOf = (row: Row): string[] => [...new Set(row.essential.flatMap((triple) => [triple.actor, triple.object]).filter((noun): noun is string => typeof noun === 'string' && !PLAYER.has(noun)))];
const share = (hit: number, of: number) => ({ hit, of, share: of === 0 ? null : Math.round((hit / of) * 1000) / 1000 });

async function measure(rows: Row[], vocab: 'off' | 'on') {
  vi.stubEnv('PLAY_VOCAB', vocab);
  const sentences: {
    id: string; tags: string[]; compiled: boolean; played: boolean; preserved: boolean; missing: IntentTriple[]; mapped: string[];
    honesty: { kind: string; reason: string } | null; nouns: { noun: string; why: string }[];
  }[] = [];
  for (const row of rows) {
    const draft = draftGameSpecWithMeta(row.sentence, 1);
    const made = arcadeWorldOf(draft.spec, 1);
    const witnesses = made.ok ? verifyArcade(made.world, undefined, made.roleBindings).witnesses : [];
    const honesty = await honestyForSpec(row.sentence, draft.spec, 1, made.ok ? made.world : undefined);
    const score = scoreTriples(row.essential, witnesses, honesty?.unmet ?? [], { unsupported: row.unsupported, visibleAdmission: Boolean(honesty?.reason.trim()) });
    const mapped = extractIntent(row.sentence).items.filter((item) => item.mapped === true).map((item) => item.said ?? item.verb);
    const nouns = row.tags.includes('fantasy') ? nounsOf(row) : [];
    const chain = nouns.length === 0 ? [] : offlineChain([{ id: row.id, text: row.sentence, checklist: nouns.map((noun) => ({ item: noun, slot: 'any', match: [noun] })) }], () => draft.spec).sentences[0]!.items;
    sentences.push({
      id: row.id, tags: row.tags, compiled: made.ok, played: score.missing.length === 0, preserved: score.preserved,
      missing: score.missing, mapped, honesty: honesty === null ? null : { kind: honesty.kind, reason: honesty.reason },
      nouns: chain.map((item: { item: string; why: string }) => ({ noun: item.item, why: item.why })),
    });
  }
  const tagged = (tag: string) => sentences.filter((row) => row.tags.includes(tag));
  const fantasyNouns = tagged('fantasy').flatMap((row) => row.nouns);
  const withMapped = sentences.filter((row) => row.mapped.length > 0);
  const summary = {
    U: share(tagged('unknown-verb').filter((row) => row.played).length, tagged('unknown-verb').length),
    F1: share(tagged('fantasy').filter((row) => row.played).length, tagged('fantasy').length),
    F2: share(fantasyNouns.filter((noun) => noun.why === 'ok').length, fantasyNouns.length),
    N: share(tagged('non-game').filter((row) => row.mapped.length === 0).length, tagged('non-game').length),
    H: share(withMapped.filter((row) => row.honesty?.kind === 'played_as' || row.honesty?.kind === 'actions').length, withMapped.length),
    controlPreserved: tagged('control').filter((row) => row.preserved).length,
  };
  return { summary, sentences };
}

it('opens the P44C sealed set once and measures off against on', async () => {
  const argv = process.env.P44C_OPEN_SEALED_ONCE === '1' ? [...process.argv, '--open-sealed-once'] : process.argv;
  const rows = (openSealedOnce(argv) as { groups: { sealed: Row[] } }).groups.sealed;
  vi.stubEnv('PLAY_READER', 'off');
  try {
    await loadRapier();
    const off = await measure(rows, 'off');
    const on = await measure(rows, 'on');
    const offControl = new Map(off.sentences.map((row) => [row.id, row.preserved]));
    const controlChanged = on.sentences.filter((row) => row.tags.includes('control') && offControl.get(row.id) !== row.preserved).map((row) => row.id);
    const targets = { U: 0.48, F1: 0.5, F2: 0.5, N: 1, H: 1 };
    const met = Object.fromEntries(Object.entries(targets).map(([key, target]) => [key, (on.summary[key as keyof typeof targets].share ?? 1) >= target]));
    const result = { targets, met, controlChanged, off: off.summary, on: on.summary, sentences: { off: off.sentences, on: on.sentences } };
    writeFileSync('evals/play/p44c/result.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ targets, met, controlChanged, off: off.summary, on: on.summary }));
    expect(on.sentences).toHaveLength(rows.length);
  } finally { vi.unstubAllEnvs(); }
});
