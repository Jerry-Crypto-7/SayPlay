/**
 * **A6 živě: kde na cestě věta → svět vzniká čas, po voláních a po modelech.**
 *
 * `live-create.measure.ts` měří schopnost (`geometryAuthored`, `K2`) nad
 * všemi třiceti větami a přepisuje `create-report.json`. Tenhle soubor měří
 * něco jiného a nic commitnutého nepřepisuje: **latenci každého jednotlivého
 * volání** — planner, compiler, opravná kola — a totéž pro víc modelů za
 * sebou, aby se dal porovnat `gpt-5.6-sol` s jeho `-fast` variantou nad
 * skutečnými prompty, ne nad hračkou.
 *
 * Běh 6. 9. 2026 (`create-raw.json`) uměl říct jen „146 s na větu, 3,5 volání
 * na větu", protože archiv nenese čas po voláních. Z něj se ale dalo spočítat,
 * že 30 ze 45 opravných kol si vyžádal `materialIntent` jako fráze — vada,
 * kterou `bb97f88` opravila deterministicky. Tohle měření je první po té opravě.
 *
 * Spouští se **jedině** přes `npm run measure:worldstream-latency` (přípona
 * `.measure.ts`, viz `vitest.measure.mts`). Prostředí:
 *   WORLDSMITH_LATENCY_MODELS   čárkou oddělený seznam `model`, `model@effort` nebo `model@effort#cli`, výchozí `gpt-5.6-sol,gpt-5.6-sol-fast`
 *                               `#cli` volá model přes Codex CLI (`codex exec`) místo HTTP proxy — jediná cesta ke `gpt-6-astra`
 *   WORLDSMITH_LATENCY_CASES    kolik vět z korpusu, výchozí 5 (bere každou šestou, ne prvních pět)
 *   + totéž co `live-create` (`WORLDSMITH_MODEL_ENDPOINT`, `_KEY`, `_PROFILE`, `_CALL_CAP`, ceny, `VERCEL_ENV`)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import type { UpstreamRequest } from '@/model/prompt';
import { requestStage } from '@/model/worldstream-prompt';
import { CODEX_CLI_ENDPOINT, upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { createMeshClient } from '@/shape/mesh-client';

import { readCorpus, type CreateCase } from './lock.mjs';
import { driveCreateCase, liveEmitter, percentile95, type CaseOutcome } from './measure-create';
import { readQualityCases } from './world-quality/corpus';

const SESSION_SEED = 4021;
const REPAIR_PREFIX = 'Your previous answer was rejected';

// Explicit P20 run directories retain failures and answers without rewriting older reports.
const P20_DIR = process.env.P20_RUN_DIR ? resolve(process.env.P20_RUN_DIR) : null;
const REPORT_FILE = P20_DIR ? join(P20_DIR, 'latency-report.json') : fileURLToPath(new URL('./latency-report.json', import.meta.url));
const RAW_FILE = P20_DIR ? join(P20_DIR, 'latency-raw.json') : fileURLToPath(new URL('../../scratch/latency-raw.json', import.meta.url));

interface CallRecord {
  readonly model: string;
  readonly caseId: string;
  readonly call: number;
  readonly stage: ReturnType<typeof requestStage>;
  readonly repair: boolean;
  /** První řádek důvodu odmítnutí, jen u opravného kola. */
  readonly reason: string | null;
  readonly ms: number;
  readonly requestBytes: number;
  readonly answerBytes: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly ok: boolean;
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
};

interface Variant {
  /** Popisek v reportu: `model@effort`. */
  readonly label: string;
  readonly model: string;
  /** `undefined` = úsilí z `WORLDSMITH_MODEL_EFFORT`, jako u produktu. */
  readonly effort: string | undefined;
  /** `http` = produktová cesta přes `upstream.ts`; `cli` = `codex exec` z předplatného. */
  readonly transport: 'http' | 'cli';
}

/**
 * Položka je `model` nebo `model@effort`, aby jeden běh porovnal i úrovně
 * úsilí téhož modelu — 13. 9. 2026 se tak měřil `gpt-5.6-terra` na
 * low/medium/high vedle `sol` a `luna`. Přípona `#cli` posílá volání přes
 * Codex CLI: `claude-code-proxy` 0.1.32 zná jen gpt-5.x, takže `gpt-6-astra`
 * se jinak změřit nedá.
 */
function variantsFromEnv(): Variant[] {
  const raw = (process.env.WORLDSMITH_LATENCY_MODELS ?? 'gpt-5.6-sol,gpt-5.6-sol-fast').split(',');
  return raw
    .map((m) => m.trim())
    .filter((m) => m !== '')
    .map((entry) => {
      const [spec, transport] = entry.split('#');
      const [model, effort] = spec.split('@');
      return { label: entry, model, effort, transport: transport === 'cli' ? 'cli' : 'http' };
    });
}

