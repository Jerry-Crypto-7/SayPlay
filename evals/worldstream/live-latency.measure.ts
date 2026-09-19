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
 *   WORLDSMITH_LATENCY_PHASE5   `1` = P21 T21: jedno volání kompilátoru, plánovač po štíhlém sceneSpec a na `low`; dopíše blok
 *                               `phase5` do `latency-p21.json` a nic v něm nepřepíše (`WORLDSMITH_CALL_CAP=10`, dvě věty).
 *   WORLDSMITH_LATENCY_CHUNKED  `1` = svět na tři souběžné kusy (P21 T5); každý kus je vlastní záznam s `chunk`, případ nese
 *                               čas celého světa i nejdelšího kusu. **Píše `latency-p21.json`, ne `latency-report.json`:**
 *                               ten nese měření ze 13. 9. (pět vět), ze kterého P21 cituje, a přepsat ho by citaci vzalo.
 *                               `2` = svět na **dva** kusy (`scene` + `rules`, P22 T16); dopíše blok `p22chunks2` do
 *                               `latency-p21.json` vedle `phase5` a nic v něm nepřepíše (`WORLDSMITH_CALL_CAP=8`, dvě věty).
 *                               P21 artefakt nese čtyři fáze čekání na větu a vedle nich staré číslo s datem a počtem vět
 *                               (`evals/worldstream/__tests__/latency-report.test.ts`).
 *   + totéž co `live-create` (`WORLDSMITH_MODEL_ENDPOINT`, `_KEY`, `_PROFILE`, `_CALL_CAP`, ceny, `VERCEL_ENV`)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, release } from 'node:os';

import { describe, expect, it } from 'vitest';

import { frozenGrammar } from '@/model/client';
import type { UpstreamRequest } from '@/model/prompt';
import { requestChunk, requestStage } from '@/model/worldstream-prompt';
import { CHUNK_EFFORT, CODEX_CLI_ENDPOINT, STAGE_EFFORT, upstreamBranch, upstreamConfigFromEnv } from '@/server/upstream';
import { createMeshClient } from '@/shape/mesh-client';

import { readCorpus, type CreateCase } from './lock.mjs';
import { driveCreateCase, liveEmitter, percentile95, type CaseOutcome } from './measure-create';
import { readQualityCases } from './world-quality/corpus';

const SESSION_SEED = 4021;
const REPAIR_PREFIX = 'Your previous answer was rejected';
/** `null` = jediné volání kompilátoru; `3` = P21 T5 tři kusy; `2` = P22 T16 dva kusy. */
const CHUNK_PIECES: 2 | 3 | null =
  process.env.WORLDSMITH_LATENCY_CHUNKED === '1' ? 3 : process.env.WORLDSMITH_LATENCY_CHUNKED === '2' ? 2 : null;
const CHUNKED = CHUNK_PIECES !== null;
/**
 * P21 T21: jedno volání kompilátoru (kusy vypnuté), plánovač po štíhlém
 * `sceneSpec` (T18) a s vlastním úsilím (T19). **Dopisuje blok `phase5` do
 * `latency-p21.json`** vedle běhu z 19. 9. ráno; nic z toho souboru nepřepisuje
 * a `latency-report.json` (13. 9.) nechává být.
 */
const PHASE5 = process.env.WORLDSMITH_LATENCY_PHASE5 === '1';

// Explicit P20 run directories retain failures and answers without rewriting older reports.
const P20_DIR = process.env.P20_RUN_DIR ? resolve(process.env.P20_RUN_DIR) : null;
const BASELINE_FILE = fileURLToPath(new URL('./latency-report.json', import.meta.url));
const P21_FILE = fileURLToPath(new URL('./latency-p21.json', import.meta.url));
const REPORT_FILE = P20_DIR ? join(P20_DIR, 'latency-report.json') : CHUNKED || PHASE5 ? P21_FILE : BASELINE_FILE;
const RAW_FILE = P20_DIR ? join(P20_DIR, 'latency-raw.json') : fileURLToPath(new URL('../../scratch/latency-raw.json', import.meta.url));

