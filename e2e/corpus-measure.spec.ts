/**
 * Živé měření celé zamčené sady 200 vět (P12 V1 T8).
 * `@measure` ho drží mimo běžnou e2e sadu; běží jen přes measure:corpus.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  CORPUS_REPORT_PATH,
  buildCorpusReport,
  inspectCorpusIntegrity,
  loadCorpusCases,
  measurementFailure,
  scoreCorpusAttempt,
  splitCorpusCases,
  type CorpusAttempt,
  type CorpusCase,
} from '../evals/measure-corpus';
import { measurementRequest, PRIMARY_MODEL } from '../evals/local-model/measure-grammar';
import { recognize } from '../src/model/local/shapes';

const WEBLLM_ROUTE = '/__webllm-corpus.js';
const HOST_ROUTE = '/__webllm-corpus-host.html';
const WEBLLM_BUNDLE = join('node_modules', '@mlc-ai', 'web-llm', 'lib', 'index.js');
const PROFILE_DIR = join(process.cwd(), 'tmp-webllm-profile');

interface MeasurementBrowser {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly adapter: string;
}

async function openMeasurementBrowser(hostUrl: string, bundle: string): Promise<MeasurementBrowser> {
  // `args: []` přepíše SwiftShader z hlavní konfigurace. Persistentní profil
  // drží již stažených ~979 MB vah.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: true,
    args: [],
  });
  await context.route(`**${WEBLLM_ROUTE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle }),
  );
  await context.route(`**${HOST_ROUTE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>corpus measure</title>' }),
  );
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(hostUrl);
  const adapter = await page.evaluate(async () => {
    let found: GPUAdapter | null = null;
    for (let attempt = 0; attempt < 20 && !found && navigator.gpu; attempt += 1) {
      found = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
      if (!found) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return found ? `${found.info.vendor || '?'}/${found.info.architecture || '?'}` : 'none';
  });
  console.log(`[gpu] adapter: ${adapter}`);
  return { context, page, adapter };
}

async function runModel(
  page: Page,
  cases: readonly CorpusCase[],
  onAttempt: (attempt: CorpusAttempt) => void,
  onProgress: (text: string) => void,
): Promise<CorpusAttempt[]> {
  await page.exposeFunction('__corpusAttempt', onAttempt);
  await page.exposeFunction('__corpusProgress', onProgress);
  return page.evaluate(
    async (input) => {
      const scope = window as unknown as {
        __corpusAttempt(attempt: CorpusAttempt): Promise<void>;
        __corpusProgress(text: string): Promise<void>;
      };
      const webllm = (await import(/* webpackIgnore: true */ input.moduleUrl)) as {
        CreateMLCEngine(model: string, config: { initProgressCallback(report: { text: string }): void }): Promise<{
          chat: { completions: { create(request: unknown): Promise<{
            choices: { finish_reason?: string; message?: { content?: string | null } }[];
          }> } };
          reload(model: string): Promise<void>;
          unload(): Promise<void>;
        }>;
      };
      let engine = await webllm.CreateMLCEngine(input.modelId, {
        initProgressCallback: (report) => void scope.__corpusProgress(report.text),
      });
      const attempts: CorpusAttempt[] = [];
      for (const entry of input.cases) {
        const started = performance.now();
        let attempt: CorpusAttempt;
        try {
          const reply = await engine.chat.completions.create(entry.request);
          attempt = {
            id: entry.id, source: 'model', latencyMs: Math.round(performance.now() - started),
            finishReason: reply.choices[0]?.finish_reason ?? '',
            raw: reply.choices[0]?.message?.content ?? '', error: '',
          };
        } catch (thrown) {
          attempt = {
            id: entry.id, source: 'model', latencyMs: Math.round(performance.now() - started),
            finishReason: '', raw: '',
            error: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown),
          };
        }
        attempts.push(attempt);
        await scope.__corpusAttempt(attempt);
        if (attempt.error) {
          try {
            await engine.reload(input.modelId);
          } catch {
            engine = await webllm.CreateMLCEngine(input.modelId, {
              initProgressCallback: (report) => void scope.__corpusProgress(report.text),
            });
          }
        }
      }
      await engine.unload().catch(() => undefined);
      return attempts;
    },
    {
      moduleUrl: WEBLLM_ROUTE,
      modelId: PRIMARY_MODEL,
      cases: cases.map((entry) => ({ id: entry.id, request: measurementRequest(entry.system, entry.user) })),
    },
  );
}

test('@measure celý zmrazený korpus projde produkční lokální cestou', async () => {
  test.setTimeout(4 * 60 * 60 * 1000);

  const before = inspectCorpusIntegrity();
  expect(measurementFailure(before, 200), 'korpus se před během rozešel se zámkem nebo HEAD').toBeNull();
  const allCases = loadCorpusCases();
  const { handled, forModel } = splitCorpusCases(allCases);
  expect(allCases).toHaveLength(200);
  expect(handled).toHaveLength(26);
  expect(forModel).toHaveLength(174);

  const baseUrl = test.info().project.use.baseURL;
  expect(baseUrl, 'projekt nemá baseURL').toBeTruthy();
  const bundle = readFileSync(WEBLLM_BUNDLE, 'utf8');
  const hostUrl = new URL(HOST_ROUTE, baseUrl as string).toString();
  const { context, page, adapter } = await openMeasurementBrowser(hostUrl, bundle);

  try {
    console.log(`[routing] recognizer=${handled.length}, model=${forModel.length}`);
    let done = 0;
    const modelAttempts = await runModel(
      page,
      forModel,
      (attempt) => {
        done += 1;
        console.log(
          `[${PRIMARY_MODEL}] ${done}/${forModel.length} ${attempt.id} ${attempt.latencyMs}ms ${attempt.error || attempt.finishReason}`,
        );
      },
      (text) => console.log(`[${PRIMARY_MODEL}] ${text}`),
    );

    const attempts = new Map(modelAttempts.map((attempt) => [attempt.id, attempt]));
    for (const entry of handled) {
      const body = recognize(entry.text);
      if (body === null) throw new Error(`${entry.id}: routing se mezi dvěma průchody rozešel`);
      attempts.set(entry.id, {
        id: entry.id,
        source: 'recognizer',
        latencyMs: 0,
        finishReason: 'shapes',
        raw: JSON.stringify(body),
        error: '',
      });
    }

    const measured = allCases
      .map((entry) => {
        const attempt = attempts.get(entry.id);
        return attempt === undefined ? null : scoreCorpusAttempt(entry, attempt);
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const after = inspectCorpusIntegrity();
    const report = buildCorpusReport({
      measuredAt: new Date().toISOString(),
      adapter,
      model: PRIMARY_MODEL,
      manifestSha256: after.manifestSha256,
      cases: measured,
    });

    // Zápis je před asercí úplnosti: neúplný běh je pořád evidence. Nízké skóre
    // žádnou aserci nemá a proces kvůli němu nekončí nenulově.
    writeFileSync(CORPUS_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    expect(adapter, 'WebGPU adaptér nebyl dostupný; nešlo o měření modelu').not.toBe('none');
    expect(measurementFailure(after, report.attempts)).toBeNull();
  } finally {
    await context.close();
  }
});
