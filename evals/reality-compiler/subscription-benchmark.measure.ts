import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { it } from 'vitest';
import { EMISSION_MODEL } from '../../src/model/prompt';
import { subscriptionEmitter } from '../../scripts/codex-subscription';
import { fileJournal, renderReport, runBenchmark, type RunConfig } from '../../scripts/measure-reality-compiler';
import { createBrowserAdapter } from '../../scripts/reality-compiler-browser';
import { judgeBrowser, loadHoldout, reviewTemplate } from '../../scripts/reality-compiler-evaluation';

it('measures the locked holdout through the own Codex subscription, without API fallback', async () => {
  const holdout = loadHoldout('evals/reality-compiler/holdout-v1');
  const runId = randomUUID();
  const directory = resolve('evals/reality-compiler/runs', runId);
  const workspace = resolve('scratch/subscription-benchmark', runId);
  mkdirSync(directory, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8' }).trim();
  const config: RunConfig = { runId, commit: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0,
    model: EMISSION_MODEL, modelConfig: { effort: 'low', timeoutMs: 180000, transport: 'official-codex-cli-chatgpt' },
    origin: 'live', billing: 'subscription', suiteSha256: holdout.manifest.suiteSha256,
    authorized: process.env.RC_SUBSCRIPTION_AUTHORIZED === '1', spendLimitUsd: null, maxCalls: 60, maxWallMs: 7200000 };
  const provider = subscriptionEmitter({ maxCalls: config.maxCalls,
    workspace: workspace.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/'),
    journal: fileJournal(resolve(directory, 'subscription.jsonl')) });
  const baseURL = 'http://127.0.0.1:3117';
  let server: ReturnType<typeof execFile> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let adapter: ReturnType<typeof createBrowserAdapter> | undefined;
  let startupIssue: string | null = null;
  const journal = fileJournal(resolve(directory, 'journal.jsonl'));
  try {
    if (config.authorized) try {
      await provider.checkLogin();
      let listening = false; let failed = false;
      server = execFile(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3117'],
        { windowsHide: true, env: { ...process.env, WORLDSMITH_MODEL_ENDPOINT: '', WORLDSMITH_MODEL_KEY: '' } });
      server.stdout?.on('data', chunk => { if (String(chunk).includes('Ready')) listening = true; });
      server.on('error', () => { failed = true; }); server.on('exit', () => { failed = true; });
      let ready = false;
      for (let attempt = 0; attempt < 60 && !failed; attempt++) {
        try {
          const response = await fetch(baseURL, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel();
          if (listening && response.ok) { ready = true; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      if (!ready || failed) throw new Error('LOCAL_SERVER_UNAVAILABLE');
      browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
      adapter = createBrowserAdapter({ browser, baseURL, tasks: holdout.tasks, artifactDirectory: directory, timeoutMs: 220000,
        evaluate: async (input, created, edited) => judgeBrowser(holdout.oracle.cases[input.id], created, edited) });
    } catch (e) { startupIssue = e instanceof Error ? e.message : 'STARTUP_FAILED'; }
    writeFileSync(resolve(directory, 'environment.json'), JSON.stringify({ config, startupIssue,
      browser: browser ? 'Chromium / SwiftShader / 1440x1000' : 'NOT_RUN',
      transport: 'Official Codex CLI in validated WSL2; ChatGPT login; local Playwright production-handler bridge',
      apiFallback: false, priceMethod: 'subscription-no-unit-tariff',
      excluded: ['hosting/serverless startup', 'human semantic review', 'human usability'],
      source: 'holdout-v1 unchanged; oracle never sent to emitter; provider prompt caching may occur',
      hardwareLimitation: 'Own workstation; concurrent load is not controlled or isolated',
      edits: 'deterministic runtime timer intervention',
    }, null, 2) + '\n');
    process.stdout.write(`SUBSCRIPTION_BENCHMARK_ARCHIVE ${directory}\n`);
    const run = await runBenchmark(holdout.suite, config, { adapter, redact: value => value,
      journal: event => {
        journal(event);
        const e = event as { event: string; pair?: { index: number; phases: unknown } };
        if (e.event === 'pair-end') process.stdout.write(`PAIR_COMPLETED ${e.pair!.index + 1}/30 ${JSON.stringify(e.pair!.phases)}\n`);
      },
      subscription: async request => {
        const result = await provider.generate(request);
        return { body: result.body, usage: result.usage ? {
          inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens,
        } : null };
      },
    });
    writeFileSync(resolve(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n');
    writeFileSync(resolve(directory, 'review.template.json'), JSON.stringify(reviewTemplate(run, holdout.oracle), null, 2) + '\n');
    writeFileSync('evals/reality-compiler/subscription-report.md', renderReport(run) +
      `\nArchiv: runs/${runId}/. Každý pokus zůstal v reportu. Předplatné nemá doloženou jednotkovou USD cenu; cenová brána NOT_RUN. ` +
      'Lokální generace bez prepared/cache odpovědí; nejde o cold serverless start. Sémantické a lidské brány vyžadují skutečná pozorování.\n');
  } finally { await adapter?.dispose(); await browser?.close(); server?.kill(); }
}, 7500000);