/**
 * Totéž rozhraní jako `liveEmitter` + `usageTappingFetch`, jen přes
 * **produktový transport `codex-cli`** (`src/server/upstream.ts`): tatáž
 * větev, kterou od 13. 9. 2026 večer volá `/api/worldstream`, jen bez stropu
 * útraty a archivu — měření je omezené počtem vět. Odpověď i účtenka jsou ty,
 * které vidí produkt.
 *
 * ⚠ Codex k promptu přidává vlastní systémový prompt (~11 tis. tokenů), takže
 * `inputTokens` tady nejsou srovnatelné s HTTP cestou; čas a kvalita ano.
 */
function cliEmitter(variant: Variant): {
  upstream: { caseId: string; emit(request: UpstreamRequest): Promise<unknown> };
  tap: { last: () => Usage | null; lastText: () => string; notJsonAsWritten: () => number };
} {
  const config = upstreamConfigFromEnv({
    ...process.env,
    WORLDSMITH_MODEL_ENDPOINT: CODEX_CLI_ENDPOINT,
    WORLDSMITH_MODEL: variant.model,
    WORLDSMITH_MODEL_EFFORT: variant.effort ?? 'medium',
  });
  if (config === null) throw new Error('codex-cli variant needs the same WORLDSMITH_* environment as the http one');
  const branch = upstreamBranch(config);
  let last: Usage | null = null;
  let notJsonAsWritten = 0;
  return {
    upstream: {
      caseId: 'unknown',
      async emit(request) {
        const outcome = await branch.generate({ prompt: request.user, request });
        last = outcome.usage;
        if (!outcome.ok) {
          if (outcome.reason === 'MALFORMED_RESPONSE') notJsonAsWritten += 1;
          throw new Error(`${outcome.reason}: ${outcome.detail}`);
        }
        return outcome.body;
      },
    },
    // Text odpovědi transport ven nevydává; okolí chyby se u `#cli` nevypisuje.
    tap: { last: () => last, lastText: () => '', notJsonAsWritten: () => notJsonAsWritten },
  };
}

/**
 * Fetch, který si z každé odpovědi opíše `usage` dřív, než ji `upstream`
 * spotřebuje. Tokeny jsou to, co předplatné doopravdy platí — `-fast`
 * varianta padla právě na nich, ne na čase.
 */
function usageTappingFetch(): {
  fetch: typeof fetch;
  last: () => Usage | null;
  lastText: () => string;
  /** Kolik odpovědí nebylo JSON tak, jak přišly (produkt je dopíše, nebo odmítne). */
  notJsonAsWritten: () => number;
} {
  let last: Usage | null = null;
  let lastText = '';
  let notJsonAsWritten = 0;
  const tapped: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    last = null;
    const payload = (await response.clone().json().catch(() => null)) as
      | { usage?: Record<string, unknown>; content?: { type?: string; text?: string }[] }
      | null;
    lastText = (payload?.content ?? []).map((block) => block.text ?? '').join('');
    const usage = payload?.usage;
    if (typeof usage?.input_tokens === 'number' && typeof usage.output_tokens === 'number')
      last = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };

    // Kolik odpovědí nebylo JSON tak, jak přišly. Co s nimi bude, rozhoduje
    // produkt (`parseAnswerText` v `upstream.ts` dopíše nebo odstřihne závorku
    // na konci, jinak odmítne) — tady se jen počítá, jak často model uklouzl.
    if (!parses(lastText)) notJsonAsWritten += 1;
    return response;
  };
  return {
    fetch: tapped,
    last: () => last,
    lastText: () => lastText,
    notJsonAsWritten: () => notJsonAsWritten,
  };
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function pickCases(all: readonly CreateCase[]): CreateCase[] {
  const wanted = Math.max(1, Number(process.env.WORLDSMITH_LATENCY_CASES ?? '5') || 5);
  const step = Math.max(1, Math.floor(all.length / wanted));
  return all.filter((_, index) => index % step === 0).slice(0, wanted);
}

function reasonOf(request: UpstreamRequest): string | null {
  if (!request.user.startsWith(REPAIR_PREFIX)) return null;
  const line = request.user.split('\n').find((l) => /^[A-Z_]+ ·/.test(l)) ?? '';
  return line.replace(/\[\d+\]/g, '[n]').slice(0, 120);
}