interface CallRecord {
  readonly model: string;
  readonly caseId: string;
  readonly call: number;
  readonly stage: ReturnType<typeof requestStage>;
  /** Který kus si požadavek říkal napsat; `null` u celé odpovědi. */
  readonly chunk: ReturnType<typeof requestChunk>;
  readonly repair: boolean;
  /** První řádek důvodu odmítnutí, jen u opravného kola. */
  readonly reason: string | null;
  readonly ms: number;
  /** Kdy volání skončilo, od začátku věty. U souběžných kusů je to jediné, z čeho jdou fáze čekání. */
  readonly endedAtMs: number;
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
  tap: Tap;
} {
  const config = upstreamConfigFromEnv({
    ...process.env,
    WORLDSMITH_MODEL_ENDPOINT: CODEX_CLI_ENDPOINT,
    WORLDSMITH_MODEL: variant.model,
    WORLDSMITH_MODEL_EFFORT: variant.effort ?? 'medium',
  });
  if (config === null) throw new Error('codex-cli variant needs the same WORLDSMITH_* environment as the http one');
  const branch = upstreamBranch(config);
  // Účtenka po požadavku, ne „poslední": tři kusy letí naráz (T5) a sdílená
  // proměnná by kusu připsala spotřebu souseda.
  const usageByRequest = new WeakMap<UpstreamRequest, Usage>();
  let notJsonAsWritten = 0;
  return {
    upstream: {
      caseId: 'unknown',
      async emit(request) {
        const outcome = await branch.generate({ prompt: request.user, request });
        if (outcome.usage !== null) usageByRequest.set(request, outcome.usage);
        if (!outcome.ok) {
          if (outcome.reason === 'MALFORMED_RESPONSE') notJsonAsWritten += 1;
          throw new Error(`${outcome.reason}: ${outcome.detail}`);
        }
        return outcome.body;
      },
    },
    // Text odpovědi transport ven nevydává; okolí chyby se u `#cli` nevypisuje.
    tap: { usageOf: (request) => usageByRequest.get(request) ?? null, lastText: () => '', notJsonAsWritten: () => notJsonAsWritten },
  };
}

interface Tap {
  /** Účtenka volání, které dostalo tenhle požadavek; `null`, když poskytovatel žádnou nevydal. */
  usageOf: (request: UpstreamRequest) => Usage | null;
  lastText: () => string;
  /** Kolik odpovědí nebylo JSON tak, jak přišly (produkt je dopíše, nebo odmítne). */
  notJsonAsWritten: () => number;
}

/**
 * Fetch, který si z každé odpovědi opíše `usage` dřív, než ji `upstream`
 * spotřebuje. Tokeny jsou to, co předplatné doopravdy platí — `-fast`
 * varianta padla právě na nich, ne na čase.
 */
