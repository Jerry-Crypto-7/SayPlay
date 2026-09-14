import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { it } from 'vitest';
import { browserRenderer } from '../../scripts/browser-renderer';
import { EMISSION_MODEL } from '../../src/model/prompt';
import { subscriptionEmitter } from '../../scripts/codex-subscription';
import { bindSubscriptionLifetime, waitForSubscriptionClose } from '../../scripts/subscription-lifetime';
import { fileJournal } from '../../scripts/measure-reality-compiler';
import { handleSourceRequest } from '../../src/app/api/worldstream/source/handler';
import { runSourceProposal, serverGrammar } from '../../src/worldstream/sessions';

it('opens an own local source demo using the signed-in Codex subscription', async () => {
  const directory = resolve('scratch/subscription-demo', randomUUID());
  mkdirSync(directory, { recursive: true });
  const journal = fileJournal(resolve(directory, 'journal.jsonl'));
  const linuxPath = directory.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/');
  const provider = subscriptionEmitter({ workspace: linuxPath, journal });
  await provider.checkLogin();
  if (process.env.RC_DEMO_PROBE === '1') {
    const result = await provider.emit({ model: EMISSION_MODEL, system: 'Return only the JSON object {"ok":true}. Do not use tools.', user: '{}' });
    console.log('Subscription connection probe:', JSON.stringify(result));
    return;
  }
  const grammar = serverGrammar();
  if (typeof grammar === 'string') throw new Error('GRAMMAR_UNAVAILABLE');
  const smoke = process.env.RC_DEMO_SMOKE === '1';
  const guided = process.env.RC_DEMO_GUIDED === '1';
  const baseURL = 'http://127.0.0.1:3116';
  const lifetime = new AbortController();
  // Own server only, local interface, and no API configuration inherited by Next.
  const server = execFile(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3116'],
    { windowsHide: true, env: { ...process.env, WORLDSMITH_MODEL_ENDPOINT: '', WORLDSMITH_MODEL_KEY: '' } });
  const serverClosed = new Promise<void>(resolve => { server.once('close', () => resolve()); });
  let serverError: Error | null = null;
  let listening = false;
  server.stdout?.on('data', chunk => { if (String(chunk).includes('Ready')) listening = true; });
  server.on('error', error => { serverError = error; lifetime.abort(); });
  server.on('exit', () => { serverError = new Error('DEMO_SERVER_EXITED'); lifetime.abort(); });
  const pending = new Set<Promise<Response>>();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (serverError) throw serverError;
      try { const r = await fetch(baseURL, { signal: AbortSignal.timeout(1000) }); await r.body?.cancel(); if (r.ok && listening) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('BUILD_REQUIRED_OR_PORT_BUSY');
    browser = await chromium.launch({ headless: smoke, args: browserRenderer().args });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    bindSubscriptionLifetime(lifetime, browser, context, page);
    await context.route('**/api/**', async route => {
      if (route.request().url() !== `${baseURL}/api/worldstream/source` || route.request().method() !== 'POST') {
        await route.fulfill({ status: 503, json: { kind: 'rejected', code: 'SOURCE_DEMO_ONLY' } }); return;
      }
      const operation = handleSourceRequest(new Request(route.request().url(), { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: route.request().postData() }),
        (source, revision, _deps, supplement) => runSourceProposal(source, revision, {
          grammar, emit: request => provider.emit(request, lifetime.signal),
        }, supplement));
      pending.add(operation);
      try {
        const response = await operation;
        const body = await response.json();
        journal({ event: 'source-result', kind: body.kind, code: body.code ?? null });
        writeFileSync(resolve(directory, `${randomUUID()}-source.json`), JSON.stringify(body, null, 2));
        if (!lifetime.signal.aborted) await route.fulfill({ status: response.status, json: body });
      } finally { pending.delete(operation); }
    });
    await page.goto(baseURL);
    await page.evaluate(() => {
      const note = document.createElement('aside');
      note.textContent = 'Local demo · Codex subscription · Use Build from a source · No API fallback';
      note.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:8px 16px;background:#102b30;color:#d5ffff;font:13px monospace;text-align:center';
      document.body.append(note);
    });
    await page.getByText('Build from a source', { exact: true }).click();
    await page.getByLabel('Source title', { exact: true }).fill('Codex subscription demo');
    await page.getByTestId('source-input').fill(readFileSync('evals/reality-compiler/subscription-demo-source.txt', 'utf8'));
    process.stdout.write(`Demo ready in the controlled browser. Source only; Codex subscription; 12 calls maximum; no API fallback. Archive: ${directory}\n`);
    if (smoke || guided) {
      const reply = page.waitForResponse(r => r.url() === `${baseURL}/api/worldstream/source`, { timeout: 220_000 });
      await page.getByTestId('source-submit').click();
      const response = await reply;
      const result = await response.json();
      if (result.kind !== 'proposed') throw new Error(`LIVE_SOURCE_${result.kind}_${result.code ?? ''}`);
      process.stdout.write('Review the seven parameter groups in the browser and confirm them to continue. This is your acknowledgement, not independent semantic review.\n');
      await page.waitForFunction(() => !!window.__realityCompiler?.snapshot() && !!window.__worldstreamStage?.ready(), undefined, { timeout: 30 * 60_000 });
      const act = async (actionId: string, target: string) => {
        const index = await page.evaluate(({ actionId, target }) => window.__realityCompiler!.snapshot()!.actions
          .findIndex(a => a.actor === 'visitor' && a.actionId === actionId && a.target === target), { actionId, target });
        if (index < 0) throw new Error('DEMO_ACTION_MISSING');
        await page.getByTestId('runtime-action').selectOption(String(index));
        await page.getByTestId('runtime-act').click();
      };
      await act('activate', 'sensorA');
      await expect(page.getByTestId('runtime-input-result')).toContainText('Applied:');
      const start = await page.evaluate(() => window.__realityCompiler!.snapshot()!.inputs.find(i => i.target === 'sensorA')!.tick);
      await act('moveTo', 'approachB');
      const finish = await page.evaluate(() => window.__realityCompiler!.snapshot()!.actions.findIndex(a => a.actor === 'visitor' && a.target === 'sensorB' && a.actionId === 'activate'));
      if (finish < 0) throw new Error('DEMO_FINISH_MISSING');
      await page.getByTestId('runtime-action').selectOption(String(finish));
      await page.waitForFunction(tick => {
        if ((window.__realityCompiler?.snapshot()?.runtime.tick ?? -1) < tick) return false;
        document.querySelector<HTMLButtonElement>('[data-testid="runtime-act"]')!.click();
        document.querySelector<HTMLButtonElement>('[data-testid="runtime-pause"]')!.click();
        return true;
      }, start + 260, { timeout: 30_000, polling: 25 });
      await expect(page.getByTestId('runtime-input-result')).toContainText('Applied:');
      await page.getByText('Experiment with a future timer', { exact: true }).click();
      await page.getByLabel('New duration (ticks, 20 per second)', { exact: true }).fill('200');
      await page.getByLabel('Fork tick', { exact: true }).fill('0');
      await page.getByLabel('Observation tick', { exact: true }).fill(String(start + 300));
      await page.getByLabel('Reason for intervention', { exact: true }).fill('Experiment: shorten the window from 20 to 10 seconds.');
      await page.getByRole('button', { name: 'Confirm timer experiment', exact: true }).click();
      await expect(page.getByTestId('branch-comparison')).toBeVisible();
      const comparison = await page.evaluate(() => window.__realityCompiler!.snapshot()!.project.comparison!);
      expect(comparison.original.values['e:case:locked']).toBe(0);
      expect(comparison.original.values['f:alarm']).toBe(0);
      expect(comparison.changed.values['e:case:locked']).toBe(1);
      expect(comparison.changed.values['f:alarm']).toBe(1);
      await page.screenshot({ path: resolve(directory, 'live-source.png') });
      writeFileSync(resolve(directory, 'observation.json'), JSON.stringify(await page.evaluate(() => window.__realityCompiler?.snapshot()), null, 2));
      writeFileSync(resolve(directory, 'pipeline.json'), JSON.stringify(await page.evaluate(() => window.__worldstreamMetrics?.snapshot() ?? null), null, 2));
      process.stdout.write(`GUIDED_DEMO_VERIFIED: live generation, actual inputs, original unlocked, changed locked with alarm. Archive: ${directory}\n`);
    }
    if (!smoke) {
      await waitForSubscriptionClose(lifetime.signal, 30 * 60_000);
    }
  } finally {
    lifetime.abort();
    try {
      await Promise.allSettled([...pending]);
      await browser?.close();
    } finally {
      server.kill();
      await serverClosed;
    }
  }
}, 35 * 60_000);
