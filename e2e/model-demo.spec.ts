/**
 * ŽIVÁ RELACE S MODELEM — napiš větu do pole a model ti postaví svět.
 *
 * **Není to test a nesmí se commitnout.** Vzniklo na předvádění (25. 8. 2026)
 * a nic v `src/**` kvůli němu nemění. Značka `@measure` v názvu drží tenhle
 * soubor mimo `npm run test:e2e`.
 *
 * ## Jak to funguje
 *
 * Otevře se pravé Chrome s aplikací. Vedle něj běží na skryté stránce Qwen3 na
 * WebGPU. Každý požadavek na `/api/generate` se odchytí a **místo zmrazeného
 * korpusu ho obslouží model**: dostane tvoji větu, napíše IR, dopočítá se
 * `collisionAabb` a aplikace to vykreslí svojí normální cestou.
 *
 * Podstrčení odpovědi serveru je jediný způsob, jak model ukázat bez zásahu do
 * produktu — z hlavní stránky je odpojený rozhodnutím z 21. 8. 2026 (T22q,
 * varianta (a)), takže `PromptBar` ho sám nezavolá. Nic se tím nepředstírá:
 * aplikace dostane přesně ten tvar, který umí, a zpracuje ho svým kódem.
 *
 * ## Když model nedodá použitelný svět
 *
 * Odpoví se **404**, tedy tím, čím dnes odpovídá server na neznámou větu — a
 * aplikace sáhne po vlastní záruce světa (rozpoznaný tvar, nebo náhradní
 * místnost s pojmenovanou vadou). Nikdy tedy nezůstane prázdné plátno a nikdy
 * se nepředstírá, že model uspěl, když neuspěl. Důvod se vypíše do terminálu.
 *
 * ## Proč vlastní prohlížeč
 *
 * Totéž co v `local-model-grammar.spec.ts`: Chromium od Playwrightu WebGPU
 * zařízení nedostane (`dxil.dll`), systémové Chrome ano, a váhy (979 MB) přežijí
 * jen v trvalém profilu. `args: []` je nutnost — zděděný SwiftShader by adaptér
 * schoval.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, expect, test } from '@playwright/test';

import { FORCED_SHAPE_SCHEMA, MAX_OUTPUT_TOKENS, PRIMARY_MODEL, stripThinking } from '../evals/local-model/measure-grammar';
import { buildRuntimeWorld } from '../src/ir/build';
import { peelEnvelope, worldEmissionSchema } from '../src/ir/worlddoc';
import { frozenGrammar } from '../src/model/client';
import { buildEmissionRequest } from '../src/model/prompt';

const WEBLLM_ROUTE = '/__webllm-demo.js';
const HOST_ROUTE = '/__webllm-demo-host.html';
const PROFILE_DIR = join(process.cwd(), 'tmp-webllm-profile');
const APP_URL = process.env.DEMO_APP_URL ?? 'http://localhost:3000';

/**
 * Kolizní obálky odvozené z toho, co model napsal — týž výpočet, jaký měří
 * `evals/local-model/__tests__/aabb-repair.test.ts`. Je to **odvození, ne
 * vymýšlení**: každá entita dostane políčko soketu, na kterém stojí.
 */
function deriveCollisionAabb(sim: Record<string, unknown>): Record<string, unknown> {
  const sockets = (sim.sockets ?? {}) as Record<string, [number, number]>;
  const entities = (sim.entities ?? {}) as Record<string, { socket?: string }>;
  const boxes: Record<string, number[]> = {};
  for (const [name, entity] of Object.entries(entities)) {
    const at = entity.socket === undefined ? undefined : sockets[entity.socket];
    if (at) boxes[name] = [at[0], at[1], 1, 1];
  }
  return { ...sim, collisionAabb: boxes };
}

/** Syrová odpověď modelu → svět, který se dá postavit, nebo důvod, proč ne. */
function toBuildableEmission(raw: string): { ok: true; emission: unknown } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripThinking(raw));
  } catch (thrown) {
    return { ok: false, why: `nerozpársovatelný JSON (${(thrown as Error).message.slice(0, 70)})` };
  }
  const peeled = peelEnvelope(parsed);
  if (peeled === null) return { ok: false, why: 'nerozpoznatelná obálka emise' };

  const document = peeled.document as Record<string, unknown>;
  if (typeof document.sim !== 'object' || document.sim === null) return { ok: false, why: 'emise nemá sim' };

  const emission = { ...document, sim: deriveCollisionAabb(document.sim as Record<string, unknown>) };
  const check = worldEmissionSchema.safeParse(emission);
  if (!check.success) {
    const issues = check.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return { ok: false, why: `neprošlo schématem — ${issues.join(' | ')}` };
  }

  // Schéma je tvar, běh je něco jiného. Rozhoduje `buildRuntimeWorld`, tedy týž
  // vstupní bod, jakým emise prochází v `src/app/page.tsx`.
  const built = buildRuntimeWorld(emission.sim);
  if (!built.ok) return { ok: false, why: `nepostaví se — ${built.reason} ${(built.issues ?? []).slice(0, 2).join(' | ')}` };

  return { ok: true, emission };
}

