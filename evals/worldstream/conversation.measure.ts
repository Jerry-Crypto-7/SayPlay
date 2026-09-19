/**
 * **Brána A10 živě: od odeslané věty k prvnímu přijatému kusu (P21 T11).**
 *
 * Měří tutéž cestu, kterou jde věta v produktu přes
 * `POST /api/worldstream/sessions/[id]/changes`: `planIncrement` (jedna věta =
 * jeden kus) → `groundTarget` (zadarmo, před modelem) → `planChange` (jedno
 * placené volání Astry přes codex CLI) → čtení odpovědi proti kontraktu
 * přidání → tytéž dvě kontroly schopností, které route vrací jako 422.
 * Co tu není: commit revize a meshing — kus je „přijat" ve chvíli, kdy by ho
 * route vydala jako preview, protože přesně tam porotce poprvé vidí, že věta
 * prošla.
 *
 * Svět pod větami je uvařený (`emitterFor(c09)`, „a giant fallen tree hollowed
 * into a village"), takže se za něj neplatí a všechny tři věty stojí nad týmž
 * světem. Věty jsou **každá třetí z deseti** v `incremental-planner.test.ts`
 * (index 0, 3, 6); zbylých sedm zůstává na doměření po finále. Třetí věta
 * mluví o zvonu a studni, které ve světě nejsou — to je záměrně těžký případ,
 * ne chyba výběru: brána má říct, co model s takovou větou udělá.
 *
 * **Prahy z rešerše — medián ≤ 5 s, ≥ 2 ze 3 přijaty — jsou v artefaktu cíl,
 * ne podmínka projití.** Rozhoduje naměřené číslo; sada nad artefaktem
 * (`__tests__/conversation-report.test.ts`) hlídá jen úplnost jmenovatele.
 *
 * Od P21 T22 se každý běh dopisuje do pole `runs` vedle předchozích (P22 T18 je třetí); první (T11,
 * 19. 9. 2026 ráno, 1 ze 4) zůstává. Jeden živý běh, `WORLDSMITH_CALL_CAP=6`,
 * `@medium` (rozpočet v plánu P21):
 *
 *     WORLDSMITH_BRANCH=live WORLDSMITH_MODEL_ENDPOINT=codex-cli WORLDSMITH_MODEL_KEY=local-subscription \
 *     WORLDSMITH_MODEL_PROFILE=subscription WORLDSMITH_CALL_CAP=6 WORLDSMITH_USD_PER_MTOK_OUT=10 \
 *     WORLDSMITH_SPEND_CAP_USD=1000 WORLDSMITH_UPSTREAM_TIMEOUT_MS=600000 VERCEL_ENV=production \
 *     WORLDSMITH_MODEL=gpt-6-astra WORLDSMITH_MODEL_EFFORT=medium \
 *     npx vitest run --config vitest.measure.mts evals/worldstream/conversation.measure.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { planIncrement } from '@/model/incremental-planner';
import type { UpstreamRequest } from '@/model/prompt';
import { groundTarget, planChange } from '@/model/worldstream-refine';
import { CODEX_CLI_ENDPOINT, upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { hasUnsupportedAppearance, hasUnsupportedMotion } from '@/server/worldstream-capabilities';
import { authoredWorldById, emitterFor } from '@/worldstream/authored';
import { openSession, runGeneration, serverGrammar } from '@/worldstream/sessions';

const OUT_FILE = fileURLToPath(new URL('./conversation.json', import.meta.url));
/**
 * Odpovědi modelu po případech, **gitignorované** jako `create-raw.json`: nesou
 * plné znění toho, co model napsal. Do `conversation.json` jde jen `answerBytes`
 * a u odmítnutí `detail` — bez uložené odpovědi se po běhu 19. 9. 2026 nedalo
 * říct, jaký `kind` model napsal, jen že byl mimo abecedu (P21 T20).
 */
const ANSWERS_DIR = fileURLToPath(new URL('./conversation-answers', import.meta.url));
const SESSION_SEED = 4021;
const WORLD_ID = 'c09';

/** Deset vět z `incremental-planner.test.ts`; měří se každá třetí. */
const TEN = [
  'add a lantern at the far edge',
  'Put a small brass bell by the gate.',
  'There is a well in the middle of the courtyard.',
  'A wooden bench under the tree',
  'place another crate next to the first one',
  'When the lever is pulled, the gate opens.',
  'the bell should ring every time someone walks past the well',
  'If the lantern is lit the door unlocks',
  'make the well deeper',
  'Paint the gate rust red.',
] as const;
// „Každá třetí z deseti" jsou čtyři (0, 3, 6, 9); plán chce tři, takže první tři z nich.
// Běh 19. 9. 2026 to neořízl a změřil čtyři – artefakt je nese všechny, jmenovatel je 4.
const EVERY_THIRD = TEN.filter((_, index) => index % 3 === 0).slice(0, 3);

