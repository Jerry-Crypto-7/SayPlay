import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { it } from 'vitest';
import { configuredTransport, fileJournal, renderReport, runBenchmark, type RunConfig } from '../../scripts/measure-reality-compiler';
import { createBrowserAdapter } from '../../scripts/reality-compiler-browser';
import { judgeBrowser, loadHoldout, reviewTemplate } from '../../scripts/reality-compiler-evaluation';
import { upstreamConfigFromEnv } from '../../src/server/upstream';

it('runs the source browser series only with configured access and explicit spend authority', async () => {
  const holdout = loadHoldout('evals/reality-compiler/holdout-v1');
  const runId = randomUUID();
  const directory = resolve('evals/reality-compiler/runs', runId);
  mkdirSync(directory, { recursive: true });
  const authorized = process.env.RC_LIVE_AUTHORIZED === '1';
  const limit = Number(process.env.RC_SPEND_LIMIT_USD);
  const spendLimitUsd = Number.isFinite(limit) && limit > 0 ? limit : null;
  // Žádné načítání .env nebo přihlašovacích souborů. Pouze již nakonfigurovaný proces.
  const upstream = authorized && spendLimitUsd ? upstreamConfigFromEnv(process.env) : null;
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' }).trim();
  const config: RunConfig = { runId, commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0,
    model: upstream?.model ?? 'UNCONFIGURED', modelConfig: upstream ? { effort: upstream.effort,
      maxOutputTokens: upstream.maxOutputTokens, timeoutMs: upstream.timeoutMs,
      usdPerMTokIn: upstream.pricing.usdPerMTokIn, usdPerMTokOut: upstream.pricing.usdPerMTokOut } : {},
    origin: 'live', suiteSha256: holdout.manifest.suiteSha256, authorized, spendLimitUsd,
    maxCalls: 60, maxWallMs: 3_600_000 };
  const transport = configuredTransport(config);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let adapter: ReturnType<typeof createBrowserAdapter> | undefined;
  let startupIssue: string | null = null;
  const baseURL = process.env.RC_BASE_URL;
  if (upstream && baseURL) {
    try {
      const url = new URL(baseURL);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('LOCAL_BROWSER_TARGET_REQUIRED');
      const ready = await fetch(baseURL, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!ready.ok) throw new Error('BROWSER_TARGET_UNAVAILABLE');
      await ready.body?.cancel();
      browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
      adapter = createBrowserAdapter({ browser, baseURL, tasks: holdout.tasks, artifactDirectory: directory,
        evaluate: async (input, created, edited) => judgeBrowser(holdout.oracle.cases[input.id], created, edited) });
    } catch { startupIssue = 'LOCAL_BROWSER_STARTUP_FAILED'; }
  }
  try {
    const run = await runBenchmark(holdout.suite, config, { ...transport, adapter,
      journal: fileJournal(resolve(directory, 'journal.jsonl')) });
    writeFileSync(resolve(directory, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    writeFileSync(resolve(directory, 'review.template.json'), `${JSON.stringify(reviewTemplate(run, holdout.oracle), null, 2)}\n`);
    writeFileSync(resolve(directory, 'environment.json'), JSON.stringify({ browser: browser ? 'Chromium / ANGLE SwiftShader / 1440x1000' : 'NOT_RUN',
      transport: 'Playwright source-request bridge to the production handler; provider calls through shared spend cap',
      excluded: 'Deployment/serverless startup and hosting network; prompt-only path',
      edit: 'Deterministic source timer intervention; no model invocation',
      sourceSuite: 'holdout-v1', authorized, spendLimitUsd, providerConfigured: !!upstream, browserTargetConfigured: !!baseURL, startupIssue,
    }, null, 2) + '\n');
    writeFileSync('evals/reality-compiler/cold-report.md', renderReport(run) +
      `\nArchiv: runs/${runId}/. Přístup: ${authorized ? 'autorizován přepínačem běhu' : 'NOT_RUN'}; ` +
      `spend limit: ${spendLimitUsd ?? 'NOT_RUN'}; provider: ${upstream ? 'nakonfigurován' : 'NOT_RUN'}; browser target: ${baseURL ? 'nastaven' : 'NOT_RUN'}.\n\n` +
      'Browser měří skutečnou stránku a stejný source handler přes označený lokální transport. Neměří hosting ani serverless cold start. ' +
      'Edit je lokální deterministický zásah. Sémantické a uživatelské brány vyžadují skutečné review; prázdná šablona není výsledek.\n');
  } finally { await adapter?.dispose(); await browser?.close(); }
}, 3_900_000);
