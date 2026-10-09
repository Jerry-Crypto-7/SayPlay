/**
 * Režisér s logikou na lokálním modelu (P45B T11): 25 vět `director-sentences.json`
 * pošle kompaktnímu režisérovi (`direct(…, { compact: true })`, jako produkt a
 * P36A T9 `evals/play/p36/director.measure.ts`) na gpt-oss-20b z
 * `ops/llm/start.ps1 -Role fallback` a první odpověď modelu uloží beze změny jako
 * fixturu `src/play/director/__fixtures__/logic-answers/<id>.json` (s modelem a
 * hashem promptu). Opravné kolo se nevolá: fixtura je jedna odpověď. Souhrn
 * `director-logic.json` soudí tytéž fixtury stejně jako offline test
 * (`judgeLogicAnswer`). Bez modelu měření skončí chybou a nic nezapíše.
 * Pod zámkem GPU:
 *   node D:/claude/_shared/gpu-lock.mjs -- powershell -NoProfile -ExecutionPolicy Bypass -File ops/llm/start.ps1 -Role fallback -Fallback gpt-oss-20b -Then evals/play/p45b/director-logic.cmd
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { direct } from '@/play/director';
import { LOGIC_ANSWERS_DIR, type LogicAnswerFixture, judgeLogicAnswer } from '@/play/director/__fixtures__/logic-answers';
import { COMPACT_PROMPT_VERSION } from '@/play/director/compact';
import { DIRECTOR_PROMPT_VERSION } from '@/play/director/prompt';
import type { GenerationBranch, GenerationOutcome } from '@/server/pipeline';
import { upstreamBranch, type UpstreamConfig } from '@/server/upstream';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = join(ROOT, 'evals', 'play', 'p45b', 'director-logic.json');

interface Sentence {
  readonly id: string;
  readonly axis: string;
  readonly text: string;
}

async function reachable(endpoint: string): Promise<boolean> {
  try {
    return (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/** Větev, která si nechá první výsledek volání – surovou odpověď modelu. */
function recording(inner: GenerationBranch): GenerationBranch & { first: GenerationOutcome | null } {
  const branch = {
    id: inner.id,
    pricing: inner.pricing,
    first: null as GenerationOutcome | null,
    worstCaseUsd: (call: Parameters<GenerationBranch['worstCaseUsd']>[0]) => inner.worstCaseUsd(call),
    async generate(call: Parameters<GenerationBranch['generate']>[0], signal?: AbortSignal) {
      const outcome = await inner.generate(call, signal);
      branch.first ??= outcome;
      return outcome;
    },
  };
  return branch;
}

const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
};

it('records gpt-oss-20b logic answers and writes evals/play/p45b/director-logic.json', async () => {
  const endpoint = process.env.P45B_DIRECTOR_ENDPOINT ?? 'http://127.0.0.1:8792';
  const model = process.env.P45B_DIRECTOR_MODEL ?? 'gpt-oss-20b';
  if (!(await reachable(endpoint))) throw new Error(`model not reachable at ${endpoint}/health – start it with ops/llm/start.ps1 -Role fallback`);
  const config: UpstreamConfig = {
    endpoint: `llamacpp:${endpoint}`,
    apiKey: '',
    model,
    effort: 'low',
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    maxOutputTokens: 4000,
    // Strop jednoho volání jako `WORLDSMITH_FALLBACK_TIMEOUT_MS` v produkci (výchozí 120 s), stejně jako P36A T9.
    timeoutMs: 120_000,
    profile: 'subscription',
    callCap: null,
  };
  await loadRapier();
  const sentences = (JSON.parse(readFileSync(join(ROOT, 'evals', 'play', 'p45b', 'director-sentences.json'), 'utf8')) as { sentences: Sentence[] }).sentences;
  mkdirSync(join(ROOT, LOGIC_ANSWERS_DIR), { recursive: true });

  const fixtures: LogicAnswerFixture[] = [];
  for (const sentence of sentences) {
    let branch = recording(upstreamBranch(config));
    let started = performance.now();
    await direct(sentence.text, { branch, now: Date.now, compact: true, maxRepairRounds: 0 });
    // Jeden nový pokus, když se volání k serveru nedostalo (první záznam: 2× „fetch failed“ za < 0,5 s) – vada spojení, ne odpověď.
    if (branch.first?.ok === false && branch.first.reason === 'UPSTREAM_UNAVAILABLE') {
      branch = recording(upstreamBranch(config));
      started = performance.now();
      await direct(sentence.text, { branch, now: Date.now, compact: true, maxRepairRounds: 0 });
    }
    const first = branch.first;
    const fixture: LogicAnswerFixture = {
      id: sentence.id,
      sentence: sentence.text,
      axis: sentence.axis,
      model,
      promptVersion: COMPACT_PROMPT_VERSION,
      directorPromptVersion: DIRECTOR_PROMPT_VERSION,
      recordedAt: new Date().toISOString(),
      ms: Math.round(performance.now() - started),
      answer: first?.ok === true ? first.body : null,
      failure: first === null ? 'no call' : first.ok ? null : `${first.reason}: ${first.detail}`,
    };
    writeFileSync(join(ROOT, LOGIC_ANSWERS_DIR, `${sentence.id}.json`), `${JSON.stringify(fixture, null, 1)}\n`);
    fixtures.push(fixture);
    console.log(`${sentence.id} ${String(fixture.ms)} ms ${fixture.failure ?? 'answered'}`);
  }

  const verdicts = [];
  for (const fixture of fixtures) verdicts.push({ ...(await judgeLogicAnswer(fixture)), axis: fixture.axis, ms: fixture.ms });
  const passed = verdicts.filter((verdict) => verdict.passed).length;
  const report = {
    about: 'P45B T11: first answers of the compact director on local gpt-oss-20b for evals/play/p45b/director-sentences.json, judged offline by judgeLogicAnswer (src/play/director/__fixtures__/logic-answers.ts). Target: >= 20/25 write logic and pass with logic_proved. See evals/play/p45b/README.md.',
    measuredAt: new Date().toISOString(),
    commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    model,
    endpoint,
    promptVersion: COMPACT_PROMPT_VERSION,
    directorPromptVersion: DIRECTOR_PROMPT_VERSION,
    passed: { hit: passed, of: verdicts.length },
    wroteLogic: verdicts.filter((verdict) => verdict.wroteLogic).length,
    answered: fixtures.filter((fixture) => fixture.answer !== null).length,
    latencyMs: { p50: quantile(fixtures.map((fixture) => fixture.ms), 0.5), max: Math.max(...fixtures.map((fixture) => fixture.ms)) },
    rows: verdicts,
  };
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`passed ${String(passed)}/${String(verdicts.length)}`);
}, 3 * 60 * 60_000);