function usageTappingFetch(): Tap & { fetch: typeof fetch } {
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
    // HTTP cesta jede po jednom volání, takže „poslední" je to správné.
    usageOf: () => last,
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

function chunkTimes(calls: readonly CallRecord[]): { longestMs: number; sumMs: number; byChunk: Record<string, number> } | null {
  const chunked = calls.filter((call) => call.chunk !== null && !call.repair);
  if (chunked.length === 0) return null;
  const byChunk: Record<string, number> = {};
  for (const call of chunked) byChunk[call.chunk ?? '?'] = Math.round(call.ms);
  return { longestMs: Math.round(Math.max(...chunked.map((c) => c.ms))), sumMs: Math.round(chunked.reduce((t, c) => t + c.ms, 0)), byChunk };
}

/**
 * Čtyři fáze čekání na jednu větu, od odeslání (P21 T16). Fáze je `null`,
 * když k ní věta nedošla.
 *
 * - `massingPreviewMs` — plánovač odpověděl; hmotový náhled (T2) z jeho
 *   emise stojí milisekundy (`massing-preview.json`), takže se nepočítá zvlášť.
 * - `toFirstChunkMs` — první kus kompilátoru odpověděl. **Dnes se z něj nic
 *   nekreslí:** CLI proud nevydává (T3, `upstream-stream.test.ts`) a kusy se
 *   slepují až všechny naráz, takže je to spodní mez, ne to, co porotce vidí.
 * - `toFirstObjectMs` — první objekt na plátně; dnes totéž jako hratelný svět,
 *   protože objekty vzniknou až ze slepeného blueprintu.
 * - `toPlayableMs` — blueprint prošel branou a certifikací, hrdinové v hlíně.
 * - `toFullDetailMs` — hrdinové vymeshovaní, celá věta hotová.
 */
function phasesOf(outcome: CaseOutcome, calls: readonly CallRecord[]): Record<'massingPreviewMs' | 'toFirstChunkMs' | 'toFirstObjectMs' | 'toPlayableMs' | 'toFullDetailMs', number | null> {
  const planner = calls.find((call) => call.stage === 'planner');
  const chunks = calls.filter((call) => call.chunk !== null && !call.repair);
  const playable = outcome.compiledMs === undefined ? null : Math.round(outcome.compiledMs);
  return {
    massingPreviewMs: planner === undefined || !planner.ok ? null : Math.round(planner.endedAtMs),
    toFirstChunkMs: chunks.length === 0 ? null : Math.round(Math.min(...chunks.map((call) => call.endedAtMs))),
    toFirstObjectMs: playable,
    toPlayableMs: playable,
    toFullDetailMs: Math.round(outcome.latencyMs),
  };
}

/**
 * Měření ze 13. 9. 2026 pro srovnání — citované z commitnutého artefaktu,
 * ne opsané rukou, a **s počtem vět a účinkem**, protože šlo na pěti větách
 * jedním voláním na svět a tenhle běh na dvou větách po kusech.
 */
function baselineFor(model: string, caseIds: readonly string[]) {
  const report = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as {
    measuredAt: string;
    models: { model: string; cases: number; caseMedianMs: number; caseP95Ms: number; byStage: Record<string, { medianMs: number }>; perCase: { id: string; ms: number }[] }[];
  };
  const base = report.models.find((entry) => entry.model === model) ?? report.models[0];
  const effort = base.model.split('@')[1]?.split('#')[0] ?? 'unknown';
  return {
    measuredAt: report.measuredAt,
    file: 'evals/worldstream/latency-report.json',
    model: base.model,
    effort,
    cases: base.cases,
    caseIds: base.perCase.map((entry) => entry.id),
    caseMedianMs: base.caseMedianMs,
    caseP95Ms: base.caseP95Ms,
    plannerMedianMs: base.byStage.planner?.medianMs ?? null,
    compilerMedianMs: base.byStage.compiler?.medianMs ?? null,
    perCaseMs: Object.fromEntries(base.perCase.filter((entry) => caseIds.includes(entry.id)).map((entry) => [entry.id, entry.ms])),
    note:
      `Baseline measured ${report.measuredAt.slice(0, 10)} on ${String(base.cases)} sentences with ${base.model} ` +
      '(one compiler call per world, @' + effort + '); this run measures fewer sentences in concurrent chunks, ' +
      'so compare per sentence where the id matches, and read the medians as different denominators.',
  };
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
    chunked: CHUNKED,
    perCase: cases.map((c) => ({
      id: c.id,
      ms: Math.round(c.latencyMs),
      // Souběh se pozná tady: svět má trvat zhruba nejdelší kus, ne jejich součet.
      chunks: chunkTimes(calls.filter((call) => call.caseId === c.id)),
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
    const allOutcomes: CaseOutcome[] = [];

    try {
      for (const variant of variants) {
        const model = variant.label;
        const { upstream, tap } = ((): {
          upstream: { caseId: string; emit(request: UpstreamRequest): Promise<unknown> };
          tap: Tap;
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
          const caseStarted = performance.now();
          const done = await driveCreateCase(entry, {
            emit: async (request) => {
              // Pořadí se čte hned: tři kusy letí naráz a sdílený čítač by v `finally` ukázal všem třem totéž číslo.
              call += 1;
              const index = call;
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
                  P20_DIR ? join(P20_DIR, 'answers', `${entry.id}-${index}-failed.txt`) : fileURLToPath(new URL(`../../scratch/latency-failed-${model.replace('#', '+')}-${entry.id}-${String(index)}.txt`, import.meta.url)),
                  tap.lastText(),
                );
                throw thrown;
              } finally {
                if (P20_DIR) writeFileSync(join(P20_DIR, 'answers', `${entry.id}-${index}.json`), JSON.stringify({ request, answer, ok }, null, 2));
                const record: CallRecord = {
                  model,
                  caseId: entry.id,
                  call: index,
                  stage: requestStage(request),
                  chunk: requestChunk(request),
                  repair: request.user.startsWith(REPAIR_PREFIX),
                  reason: reasonOf(request),
                  ms: performance.now() - started,
                  endedAtMs: performance.now() - caseStarted,
                  requestBytes: Buffer.byteLength(request.system) + Buffer.byteLength(request.user),
                  answerBytes: Buffer.byteLength(JSON.stringify(answer ?? null)),
                  inputTokens: tap.usageOf(request)?.inputTokens ?? null,
                  outputTokens: tap.usageOf(request)?.outputTokens ?? null,
                  ok,
                };
                modelCalls.push(record);
                raw.push(record);
                if (P20_DIR) writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
                process.stdout.write(
                  `  ${entry.id} #${call} ${record.stage ?? '?'}${record.chunk === null ? '' : `/${record.chunk}`}${record.repair ? ' repair' : ''} ${Math.round(record.ms)} ms ${record.answerBytes} B in ${String(record.inputTokens ?? '?')} out ${String(record.outputTokens ?? '?')}${record.reason ? ` · ${record.reason}` : ''}\n`,
                );
              }
              return answer;
            },
            mesh: mesh.mesh,
            grammar: grammar.value,
            sessionSeed: SESSION_SEED,
            chunked: CHUNK_PIECES ?? false,
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
        allOutcomes.push(...outcomes);
      }
    } finally {
      mesh.dispose();
      mkdirSync(fileURLToPath(new URL('../../scratch/', import.meta.url)), { recursive: true });
      writeFileSync(RAW_FILE, JSON.stringify(raw, null, 2));
      const caseIds = cases.map((c) => c.id);
      const measuredAt = new Date().toISOString();
      if (PHASE5 && !P20_DIR) {
        // T21: blok `phase5` vedle běhu z 19. 9. ráno. Čte se existující soubor
        // a dopisuje se do něj — přepsat ho by vzalo citaci, na které stojí T16.
        const variant = variants[0];
        const previous = JSON.parse(readFileSync(P21_FILE, 'utf8')) as {
          measuredAt: string;
          summary: { byStage: Record<string, { medianMs: number; medianAnswerBytes: number }> } | null;
          calls: { stage: string | null; repair: boolean; outputTokens: number | null }[];
        };
        const baseline = baselineFor(variant.label, caseIds);
        const stat = (stage: 'planner' | 'compiler') => {
          const fresh = raw.filter((c) => c.stage === stage && !c.repair);
          if (fresh.length === 0) return null;
          const tokens = fresh.flatMap((c) => (c.outputTokens === null ? [] : [c.outputTokens]));
          return {
            n: fresh.length,
            medianMs: Math.round(median(fresh.map((c) => c.ms))),
            p95Ms: Math.round(percentile95(fresh.map((c) => c.ms))),
            medianAnswerBytes: Math.round(median(fresh.map((c) => c.answerBytes))),
            medianOutputTokens: tokens.length === 0 ? null : Math.round(median(tokens)),
          };
        };
        const morningPlannerTokens = previous.calls.filter((c) => c.stage === 'planner' && !c.repair).flatMap((c) => (c.outputTokens === null ? [] : [c.outputTokens]));
        const phase5 = {
          measuredAt,
          plan: 'P21 T21 – one live run after T18 (slim sceneSpec) + T19 (planner at low effort)',
          model: variant.label,
          effort: variant.effort ?? 'medium',
          plannerEffort: STAGE_EFFORT.planner ?? variant.effort ?? 'medium',
          cases: cases.length,
          caseIds,
          chunked: false,
          callCap: Number(process.env.WORLDSMITH_CALL_CAP ?? NaN),
          calls: raw.length,
          byStage: { planner: stat('planner'), compiler: stat('compiler') },
          previous: {
            morning19: {
              measuredAt: previous.measuredAt,
              plannerMedianMs: previous.summary?.byStage.planner?.medianMs ?? null,
              plannerAnswerBytes: previous.summary?.byStage.planner?.medianAnswerBytes ?? null,
              plannerOutputTokens: morningPlannerTokens.length === 0 ? null : Math.round(median(morningPlannerTokens)),
              note: 'the 2026-09-19 morning run above in this file: chunked compiler, planner on the environment effort, full sceneSpec',
            },
            baseline13: { measuredAt: baseline.measuredAt, plannerMedianMs: baseline.plannerMedianMs, note: baseline.note },
          },
          target: { plannerMs: 30_000, answerBytes: 4_000, note: 'P21 T21 goal, stated as a goal – the measured number decides, not this line' },
          perCase: allOutcomes.map((outcome) => {
            const mine = raw.filter((call) => call.caseId === outcome.id);
            const planner = mine.find((call) => call.stage === 'planner');
            const compiler = mine.find((call) => call.stage === 'compiler' && !call.repair);
            return {
              id: outcome.id,
              plannerMs: planner === undefined ? null : Math.round(planner.ms),
              plannerAnswerBytes: planner?.answerBytes ?? null,
              plannerOutputTokens: planner?.outputTokens ?? null,
              compilerMs: compiler === undefined ? null : Math.round(compiler.ms),
              rounds: outcome.rounds,
              authored: outcome.geometryAuthored,
              certified: outcome.certified,
              failure: outcome.failure,
              phases: phasesOf(outcome, mine),
            };
          }),
          calls5: raw.map(({ model: _model, requestBytes: _bytes, ...call }) => ({ ...call, ms: Math.round(call.ms), endedAtMs: Math.round(call.endedAtMs) })),
        };
        writeFileSync(P21_FILE, `${JSON.stringify({ ...previous, phase5 }, null, 2)}\n`);
      } else if (CHUNK_PIECES === 2 && !P20_DIR) {
        // P22 T16: blok `p22chunks2` vedle `phase5`. Soubor se čte a dopisuje,
        // nikdy nepřepisuje — `phase5` je baseline, proti které se tu rozhoduje.
        const variant = variants[0];
        const previous = JSON.parse(readFileSync(P21_FILE, 'utf8')) as {
          phase5?: {
            measuredAt: string;
            byStage: { planner: { medianMs: number } | null; compiler: { medianMs: number } | null };
            perCase: { id: string; compilerMs: number | null; phases: { toPlayableMs: number | null } }[];
          };
        };
        const phase5 = previous.phase5;
        const plannerCalls = raw.filter((c) => c.stage === 'planner' && !c.repair);
        const plannerTokens = plannerCalls.flatMap((c) => (c.outputTokens === null ? [] : [c.outputTokens]));
        const perCase = allOutcomes.map((outcome) => {
          const mine = raw.filter((call) => call.caseId === outcome.id);
          const planner = mine.find((call) => call.stage === 'planner');
          const pieces = mine.filter((call) => call.chunk !== null && !call.repair);
          const phases = phasesOf(outcome, mine);
          const base = phase5?.perCase.find((entry) => entry.id === outcome.id);
          return {
            id: outcome.id,
            plannerMs: planner === undefined ? null : Math.round(planner.ms),
            plannerOutputTokens: planner?.outputTokens ?? null,
            pieces: pieces.length === 0 ? null : Object.fromEntries(pieces.map((c) => [c.chunk ?? '?', Math.round(c.ms)])),
            piecesSumMs: pieces.length === 0 ? null : Math.round(pieces.reduce((t, c) => t + c.ms, 0)),
            piecesLongestMs: pieces.length === 0 ? null : Math.round(Math.max(...pieces.map((c) => c.ms))),
            // Kusy letí naráz: stěna je od odeslání prvního po odpověď posledního; slepení je čistá funkce pod milisekundu.
            compilerWallMs:
              pieces.length === 0 ? null : Math.round(Math.max(...pieces.map((c) => c.endedAtMs)) - Math.min(...pieces.map((c) => c.endedAtMs - c.ms))),
            playableMs: phases.toPlayableMs,
            rounds: outcome.rounds,
            authored: outcome.geometryAuthored,
            certified: outcome.certified,
            failure: outcome.failure,
            phases,
            phase5: base === undefined ? null : { compilerMs: base.compilerMs, playableMs: base.phases.toPlayableMs },
          };
        });
        const sums = perCase.flatMap((entry) => (entry.piecesSumMs === null ? [] : [entry.piecesSumMs]));
        const walls = perCase.flatMap((entry) => (entry.compilerWallMs === null ? [] : [entry.compilerWallMs]));
        const complete = perCase.length === cases.length && raw.every((c) => c.ok);
        // Rozhodnutí: dva kusy vyhrávají jen když **obě** věty došly k hratelnému
        // světu a v obou byl ten svět hratelný dřív než u jediného volání (phase5).
        const faster = perCase.map((entry) => {
          const single = entry.phase5?.playableMs ?? null;
          return entry.playableMs !== null && (single === null || entry.playableMs < single);
        });
        const chunked2Default = complete && perCase.length === 2 && faster.every(Boolean);
        const describe = (entry: (typeof perCase)[number]) =>
          `${entry.id}: two pieces playable at ${String(entry.playableMs)} ms (${
            entry.failure === null ? 'ok' : `${entry.failure.stage}: ${entry.failure.detail.slice(0, 120)}`
          }) vs single call playable at ${String(entry.phase5?.playableMs ?? null)} ms`;
        const reason = !complete
          ? `partial run: ${String(perCase.length)} of ${String(cases.length)} cases, ${String(raw.filter((c) => !c.ok).length)} failed call(s); ${perCase.map(describe).join('; ')}`
          : chunked2Default
            ? `two pieces reached a playable world faster than the single compiler call in both cases; ${perCase.map(describe).join('; ')}`
            : perCase.map(describe).join('; ');
        const p22chunks2 = {
          measuredAt,
          plan: 'P22 T16 – two pieces (scene + rules) against the single compiler call of phase5, one live run',
          model: variant.label,
          effort: variant.effort ?? 'medium',
          plannerEffort: STAGE_EFFORT.planner ?? variant.effort ?? 'medium',
          // Úsilí kusu rozhoduje `upstream.ts` z textu požadavku, ne popisek varianty.
          pieceEffort: { scene: CHUNK_EFFORT.scene, rules: CHUNK_EFFORT.rules },
          cases: perCase.length,
          caseIds: perCase.map((entry) => entry.id),
          chunked: 2,
          pieces: ['scene', 'rules'],
          callCap: Number(process.env.WORLDSMITH_CALL_CAP ?? NaN),
          calls: raw.length,
          ...(complete ? {} : { partial: true, reason }),
          byStage: {
            planner:
              plannerCalls.length === 0
                ? null
                : {
                    n: plannerCalls.length,
                    medianMs: Math.round(median(plannerCalls.map((c) => c.ms))),
                    p95Ms: Math.round(percentile95(plannerCalls.map((c) => c.ms))),
                    medianAnswerBytes: Math.round(median(plannerCalls.map((c) => c.answerBytes))),
                    medianOutputTokens: plannerTokens.length === 0 ? null : Math.round(median(plannerTokens)),
                  },
            compiler:
              sums.length === 0
                ? null
                : {
                    n: sums.length,
                    medianMs: Math.round(median(sums)),
                    wallMedianMs: Math.round(median(walls)),
                    note: 'medianMs is the sum of the two pieces plus merge per world (what the subscription pays); wallMedianMs is first piece sent to last piece answered (what the judge waits); merge is sub-millisecond',
                  },
          },
          playableMs: Object.fromEntries(perCase.map((entry) => [entry.id, entry.playableMs])),
          baseline: {
            phase5: {
              measuredAt: phase5?.measuredAt ?? null,
              plannerMedianMs: phase5?.byStage.planner?.medianMs ?? null,
              compilerMedianMs: phase5?.byStage.compiler?.medianMs ?? null,
              playableMs: Object.fromEntries((phase5?.perCase ?? []).map((entry) => [entry.id, entry.phases.toPlayableMs])),
              note: 'the phase5 block in this file: one compiler call per world at the environment effort, planner at low, same two sentences',
            },
          },
          decision: { chunked2Default, reason },
          perCase,
          calls2: raw.map(({ model: _model, requestBytes: _bytes, ...call }) => ({ ...call, ms: Math.round(call.ms), endedAtMs: Math.round(call.endedAtMs) })),
        };
        writeFileSync(P21_FILE, `${JSON.stringify({ ...previous, p22chunks2 }, null, 2)}\n`);
      } else if (CHUNKED && !P20_DIR) {
        // P21 artefakt: jedna varianta, fáze na větu, staré číslo vedle nového
        // a každé volání s kusem a spotřebou (orákulum T5).
        const variant = variants[0];
        const baseline = baselineFor(variant.label, caseIds);
        writeFileSync(
          P21_FILE,
          `${JSON.stringify({
            measuredAt,
            plan: 'P21 T5 + T16 – one live run after the phase-1 changes',
            model: variant.label,
            effort: variant.effort ?? 'medium',
            cases: cases.length,
            caseIds,
            chunked: true,
            callCap: Number(process.env.WORLDSMITH_CALL_CAP ?? NaN),
            sessionSeed: SESSION_SEED,
            baseline,
            summary: summaries[0] ?? null,
            perCase: allOutcomes.map((outcome) => {
              const entry = cases.find((c) => c.id === outcome.id);
              return {
                id: outcome.id,
                prompt: entry?.prompt ?? '',
                phases: phasesOf(outcome, raw.filter((call) => call.caseId === outcome.id)),
                chunks: chunkTimes(raw.filter((call) => call.caseId === outcome.id)),
                rounds: outcome.rounds,
                authored: outcome.geometryAuthored,
                certified: outcome.certified,
                failure: outcome.failure,
                baselineMs: baseline.perCaseMs[outcome.id] ?? null,
              };
            }),
            calls: raw.map(({ model: _model, requestBytes: _bytes, ...call }) => ({ ...call, ms: Math.round(call.ms), endedAtMs: Math.round(call.endedAtMs) })),
          }, null, 2)}\n`,
        );
      } else {
        writeFileSync(
          REPORT_FILE,
          `${JSON.stringify({ measuredAt, sessionSeed: SESSION_SEED, caseIds, models: summaries }, null, 2)}\n`,
        );
      }
    }

    expect(summaries.length).toBe(variants.length);
    if (P20_DIR) expect(summaries.every((summary) => summary.cases === cases.length), 'incomplete live baseline; see outcomes.json').toBe(true);
  }, 180 * 60_000);
});
