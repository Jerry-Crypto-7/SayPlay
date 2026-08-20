/**
 * Změří, jestli Qwen3 běžící v prohlížeči udrží vynucený tvar emise (P11 T5).
 *
 * ## Proč si tenhle test spouští vlastní prohlížeč
 *
 * Naměřeno 20. 8. 2026 na tomhle stroji: Chromium, které vozí Playwright,
 * **WebGPU zařízení nedostane**. Adaptér vrátí (NVIDIA Ampere), ale
 * `requestDevice()` skončí na `DynamicLib.Open: dxil.dll Windows Error: 87` —
 * v balíčku chybí knihovny kompilátoru shaderů pro D3D12. Systémové Chrome
 * (`channel: 'chrome'`) zařízení vrátí i bezobslužně. Bez vlastního spuštění
 * by tenhle test měřil model, který se nikdy nespustí.
 *
 * Druhý důvod je mezipaměť. Váhy mají 979 MB a WebLLM je ukládá do Cache API,
 * tedy do profilu prohlížeče. Playwright dělá na každý běh nový profil, takže by
 * se stahovalo pokaždé znovu. `launchPersistentContext` nad `tmp-webllm-profile`
 * to platí jednou.
 *
 * ## Proč se WebLLM podává stránce ručně
 *
 * `@mlc-ai/web-llm` je jeden soběstačný ESM soubor bez jediného importu (6,5 MB),
 * takže ho stačí odchytit na vlastní adrese ve stejném původu a stránka ho
 * naimportuje. Alternativa — přibalit ho do aplikace jen kvůli měření — by kvůli
 * testu přidala cestu do produkčního bundlu.
 *
 * ## Značka `@measure`
 *
 * Běh trvá desítky minut a stahuje skoro gigabajt. `npm run test:e2e` ho proto
 * vynechává (`--grep-invert @measure`) a spouští ho jen `npm run measure:grammar`.
 * Kdyby značka chyběla, běžná e2e sada by přestala být použitelná.
 */

import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  buildReport,
  FORCED_SHAPE_SCHEMA,
  MAX_OUTPUT_TOKENS,
  MEASURED_SENTENCES,
  measurementShortfall,
  PRIMARY_MODEL,
  RAW_ARCHIVE_PATH,
  REPORT_PATH,
  REPRODUCTION_MODEL,
  buildRawArchive,
  loadSentences,
  mergeRecords,
  splitByRecognizer,
  summarize,
  type AttemptRecord,
  type MeasuredSentence,
} from '../evals/local-model/measure-grammar';

/** Adresa, na které stránka uvidí ESM balík WebLLM. Aplikace ji sama neobsluhuje. */
const WEBLLM_ROUTE = '/__webllm-measure.js';

/**
 * Hostitelská stránka měření. Je prázdná schválně.
 *
 * Původ musí být `http://127.0.0.1:...`, protože `navigator.gpu` je jen
 * v zabezpečeném kontextu — proto se jede přes běžící server a ne přes
 * `about:blank`. Obsah stránky ale odchytáváme, aby měření nedědilo hlavičky
 * aplikace: přísné CSP by zakázalo `wasm-unsafe-eval` a WebLLM by se nespustil,
 * což by se naměřilo jako vada modelu, ačkoli by šlo o vadu prostředí testu.
 */
const HOST_ROUTE = '/__webllm-measure-host.html';

const WEBLLM_BUNDLE = join('node_modules', '@mlc-ai', 'web-llm', 'lib', 'index.js');

/** Profil, ve kterém přežije stažená mezipaměť vah. `tmp-*` je v `.gitignore`. */
const PROFILE_DIR = join(process.cwd(), 'tmp-webllm-profile');

/**
 * Otevře prohlížeč, ve kterém **doopravdy je** hardwarový WebGPU adaptér.
 *
 * ## Prázdné `args` nejsou formalita, jsou to celý ten fígl
 *
 * Naměřeno 20. 8. 2026 porovnáním příkazových řádek (`DEBUG=pw:browser`):
 * když se `launchPersistentContext` zavolá **bez** klíče `args`, běžec doplní
 * `launchOptions.args` z `playwright.config.ts` — a tam stojí
 * `--use-gl=angle --use-angle=swiftshader`. To je pro zbytek sady správně
 * (WebGL2 přes SwiftShader je jediný způsob, jak tu vůbec něco vykreslit), ale
 * pro tenhle test je to smrtelné: SwiftShader je softwarový renderer, takže
 * `requestAdapter()` nevrátí nic a WebLLM ohlásí „Unable to find a compatible
 * GPU" na stroji s NVIDIA Ampere. Vlastní pole `args` ta zděděná přepíše.
 * Prázdné je schválně: chceme přesně výchozí Chrome, nic navíc.
 *
 * ## Proč vlastní prohlížeč a ne `page` z fixture
 *
 * Chromium, které vozí Playwright, adaptér vrátí, ale `requestDevice()` skončí
 * na `DynamicLib.Open: dxil.dll Windows Error: 87` — chybí knihovny kompilátoru
 * shaderů pro D3D12. Systémové Chrome (`channel: 'chrome'`) zařízení vrátí
 * i bezobslužně. A druhý důvod: váhy mají 979 MB a WebLLM je ukládá do Cache API,
 * tedy do profilu. Playwright dělá na každý běh nový profil, takže by se
 * stahovalo pokaždé znovu; `launchPersistentContext` to platí jednou.
 */