function summarise(model: string, cases: readonly CaseOutcome[], calls: readonly CallRecord[], notJsonAsWritten: number) {
  const byStage: Record<string, { n: number; medianMs: number; p95Ms: number; medianAnswerBytes: number }> = {};
  for (const stage of ['planner', 'compiler'] as const) {
    const fresh = calls.filter((c) => c.stage === stage && !c.repair);
    if (fresh.length === 0) continue;
    byStage[stage] = {
      n: fresh.length,
      medianMs: Math.round(median(fresh.map((c) => c.ms))),
      p95Ms: Math.round(percentile95(fresh.map((c) => c.ms))),
      medianAnswerBytes: Math.round(median(fresh.map((c) => c.answerBytes))),
    };
  }
  const repairs = calls.filter((c) => c.repair);
  const reasons: Record<string, number> = {};
  for (const r of repairs) reasons[r.reason ?? '?'] = (reasons[r.reason ?? '?'] ?? 0) + 1;
  const sum = (pick: (c: CallRecord) => number | null) =>
    calls.reduce((total, c) => total + (pick(c) ?? 0), 0);
  const n = Math.max(1, cases.length);
  return {
    model,
    cases: cases.length,
    callsPerCase: Number((calls.length / n).toFixed(2)),
    inputTokensPerCase: Math.round(sum((c) => c.inputTokens) / n),
    outputTokensPerCase: Math.round(sum((c) => c.outputTokens) / n),
    callsWithoutUsage: calls.filter((c) => c.inputTokens === null).length,
    notJsonAsWritten,
    caseMedianMs: Math.round(median(cases.map((c) => c.latencyMs))),
    caseP95Ms: Math.round(percentile95(cases.map((c) => c.latencyMs))),
    geometryAuthored: cases.filter((c) => c.geometryAuthored).length,
    certified: cases.filter((c) => c.certified).length,
    byStage,
    repairCalls: repairs.length,
    repairMedianMs: Math.round(median(repairs.map((c) => c.ms))),
    repairReasons: reasons,
    perCase: cases.map((c) => ({
      id: c.id,
      ms: Math.round(c.latencyMs),
      rounds: c.rounds,
      authored: c.geometryAuthored,
      failure: c.failure,
    })),
  };
}