test('@measure @demo živá relace — napiš větu, model postaví svět', async () => {
  // Relace končí zavřením okna, ne časem. Strop je tu jen jako pojistka.
  test.setTimeout(4 * 60 * 60 * 1000);

  const grammar = frozenGrammar();
  expect(grammar.ok, 'slovník ze zmrazeného protokolu se nenačetl').toBe(true);

  const bundle = readFileSync(join('node_modules', '@mlc-ai', 'web-llm', 'lib', 'index.js'), 'utf8');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: false,
    args: [],
    viewport: { width: 1600, height: 950 },
  });

  await context.route(`**${WEBLLM_ROUTE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: bundle }),
  );
  await context.route(`**${HOST_ROUTE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>model</title>' }),
  );

  try {
    // ---- model se natáhne jednou, dopředu ---------------------------------
    const host = context.pages()[0] ?? (await context.newPage());
    await host.goto(`${APP_URL}${HOST_ROUTE}`);

    const adapter = await host.evaluate(async () => {
      let probed: GPUAdapter | null = null;
      for (let attempt = 0; attempt < 20 && !probed && navigator.gpu; attempt += 1) {
        probed = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
        if (!probed) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return probed ? `${probed.info.vendor || '?'}/${probed.info.architecture || '?'}` : 'none';
    });
    console.log(`\n[live] GPU adaptér: ${adapter}`);
    expect(adapter, 'bez WebGPU se model nespustí').not.toBe('none');

    await host.exposeFunction('__demoProgress', (text: string) => {
      if (text.includes('Finish') || text.includes('Loading model')) console.log(`[model] ${text}`);
    });

    console.log('[live] natahuju model, chvíli to trvá…');
    await host.evaluate(
      async (input) => {
        const scope = window as unknown as {
          __demoProgress(text: string): Promise<void>;
          __demoEngine: unknown;
        };
        const webllm = (await import(/* webpackIgnore: true */ input.moduleUrl)) as {
          CreateMLCEngine(model: string, config: { initProgressCallback(r: { text: string }): void }): Promise<unknown>;
        };
        scope.__demoEngine = await webllm.CreateMLCEngine(input.modelId, {
          initProgressCallback: (report) => void scope.__demoProgress(report.text),
        });
      },
      { moduleUrl: `${APP_URL}${WEBLLM_ROUTE}`, modelId: PRIMARY_MODEL },
    );
    console.log('[live] model je připravený.\n');

    // ---- aplikace, každá věta jde modelu ----------------------------------
    const app = await context.newPage();

    await app.route('**/api/generate', async (route) => {
      const sentence = String((route.request().postDataJSON() as { prompt?: unknown } | null)?.prompt ?? '').trim();
      if (sentence === '') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });

      console.log(`\n[live] "${sentence}"`);
      console.log('[live]   model píše…');
      const started = Date.now();

      let raw = '';
      try {
        const request = buildEmissionRequest(sentence, (grammar as { value: Parameters<typeof buildEmissionRequest>[1] }).value);
        raw = await host.evaluate(
          async (input) => {
            const scope = window as unknown as {
              __demoEngine: {
                chat: {
                  completions: {
                    create(request: unknown): Promise<{ choices: { message?: { content?: string | null } }[] }>;
                  };
                };
              };
            };
            const reply = await scope.__demoEngine.chat.completions.create({
              messages: [
                { role: 'system', content: input.system },
                { role: 'user', content: input.user },
              ],
              response_format: { type: 'json_object', schema: input.schema },
              max_tokens: input.maxTokens,
              temperature: 0,
              seed: 1,
            });
            return reply.choices[0]?.message?.content ?? '';
          },
          { system: request.system, user: request.user, schema: FORCED_SHAPE_SCHEMA, maxTokens: MAX_OUTPUT_TOKENS },
        );
      } catch (thrown) {
        console.log(`[live]   model spadl: ${(thrown as Error).message.slice(0, 120)}`);
      }

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const verdict = raw === '' ? ({ ok: false, why: 'model nevrátil nic' } as const) : toBuildableEmission(raw);

      if (verdict.ok) {
        console.log(`[live]   ${seconds} s → svět od modelu jde na plátno`);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ emission: verdict.emission }) });
      }

      // 404 je přesně to, čím server odpovídá na neznámou větu, takže aplikace
      // sáhne po vlastní záruce světa. Model neuspěl a nic se nepředstírá.
      console.log(`[live]   ${seconds} s → model neuspěl: ${verdict.why}`);
      console.log('[live]   → padá to na záruku světa v prohlížeči (rozpoznaný tvar nebo náhradní místnost)');
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'NO_SOURCE', message: 'model nedodal použitelný svět' } }),
      });
    });

    await app.goto(APP_URL);
    console.log('[live] ================================================================');
    console.log('[live]  Aplikace je otevřená. Napiš větu ANGLICKY a dej "Build the world".');
    console.log('[live]  Model na ni odpoví za ~35 s. Relace končí, až okno zavřeš.');
    console.log('[live] ================================================================\n');

    // Relaci ukončí zavření okna, ne časovač.
    await app.waitForEvent('close', { timeout: 0 });
    console.log('\n[live] okno zavřeno, končím.');
  } finally {
    await context.close().catch(() => undefined);
  }
});