interface MeasurementBrowser {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly adapter: string;
}

async function openMeasurementBrowser(hostUrl: string, bundle: string): Promise<MeasurementBrowser> {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: true,
    args: [],
  });
  await context.route(`**${WEBLLM_ROUTE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle }),
  );
  await context.route(`**${HOST_ROUTE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>measure</title>' }),
  );

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(hostUrl);

  // GPU proces Chrome nemusí být hotový v okamžiku, kdy stránka doběhne, a
  // WebLLM si o adaptér řekne přesně jednou. Deset sekund je strop, ne čekání.
  const adapter = await page.evaluate(async () => {
    let probed: GPUAdapter | null = null;
    for (let attempt = 0; attempt < 20 && !probed && navigator.gpu; attempt += 1) {
      probed = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
      if (!probed) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return probed ? `${probed.info.vendor || '?'}/${probed.info.architecture || '?'}` : 'none';
  });

  console.log(`[gpu] adaptér: ${adapter}`);
  return { context, page, adapter };
}

interface PageRunResult {
  readonly records: AttemptRecord[];
}

/**
 * Odjede jeden model nad zadanými větami **uvnitř stránky**.
 *
 * `recover` je tu kvůli tomu, jak vypadá pád xgrammar: WASM runtime se ukončí a
 * od té chvíle padá každé další volání. Bez znovunačtení modelu by jedna vada ve
 * třetí větě proměnila zbývajících 37 měření na kopie téhož pádu a report by
 * tvrdil něco o modelu, co je ve skutečnosti o jednom mrtvém runtimu.
 */
async function runModel(
  page: Page,
  options: {
    readonly modelId: string;
    readonly sentences: readonly MeasuredSentence[];
    readonly stopAtFirstBug: boolean;
    readonly onAttempt: (record: AttemptRecord) => void;
    readonly onProgress: (text: string) => void;
  },
): Promise<PageRunResult> {
  // Každý model dostane vlastní stránku: `exposeFunction` pod stejným jménem
  // podruhé na téže stránce skončí výjimkou, a druhý běh je tu právě proto,
  // aby doběhl.
  await page.exposeFunction('__measureAttempt', options.onAttempt);
  await page.exposeFunction('__measureProgress', options.onProgress);

  return page.evaluate(
    async (input) => {
      const scope = window as unknown as {
        __measureAttempt(record: unknown): Promise<void>;
        __measureProgress(text: string): Promise<void>;
      };

      const webllm = (await import(/* webpackIgnore: true */ input.moduleUrl)) as {
        CreateMLCEngine(
          model: string,
          config: { initProgressCallback(report: { text: string }): void },
        ): Promise<{
          chat: {
            completions: {
              create(request: unknown): Promise<{
                choices: { finish_reason?: string; message?: { content?: string | null } }[];
              }>;
            };
          };
          reload(model: string): Promise<void>;
          unload(): Promise<void>;
        }>;
      };

      let engine = await webllm.CreateMLCEngine(input.modelId, {
        initProgressCallback: (report) => void scope.__measureProgress(report.text),
      });

      const records: {
        id: string;
        latencyMs: number;
        finishReason: string;
        raw: string;
        error: string;
      }[] = [];

      for (const sentence of input.sentences) {
        const started = performance.now();
        let record: (typeof records)[number];
        try {
          const reply = await engine.chat.completions.create({
            messages: [
              { role: 'system', content: sentence.system },
              { role: 'user', content: sentence.user },
            ],
            response_format: { type: 'json_object', schema: input.schema },
            max_tokens: input.maxTokens,
            temperature: 0,
            seed: 1,
          });
          record = {
            id: sentence.id,
            latencyMs: Math.round(performance.now() - started),
            finishReason: reply.choices[0]?.finish_reason ?? '',
            raw: reply.choices[0]?.message?.content ?? '',
            error: '',
          };
        } catch (thrown) {
          const message = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
          record = {
            id: sentence.id,
            latencyMs: Math.round(performance.now() - started),
            finishReason: '',
            raw: '',
            error: message,
          };
        }

        records.push(record);
        await scope.__measureAttempt(record);

        if (record.error) {
          if (input.stopAtFirstBug && (record.error.includes('Invalid token id') || record.error.includes('GetVocabSize'))) {
            break;
          }
          try {
            await engine.reload(input.modelId);
          } catch {
            engine = await webllm.CreateMLCEngine(input.modelId, {
              initProgressCallback: (report) => void scope.__measureProgress(report.text),
            });
          }
        }
      }

      await engine.unload().catch(() => undefined);
      return { records };
    },
    {
      moduleUrl: WEBLLM_ROUTE,
      modelId: options.modelId,
      sentences: options.sentences as MeasuredSentence[],
      schema: FORCED_SHAPE_SCHEMA,
      maxTokens: MAX_OUTPUT_TOKENS,
      stopAtFirstBug: options.stopAtFirstBug,
    },
  );
}

test('@measure Qwen3 v prohlížeči drží vynucený tvar emise', async () => {
  // Stahování vah, načtení do GPU a 40 svázaných generací. Naměřeno 20. 8. 2026:
  // jedna svázaná emise trvá na NVIDIA Ampere ~185 s, takže samotných 40 vět je
  // přes dvě hodiny. Strop je čtyři, aby se do něj vešel i běh reprodukce na
  // 0.6B — a je to strop, ne odhad: když ho běh vyčerpá, je to odpověď pro T6.
  test.setTimeout(4 * 60 * 60 * 1000);

  const baseUrl = test.info().project.use.baseURL ?? 'http://127.0.0.1:3100';
  const sentences = loadSentences(MEASURED_SENTENCES);
  expect(sentences, 'zmrazená sada nedala 40 vět').toHaveLength(MEASURED_SENTENCES);

  const bundle = readFileSync(WEBLLM_BUNDLE, 'utf8');
  const hostUrl = new URL(HOST_ROUTE, baseUrl).toString();
  const { context, page, adapter } = await openMeasurementBrowser(hostUrl, bundle);

  try {
    // Produkcni poradi: rozpoznavac prvni, model az na zbytek. Kdyby se meril
    // jen model, merila by se cesta, kterou produkt nepouziva.
    const { handled, forModel } = splitByRecognizer(sentences);
    console.log(`[shapes] ${handled.length}/${sentences.length} vet obslouzil rozpoznavac, ${forModel.length} jde modelu`);

    let done = 0;
    const primaryRun = await runModel(page, {
      modelId: PRIMARY_MODEL,
      sentences: forModel,
      stopAtFirstBug: false,
      onAttempt: (record) => {
        done += 1;
        console.log(`[${PRIMARY_MODEL}] ${done}/${forModel.length} ${record.id} ${record.latencyMs}ms ${record.error || record.finishReason}`);
      },
      onProgress: (text) => console.log(`[${PRIMARY_MODEL}] ${text}`),
    });
    const primaryRecords = mergeRecords(sentences, [...handled, ...primaryRun.records]);
    const primary = summarize(PRIMARY_MODEL, primaryRecords);

    // Podúloha T5: „proměřit Qwen3-1.7B; při pádu proměřit i 0.6B kvůli
    // reprodukci známé chyby". Bez pádu se 0.6B nespouští — reprodukovat by
    // nebylo co a stálo by to další stažení vah.
    let reproduction = null;
    const runs = [{ model: PRIMARY_MODEL, records: primaryRun.records }];  // jen odpovedi modelu
    if (primary.crashes > 0) {
      const page2 = await context.newPage();
      await page2.goto(hostUrl);
      const repro = await runModel(page2, {
        modelId: REPRODUCTION_MODEL,
        sentences,
        stopAtFirstBug: true,
        onAttempt: (record) => console.log(`[${REPRODUCTION_MODEL}] ${record.id} ${record.error || 'ok'}`),
        onProgress: (text) => console.log(`[${REPRODUCTION_MODEL}] ${text}`),
      });
      reproduction = summarize(REPRODUCTION_MODEL, repro.records);
      runs.push({ model: REPRODUCTION_MODEL, records: repro.records });
    }

    const measuredAt = new Date().toISOString();
    const report = buildReport({ primary, reproduction, adapter, measuredAt });

    // Report se zapisuje DŘÍV, než se o něm cokoli tvrdí. Běh, který skončí
    // nenulově, je pořád naměřený fakt a nesmí zmizet s procesem. Archiv jde
    // s ním, aby se klasifikace dala přepočítat bez dalšího půlhodinového běhu.
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    writeFileSync(RAW_ARCHIVE_PATH, `${JSON.stringify(buildRawArchive(measuredAt, runs), null, 2)}\n`, 'utf8');

    expect(report.adapter, 'WebGPU adaptér nebyl k dispozici — měřilo by se něco jiného než AC').not.toBe('none');
    expect(measurementShortfall(report)).toBeNull();
  } finally {
    await context.close();
  }
});
