/**
 * **Judge gauntlet živě: šestnáct vět korpusu jednou skrz plánovač (P22 T17).**
 *
 * Vzorek je stratifikovaný – jedna věta na kategorii z `prompts.json` mimo
 * `contradictory`, `unsupported`, `safety` a `abstract` (tam se svět neslibuje,
 * nebo je správná odpověď odmítnutí) – vylosovaný `pure-rand` ze semínka 4021,
 * takže druhý běh měří tytéž věty. Každá věta stojí **jedno** volání plánovače
 * (`buildIntentRequest`, úsilí `STAGE_EFFORT.planner`), žádné opravné kolo,
 * žádný kompilátor. Odpověď se čte tak, jak ji čte produkt, a soudí ji lidské
 * orákulum z `oracles.json` týmž `scoreSemantics()`, kterým T2 soudí archiv;
 * vedle stojí počet bloků `wordMassing` (T4), aby bylo vidět, co věta dá bez
 * modelu. Skóre je `null`, ne 0, když odpověď nepřišla nebo nejde přečíst –
 * nula by stáhla medián a tvářila se jako naměřená.
 *
 * Plné znění odpovědí jde do `gauntlet-answers/<id>.json` a **commituje se**
 * (na rozdíl od `conversation-answers/`): plán chce odpovědi porotcovských vět
 * v repu, aby se daly číst bez druhého běhu.
 *
 * Strop je tvrdý: `WORLDSMITH_CALL_CAP=16`, jeden běh. Po dvou selháních
 * poskytovatele za sebou se běh zastaví a artefakt se zapíše jako `partial`
 * s důvodem – mrtvý poskytovatel by jinak protočil čtrnáct timeoutů po 10 min.
 *
 *     WORLDSMITH_BRANCH=live WORLDSMITH_MODEL_ENDPOINT=codex-cli WORLDSMITH_MODEL_KEY=local-subscription \
 *     WORLDSMITH_MODEL_PROFILE=subscription WORLDSMITH_CALL_CAP=16 WORLDSMITH_USD_PER_MTOK_OUT=10 \
 *     WORLDSMITH_SPEND_CAP_USD=1000 WORLDSMITH_UPSTREAM_TIMEOUT_MS=600000 VERCEL_ENV=production \
 *     WORLDSMITH_LATENCY_MODELS='gpt-6-astra@medium#cli' \
 *     npx vitest run --config vitest.measure.mts evals/worldstream/gauntlet/gauntlet.measure.ts
 *
 * Suchý běh bez modelu (`WORLDSMITH_GAUNTLET_DRY_RUN=1`) přehraje jednu
 * archivovanou odpověď za všechny věty a poslední větu nechá selhat; píše do
 * `os.tmpdir()`, aby nesáhl na commitnutý artefakt.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { describe, expect, it } from 'vitest';

import type { UpstreamRequest } from '@/model/prompt';
import { buildIntentRequest } from '@/model/worldstream-intent';
import type { SemanticOracle } from '@/scene/requirements';
import { wordMassing } from '@/scene/word-massing';
import { CODEX_CLI_ENDPOINT, STAGE_EFFORT, upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { nextInt } from '@/sim/rng';

import { EXCLUDED_CATEGORIES, scoreAnswer, summarize, type GauntletAnswer, type GauntletCase } from './gauntlet-score';

const DRY_RUN = process.env.WORLDSMITH_GAUNTLET_DRY_RUN === '1';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT_DIR = DRY_RUN ? join(tmpdir(), 'gauntlet-dry-run') : HERE;
const PROMPTS_FILE = join(HERE, 'prompts.json');
const ORACLES_FILE = join(HERE, 'oracles.json');
const REPORT_FILE = join(OUT_DIR, 'gauntlet.json');
const ANSWERS_DIR = join(OUT_DIR, 'gauntlet-answers');
const DRY_ARCHIVE = fileURLToPath(new URL('../../../plans/P20/t18-hybrid-v2-20260917-1803/raw/h01-planner.json', import.meta.url));

const SEED = 4021;
/** Po tolika selháních poskytovatele za sebou se zbytek vět nevolá. */
const CONSECUTIVE_FAILURES_TO_STOP = 2;