/** Cíle z rešerše — v artefaktu jako cíl, ne jako podmínka projití. */
const TARGET = { medianMs: 5_000, acceptedOf: [2, 3] as const, full: [8, 10] as const };

interface CaseRecord {
  readonly sentence: string;
  /** Co z věty udělal `planIncrement`: kus, který šel dál, a kolik jich zbylo ve frontě. */
  readonly piece: string;
  readonly queued: number;
  /** `add` = věta bez cíle ve světě zakládá nový objekt; jinak `stableId` cíle. */
  readonly target: string;
  readonly verdict: 'ACCEPTED' | 'REJECTED' | 'UNAVAILABLE';
  readonly reason: string | null;
  readonly detail: string | null;
  /** Od odeslání věty k verdiktu, včetně volání modelu. */
  readonly ms: number;
  readonly modelMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly summary: string | null;
  readonly addedObject: string | null;
  /** Bajty odpovědi modelu (kompaktní JSON); `null`, když se k modelu nedošlo. Plné znění: `conversation-answers/<id>.json`. */
  readonly answerBytes: number | null;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
};

function liveEmitter(): { emit: (request: UpstreamRequest) => Promise<unknown>; lastMs: () => number | null; lastUsage: () => { inputTokens: number; outputTokens: number } | null; lastAnswer: () => unknown } {
  const config = upstreamConfigFromEnv({ ...process.env, WORLDSMITH_MODEL_ENDPOINT: CODEX_CLI_ENDPOINT });
  if (config === null) throw new Error('LIVE_UNAVAILABLE: no live branch is configured (see the docblock for the environment)');
  const branch = upstreamBranch(config);
  let lastMs: number | null = null;
  let lastUsage: { inputTokens: number; outputTokens: number } | null = null;
  let lastAnswer: unknown = undefined;
  return {
    async emit(request) {
      const started = performance.now();
      const outcome = await branch.generate({ prompt: request.user, request });
      lastMs = performance.now() - started;
      lastUsage = outcome.usage;
      lastAnswer = outcome.ok ? outcome.body : { error: `${outcome.reason}: ${outcome.detail}` };
      if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.detail}`);
      return outcome.body;
    },
    lastMs: () => lastMs,
    lastUsage: () => lastUsage,
    lastAnswer: () => lastAnswer,
  };
}

describe('A10 live: sentence → first accepted piece', () => {
  it('measures three of the ten short sentences over one cooked world', async () => {
    const grammar = serverGrammar();
    if (typeof grammar === 'string') throw new Error(grammar);
    const world = authoredWorldById(WORLD_ID);
    if (world === null) throw new Error(`authored world ${WORLD_ID} is missing`);

    const stored = openSession(`p21-conversation-${String(Date.now())}`, SESSION_SEED)!;
    await runGeneration(stored, world.prompt, { legacyPlan: true, emit: emitterFor(world), grammar });
    const blueprint = stored.blueprint;
    if (blueprint === null) throw new Error(`the cooked world ${WORLD_ID} did not build: ${stored.fault ?? 'no fault recorded'}`);

    const live = liveEmitter();
    const cases: CaseRecord[] = [];

    mkdirSync(ANSWERS_DIR, { recursive: true });
    for (const sentence of EVERY_THIRD) {
      const id = `s${String(TEN.indexOf(sentence)).padStart(2, '0')}`;
      const started = performance.now();
      const increment = planIncrement(sentence);
      if (!increment.ok) {
        cases.push({ sentence, piece: '', queued: 0, target: '', verdict: 'REJECTED', reason: increment.reason, detail: increment.detail, ms: performance.now() - started, modelMs: null, inputTokens: null, outputTokens: null, summary: null, addedObject: null, answerBytes: null });
        continue;
      }
      const piece = increment.pieces[0].text;
      const grounding = groundTarget(piece, blueprint.objects, undefined);
      if (!grounding.ok) {
        cases.push({ sentence, piece, queued: increment.pieces.length - 1, target: '', verdict: 'REJECTED', reason: grounding.reason, detail: grounding.candidates.map((c) => c.stableId).join(', '), ms: performance.now() - started, modelMs: null, inputTokens: null, outputTokens: null, summary: null, addedObject: null, answerBytes: null });
        continue;
      }
      // Přidání s kotvou (P22 T13): „A wooden bench under the tree" jde k modelu
      // jako zadání přidání u stromu, ne jako úprava stromu.
      const target = grounding.kind === 'edit' ? grounding.target : null;
      const anchor = grounding.kind === 'addition' ? grounding.anchor : null;

      const outcome = await planChange({ prompt: piece, blueprint, target, anchor, emit: live.emit });
      const answer = live.lastAnswer();
      const answerText = answer === undefined ? null : JSON.stringify(answer);
      if (answerText !== null) writeFileSync(`${ANSWERS_DIR}/${id}.json`, `${JSON.stringify({ id, sentence, piece, measuredAt: new Date().toISOString(), answer }, null, 2)}\n`);
      const base = {
        sentence,
        piece,
        queued: increment.pieces.length - 1,
        target: target === null ? 'add' : target.stableId,
        modelMs: live.lastMs() === null ? null : Math.round(live.lastMs() as number),
        inputTokens: live.lastUsage()?.inputTokens ?? null,
        outputTokens: live.lastUsage()?.outputTokens ?? null,
        answerBytes: answerText === null ? null : Buffer.byteLength(answerText),
      };
      if (outcome.kind === 'unavailable') {
        cases.push({ ...base, verdict: 'UNAVAILABLE', reason: 'MODEL_UNAVAILABLE', detail: outcome.detail, ms: performance.now() - started, summary: null, addedObject: null });
      } else if (outcome.kind === 'rejected') {
        cases.push({ ...base, verdict: 'REJECTED', reason: outcome.reason, detail: outcome.detail, ms: performance.now() - started, summary: null, addedObject: null });
      } else if (hasUnsupportedAppearance(outcome.plan)) {
        cases.push({ ...base, verdict: 'REJECTED', reason: 'APPEARANCE_UNSUPPORTED', detail: 'the appearance operations ask for something the look cannot show', ms: performance.now() - started, summary: outcome.plan.summary, addedObject: null });
      } else if (hasUnsupportedMotion(outcome.plan, blueprint.world)) {
        cases.push({ ...base, verdict: 'REJECTED', reason: 'MOTION_UNSUPPORTED', detail: 'the behavior asks for motion the simulation cannot run', ms: performance.now() - started, summary: outcome.plan.summary, addedObject: null });
      } else {
        cases.push({ ...base, verdict: 'ACCEPTED', reason: null, detail: null, ms: performance.now() - started, summary: outcome.plan.summary, addedObject: outcome.plan.addition?.object.stableId ?? null });
      }
      const last = cases[cases.length - 1];
      process.stdout.write(`  ${last.verdict} ${Math.round(last.ms)} ms · ${sentence}${last.reason ? ` · ${last.reason}` : ''}\n`);
    }

    const accepted = cases.filter((entry) => entry.verdict === 'ACCEPTED').length;
    const run = {
      measuredAt: new Date().toISOString(),
      plan: 'P22 T18 – A10 gate after the anchoring fix (T13), one live run',
      model: `${process.env.WORLDSMITH_MODEL ?? 'gpt-6-astra'}@${process.env.WORLDSMITH_MODEL_EFFORT ?? 'medium'}#cli`,
      effort: process.env.WORLDSMITH_MODEL_EFFORT ?? 'medium',
      callCap: Number(process.env.WORLDSMITH_CALL_CAP ?? NaN),
      answersDir: 'evals/worldstream/conversation-answers (gitignored; one <id>.json per case that reached the model)',
      corpus: { total: TEN.length, measured: EVERY_THIRD.length, selection: 'every third of ten, first three (index 0, 3, 6)', remaining: TEN.filter((sentence) => !EVERY_THIRD.includes(sentence)) },
      summary: {
        total: cases.length,
        accepted,
        acceptedShare: Number((accepted / Math.max(1, cases.length)).toFixed(2)),
        medianMs: Math.round(median(cases.map((entry) => entry.ms))),
        slowestMs: Math.round(Math.max(...cases.map((entry) => entry.ms))),
      },
      cases: cases.map((entry) => ({ ...entry, ms: Math.round(entry.ms) })),
    };
    // Běhy se skládají vedle sebe: druhý, který by první (1 ze 4) přepsal, by
    // vypadal jako zlepšení, i kdyby žádné nebylo (P21 T22).
    const previous = JSON.parse(readFileSync(OUT_FILE, 'utf8')) as { runs?: unknown[] };
    const report = {
      plan: 'A10 gate, live runs side by side (P21 T11, T22; P22 T18)',
      world: { id: WORLD_ID, prompt: world.prompt, objects: blueprint.objects.map((object) => object.stableId) },
      target: { ...TARGET, note: 'research targets, stated as a goal – the measured number decides, not this line' },
      runs: [...(previous.runs ?? []), run],
    };
    writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\naccepted ${String(accepted)}/${String(cases.length)}, median ${String(run.summary.medianMs)} ms\n`);

    expect(cases).toHaveLength(EVERY_THIRD.length);
  }, 30 * 60_000);
});