describe('per-call latency of the live create path', () => {
  it('records planner, compiler and repair timings per model', async () => {
    const corpus = readCorpus();
    expect(corpus.parseProblems).toEqual([]);
    const grammar = frozenGrammar();
    if (!grammar.ok) throw new Error(`${grammar.reason}: ${grammar.detail}`);

    const cases = P20_DIR ? readQualityCases('all') : pickCases(corpus.create as CreateCase[]);
    const variants = variantsFromEnv();
    if (P20_DIR) {
      expect(variants.map((v) => [v.model, v.effort])).toEqual([['gpt-6-astra', 'medium']]);
      mkdirSync(P20_DIR, { recursive: false });
      mkdirSync(join(P20_DIR, 'answers'));
      writeFileSync(join(P20_DIR, 'environment.json'), JSON.stringify({
        kind: 'live-generation', startedAt: new Date().toISOString(), node: process.version,
        os: `${platform()} ${release()}`, cpu: cpus()[0]?.model,
        commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirtyDiffHash: createHash('sha256').update(execFileSync('git', ['--no-replace-objects', 'diff', 'HEAD'])).digest('hex'),
        variants, speed: 'standard', sessionSeed: SESSION_SEED, browser: null, gpu: null,
        browserMetrics: 'pending; Node harness does not measure first visible composition or frame time',
      }, null, 2));
    }
    const mesh = createMeshClient({ allowMainThread: true });
    const raw: CallRecord[] = [];
    const summaries: ReturnType<typeof summarise>[] = [];

    try {
      for (const variant of variants) {
        const model = variant.label;
        const { upstream, tap } = ((): {
          upstream: { caseId: string; emit(request: UpstreamRequest): Promise<unknown> };
          tap: { last: () => Usage | null; lastText: () => string; notJsonAsWritten: () => number };
        } => {
          if (variant.transport === 'cli') return cliEmitter(variant);
          const httpTap = usageTappingFetch();
          return {
            tap: httpTap,
            upstream: liveEmitter(
              {
                ...process.env,
                WORLDSMITH_MODEL: variant.model,
                ...(variant.effort === undefined ? {} : { WORLDSMITH_MODEL_EFFORT: variant.effort }),
              },
              httpTap.fetch,
            ),
          };
        })();
        const outcomes: CaseOutcome[] = [];
        const modelCalls: CallRecord[] = [];
        process.stdout.write(`\n== ${model} ==\n`);

        for (const entry of cases) {
          upstream.caseId = entry.id;
          let call = 0;
          const done = await driveCreateCase(entry, {
            emit: async (request) => {
              call += 1;
              const started = performance.now();
              let answer: unknown;
              let ok = true;
              try {
                answer = await upstream.emit(request);
              } catch (thrown) {
                ok = false;
                answer = { error: String((thrown as Error).message) };
                process.stdout.write(`  ${entry.id} #${call} failed: ${String((thrown as Error).message).slice(0, 300)}\n`);
                const at = Number(/position (\d+)/.exec(String((thrown as Error).message))?.[1] ?? NaN);
                if (Number.isFinite(at))
                  process.stdout.write(
                    `  around ${String(at)}: ${JSON.stringify(tap.lastText().slice(Math.max(0, at - 80), at + 220))}\n`,
                  );
                // Celá odpověď na disk — bez ní se nedá říct, jestli je vada v modelu, nebo v cestě k němu.
                writeFileSync(
                  // `#cli` v popisku by v URL bylo fragmentem a jméno souboru by se uťalo.
                  P20_DIR ? join(P20_DIR, 'answers', `${entry.id}-${call}-failed.txt`) : fileURLToPath(new URL(`../../scratch/latency-failed-${model.replace('#', '+')}-${entry.id}-${String(call)}.txt`, import.meta.url)),
                  tap.lastText(),
                );
                throw thrown;
              } finally {
                if (P20_DIR) writeFileSync(join(P20_DIR, 'answers', `${entry.id}-${call}.json`), JSON.stringify({ request, answer, ok }, null, 2));
                const record: CallRecord = {
                  model,
                  caseId: entry.id,
                  call,
                  stage: requestStage(request),
                  repair: request.user.startsWith(REPAIR_PREFIX),
                  reason: reasonOf(request),
                  ms: performance.now() - started,
                  requestBytes: Buffer.byteLength(request.system) + Buffer.byteLength(request.user),
                  answerBytes: Buffer.byteLength(JSON.stringify(answer ?? null)),
                  inputTokens: tap.last()?.inputTokens ?? null,
                  outputTokens: tap.last()?.outputTokens ?? null,
                  ok,
                };
                modelCalls.push(record);
                raw.push(record);
                if (P20_DIR) writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
                process.stdout.write(
                  `  ${entry.id} #${call} ${record.stage ?? '?'}${record.repair ? ' repair' : ''} ${Math.round(record.ms)} ms ${record.answerBytes} B in ${String(record.inputTokens ?? '?')} out ${String(record.outputTokens ?? '?')}${record.reason ? ` · ${record.reason}` : ''}\n`,
                );
              }
              return answer;
            },
            mesh: mesh.mesh,
            grammar: grammar.value,
            sessionSeed: SESSION_SEED,
          });
          outcomes.push(done);
          // Hotový svět na disk pro galerii kvality (`e2e/quality-gallery.spec.ts`):
          // čísla výš říkají, že svět prošel, ne jak vypadá.
          if (done.blueprint !== null) {
            const dir = P20_DIR ? join(P20_DIR, 'quality', model.replace('#', '+')) : fileURLToPath(new URL(`../../scratch/quality/${model.replace('#', '+')}/`, import.meta.url));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify({ id: entry.id, prompt: entry.prompt, model, blueprint: done.blueprint }, null, 2));
          }
          if (P20_DIR) writeFileSync(join(P20_DIR, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
          process.stdout.write(
            `${entry.id} ${done.geometryAuthored ? 'authored' : (done.failure?.stage ?? 'lost')} ${Math.round(done.latencyMs)} ms, ${done.rounds} round(s)\n`,
          );
          // An unavailable transport provides no case evidence; do not repeat a broken login/runtime 30 times.
          if (P20_DIR && done.failure?.stage === 'unavailable') break;
        }
        summaries.push(summarise(model, outcomes, modelCalls, tap.notJsonAsWritten()));
      }
    } finally {
      mesh.dispose();
      mkdirSync(fileURLToPath(new URL('../../scratch/', import.meta.url)), { recursive: true });
      writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
      writeFileSync(
        REPORT_FILE,
        `${JSON.stringify({ measuredAt: new Date().toISOString(), sessionSeed: SESSION_SEED, caseIds: cases.map((c) => c.id), models: summaries }, null, 2)}\n`,
      );
    }

    expect(summaries.length).toBe(variants.length);
    if (P20_DIR) expect(summaries.every((summary) => summary.cases === cases.length), 'incomplete live baseline; see outcomes.json').toBe(true);
  }, 180 * 60_000);
});