interface Prompt { readonly id: string; readonly category: string; readonly sentence: string }
interface PromptFile { readonly categories: readonly string[]; readonly prompts: readonly Prompt[] }
interface OracleFile { readonly oracles: readonly (SemanticOracle & { readonly id: string })[] }

/** Jedna věta na kategorii, v pořadí `categories` z `prompts.json`, los z jednoho streamu. */
function stratifiedSample(file: PromptFile, seed: number): Prompt[] {
  const stream = xoroshiro128plus(seed);
  return file.categories
    .filter((category) => !(EXCLUDED_CATEGORIES as readonly string[]).includes(category))
    .map((category) => {
      const pool = file.prompts.filter((prompt) => prompt.category === category);
      return pool[nextInt(stream, 0, pool.length - 1)];
    });
}

/** `model@effort#cli` jako v `live-latency.measure.ts`; jen první položka, měří se jeden model. */
function variantFromEnv(): { label: string; model: string; effort: string } {
  const entry = (process.env.WORLDSMITH_LATENCY_MODELS ?? 'gpt-6-astra@medium#cli').split(',')[0].trim();
  const [spec] = entry.split('#');
  const [model, effort] = spec.split('@');
  return { label: entry, model, effort: effort ?? 'medium' };
}

interface Emitter {
  readonly effort: string;
  readonly callCap: number;
  emit(request: UpstreamRequest): Promise<{ answer: unknown; fault: string | undefined }>;
}

/** Produktový transport `codex-cli` (`src/server/upstream.ts`), tentýž jako u `cliEmitter` v `live-latency`. */
function liveEmitter(variant: { model: string; effort: string }): Emitter {
  const config = upstreamConfigFromEnv({
    ...process.env,
    WORLDSMITH_MODEL_ENDPOINT: CODEX_CLI_ENDPOINT,
    WORLDSMITH_MODEL: variant.model,
    WORLDSMITH_MODEL_EFFORT: variant.effort,
  });
  if (config === null) throw new Error('LIVE_UNAVAILABLE: no live branch is configured (see the docblock for the environment)');
  const branch = upstreamBranch(config);
  return {
    effort: config.effort,
    callCap: config.callCap ?? Number.POSITIVE_INFINITY,
    async emit(request) {
      const outcome = await branch.generate({ prompt: request.user, request });
      return outcome.ok ? { answer: outcome.body, fault: undefined } : { answer: undefined, fault: `${outcome.reason}: ${outcome.detail}` };
    },
  };
}

function dryEmitter(total: number): Emitter {
  const archived = (JSON.parse(readFileSync(DRY_ARCHIVE, 'utf8')) as { value: unknown }).value;
  let calls = 0;
  return {
    effort: 'dry',
    callCap: 16,
    emit: () => {
      calls += 1;
      return Promise.resolve(calls === total
        ? { answer: undefined, fault: 'UPSTREAM_UNAVAILABLE: dry run – the last sentence fails on purpose' }
        : { answer: archived, fault: undefined });
    },
  };
}

