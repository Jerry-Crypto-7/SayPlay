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
  driveCorpusCase,
  inspectCorpusIntegrity,
  loadCorpusCases,
  measurementFailure,
  recognizerAttempt,
  scoreCorpusAttempt,
  splitCorpusCases,
  type CorpusAttempt,
  type CorpusCase,
} from '../evals/measure-corpus';
import { measurementRequest, PRIMARY_MODEL } from '../evals/local-model/measure-grammar';
import { recognize } from '../src/model/local/shapes';

import type { ChatEngine, Completion } from '../src/model/local/engine';

/**
 * Zkrácený běh pro ověření samotného řetězu, ne pro měření (`CORPUS_SMOKE=3`).
 *
 * Celá sada stojí přes dvě hodiny GPU, takže chyba v lepidle na model se jinak
 * pozná až na jejím konci. Zkrácený běh **report nezapisuje a nikdy neuspěje**:
 * kdyby uměl obojí, jednou by přepsal commitnutá čísla třemi větami a tři
 * dokumenty by si dál myslely, že platí.
 */
const SMOKE_CASES = Number(process.env.CORPUS_SMOKE ?? '0');

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

/**
 * Model na stránce jako `ChatEngine`, tedy přesně to rozhraní, které bere
 * `emitLocally()`.
 *
 * ⚠ **Smyčku řídí Node, ne prohlížeč — a musí to tak být.** Druhé kolo se ptá,
 * co bylo špatně, a to ví jen certifikace (`src/model/certify.ts`) s větou z
 * `rejection-prompt.ts`. Vtáhnout obojí do `page.evaluate` by znamenalo druhou
 * kopii produkční cesty uvnitř měřidla. Cena je jedno kolečko mezi procesy na
 * emisi, tedy jednotky milisekund proti ~34 sekundám, které stojí sama emise.
 */
async function loadPageEngine(page: Page, onProgress: (text: string) => void): Promise<ChatEngine> {
  await page.exposeFunction('__corpusProgress', onProgress);
  await page.evaluate(
    async (input) => {
      const scope = window as unknown as {
        __corpusProgress(text: string): Promise<void>;
        __corpusEngine: unknown;
        __corpusModule: unknown;
      };
      const webllm = (await import(/* webpackIgnore: true */ input.moduleUrl)) as {
        CreateMLCEngine(model: string, config: { initProgressCallback(report: { text: string }): void }): Promise<unknown>;
      };
      scope.__corpusModule = webllm;
      scope.__corpusEngine = await webllm.CreateMLCEngine(input.modelId, {
        initProgressCallback: (report) => void scope.__corpusProgress(report.text),
      });
    },
    { moduleUrl: WEBLLM_ROUTE, modelId: PRIMARY_MODEL },
  );

  return {
    modelId: PRIMARY_MODEL,
    complete: (system, user) =>
      page.evaluate(async (request) => {
        const scope = window as unknown as {
          __corpusEngine: {
            chat: {
              completions: {
                create(request: unknown): Promise<{
                  choices: { finish_reason?: string; message?: { content?: string | null } }[];
                }>;
              };
            };
          };
        };
        const reply = await scope.__corpusEngine.chat.completions.create(request);
        return {
          raw: reply.choices[0]?.message?.content ?? '',
          finishReason: reply.choices[0]?.finish_reason ?? '',
        };
      }, measurementRequest(system, user)) as Promise<Completion>,
    unload: () =>
      page.evaluate(async () => {
        const scope = window as unknown as { __corpusEngine: { unload(): Promise<void> } };
        await scope.__corpusEngine.unload().catch(() => undefined);
      }),
  };
}

/** Po pádu vah se model postaví znovu — jinak by na něm ztroskotal celý zbytek sady. */
async function reloadPageEngine(page: Page): Promise<void> {
  await page.evaluate(
    async (input) => {
      const scope = window as unknown as {
        __corpusProgress(text: string): Promise<void>;
        __corpusEngine: { reload(model: string): Promise<void> };
        __corpusModule: {
          CreateMLCEngine(model: string, config: { initProgressCallback(report: { text: string }): void }): Promise<unknown>;
        };
      };
      try {
        await scope.__corpusEngine.reload(input.modelId);
      } catch {
        scope.__corpusEngine = (await scope.__corpusModule.CreateMLCEngine(input.modelId, {
          initProgressCallback: (report) => void scope.__corpusProgress(report.text),
        })) as { reload(model: string): Promise<void> };
      }
    },
    { modelId: PRIMARY_MODEL },
  );
}

/** Každá věta jde celou produkční cestou včetně opravné smyčky (`driveCorpusCase`). */
async function runModel(
  page: Page,
  cases: readonly CorpusCase[],
  onAttempt: (attempt: CorpusAttempt) => void,
  onProgress: (text: string) => void,
): Promise<CorpusAttempt[]> {
  const engine = await loadPageEngine(page, onProgress);
  const attempts: CorpusAttempt[] = [];

  for (const entry of cases) {
    const attempt = await driveCorpusCase(entry, engine);
    attempts.push(attempt);
    onAttempt(attempt);
    if (attempt.error) await reloadPageEngine(page);
  }

  await engine.unload().catch(() => undefined);
  return attempts;
}

test('@measure celý zmrazený korpus projde produkční lokální cestou', async () => {
  test.setTimeout(4 * 60 * 60 * 1000);

  const before = inspectCorpusIntegrity();
  expect(measurementFailure(before, 200), 'korpus se před během rozešel se zámkem nebo HEAD').toBeNull();
  const allCases = loadCorpusCases();
  const routed = splitCorpusCases(allCases);
  const handled = routed.handled;
  const forModel = SMOKE_CASES > 0 ? routed.forModel.slice(0, SMOKE_CASES) : routed.forModel;
  expect(allCases).toHaveLength(200);
  expect(handled).toHaveLength(26);
  if (SMOKE_CASES === 0) expect(forModel).toHaveLength(174);

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
        const rounds = attempt.rounds.map((round) => round.stage ?? 'passed').join('>');
        console.log(
          `[${PRIMARY_MODEL}] ${done}/${forModel.length} ${attempt.id} ${attempt.latencyMs}ms ${rounds} ${attempt.error || attempt.finishReason}`,
        );
      },
      (text) => console.log(`[${PRIMARY_MODEL}] ${text}`),
    );

    const attempts = new Map(modelAttempts.map((attempt) => [attempt.id, attempt]));
    for (const entry of handled) {
      const body = recognize(entry.text);
      if (body === null) throw new Error(`${entry.id}: routing se mezi dvěma průchody rozešel`);
      attempts.set(entry.id, recognizerAttempt(entry, body));
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
    // Zkrácený běh se do reportu nedostane. Zapsat tři věty tam, kde stálo
    // dvě stě, by přepsalo číslo, které cituje `decision.md`, plán i report.
    if (SMOKE_CASES === 0) writeFileSync(CORPUS_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(
      `[rounds] histogram=${JSON.stringify(report.rounds.histogram)} kolo1=${report.rounds.passedFirstRound}` +
        ` konec=${report.rounds.passedAfterRepair} zisk=${report.rounds.gainPoints} p.b.`,
    );
    expect(adapter, 'WebGPU adaptér nebyl dostupný; nešlo o měření modelu').not.toBe('none');
    // Zkrácený běh nikdy neuspěje — je to kontrola řetězu, ne měření, a zelená
    // by se od skutečného běhu nedala rozeznat.
    expect(measurementFailure(after, SMOKE_CASES > 0 ? 0 : report.attempts)).toBeNull();
  } finally {
    await context.close();
  }
});