describe('judge gauntlet through the planner', () => {
  it('runs sixteen stratified sentences once each and scores them with the human oracle', async () => {
    const promptFile = JSON.parse(readFileSync(PROMPTS_FILE, 'utf8')) as PromptFile;
    const oracles = new Map((JSON.parse(readFileSync(ORACLES_FILE, 'utf8')) as OracleFile).oracles.map((oracle) => [oracle.id, oracle]));
    const sample = stratifiedSample(promptFile, SEED);
    expect(sample).toHaveLength(16);

    const variant = variantFromEnv();
    const emitter = DRY_RUN ? dryEmitter(sample.length) : liveEmitter(variant);
    mkdirSync(ANSWERS_DIR, { recursive: true });

    const answers: GauntletAnswer[] = [];
    let calls = 0;
    let consecutiveFailures = 0;
    let stopReason: string | null = null;
    for (const prompt of sample) {
      const base = { id: prompt.id, category: prompt.category, sentence: prompt.sentence };
      if (stopReason === null && calls >= emitter.callCap) stopReason = `call cap ${String(emitter.callCap)} reached`;
      if (stopReason !== null) {
        answers.push({ ...base, plannerMs: null, answer: undefined, fault: `NOT_CALLED: ${stopReason}` });
        continue;
      }

      calls += 1;
      const started = performance.now();
      let result: { answer: unknown; fault: string | undefined };
      try {
        result = await emitter.emit(buildIntentRequest(prompt.sentence));
      } catch (error) {
        result = { answer: undefined, fault: `UPSTREAM_THREW: ${error instanceof Error ? error.message : String(error)}` };
      }
      const plannerMs = Math.round(performance.now() - started);
      answers.push({ ...base, plannerMs, ...result });
      const record = { ...base, measuredAt: new Date().toISOString(), plannerMs, ...(result.fault === undefined ? { answer: result.answer } : { fault: result.fault }) };
      writeFileSync(`${ANSWERS_DIR}/${prompt.id}.json`, `${JSON.stringify(record, null, 2)}\n`);
      process.stdout.write(`  ${prompt.id} ${String(plannerMs)} ms${result.fault === undefined ? '' : ` · ${result.fault.slice(0, 160)}`}\n`);

      consecutiveFailures = result.fault === undefined ? 0 : consecutiveFailures + 1;
      if (consecutiveFailures >= CONSECUTIVE_FAILURES_TO_STOP)
        stopReason = `${String(consecutiveFailures)} provider failures in a row, last: ${result.fault ?? ''}`.slice(0, 300);
    }

    const cases: GauntletCase[] = answers.map((answer) => {
      const oracle = oracles.get(answer.id);
      if (oracle === undefined) throw new Error(`${answer.id} has no oracle in oracles.json`);
      return scoreAnswer(answer, oracle, wordMassing(answer.sentence, { sessionSeed: SEED })?.objects.length ?? 0);
    });
    const summary = summarize(cases);
    const missing = cases.filter((entry) => entry.answerBytes === null);
    const run = {
      measuredAt: new Date().toISOString(),
      plan: 'P22 T17 – judge gauntlet, one live planner call per sentence',
      model: variant.label,
      effort: emitter.effort,
      plannerEffort: STAGE_EFFORT.planner ?? emitter.effort,
      calls,
      callCap: emitter.callCap,
      partial: missing.length > 0,
      reason: missing.length === 0 ? null : (stopReason ?? missing[0].fault ?? 'no answer'),
      oracles: 'evals/worldstream/gauntlet/oracles.json (human-written 2026-09-19)',
      scorer: 'src/scene/requirements.ts scoreSemantics() – four equally weighted components; null when no readable answer',
      answersDir: 'evals/worldstream/gauntlet/gauntlet-answers (committed; one <id>.json per called sentence)',
      summary,
      cases,
    };

    // Běhy se skládají vedle sebe (jako `conversation.json`): další běh první nepřepíše.
    const previous = existsSync(REPORT_FILE) ? (JSON.parse(readFileSync(REPORT_FILE, 'utf8')) as { runs?: unknown[] }) : {};
    const report = {
      plan: 'P22 T17 – judge gauntlet through the planner (G4, G5)',
      seed: SEED,
      excluded: EXCLUDED_CATEGORIES,
      sample: sample.map((prompt) => ({ id: prompt.id, category: prompt.category })),
      runs: [...(previous.runs ?? []), run],
    };
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\ngauntlet: ${String(summary.readable)}/${String(summary.total)} readable, median planner ${String(summary.medianPlannerMs)} ms, median score ${String(summary.medianScore)}, calls ${String(calls)}/${String(emitter.callCap)}${run.partial ? ` · PARTIAL: ${run.reason ?? ''}` : ''}\n`);
    if (DRY_RUN) process.stdout.write(`dry run wrote ${REPORT_FILE}\n`);

    expect(cases).toHaveLength(16);
    expect(calls).toBeLessThanOrEqual(16);
  }, 45 * 60_000);
});
