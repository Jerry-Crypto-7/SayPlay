import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { it } from 'vitest';
import { handleSourceRequest } from '../../src/app/api/worldstream/source/handler';
import { runSourceProposal, serverGrammar } from '../../src/worldstream/sessions';
import museum from './museum.sim.json';

it('opens a prepared study card; never records synthetic activity as human observations', async () => {
  const card = process.env.RC_STUDY_CARD ?? 'A';
  if (!['A', 'B'].includes(card)) throw new Error('STUDY_CARD_MUST_BE_A_OR_B');
  const smoke = process.env.RC_STUDY_SMOKE === '1';
  const duration = card === 'A' ? 400 : 600, changed = card === 'A' ? 200 : 500;
  const wait = card === 'A' ? 240 : 360, horizon = card === 'A' ? 300 : 560;
  const sim = structuredClone(museum);
  sim.state.timers.countdown.durationTicks = duration;
  for (const rule of Object.values(sim.rules)) for (const action of rule.actions)
    if (action.kind === 'startTimer' && 'durationTicks' in action) action.durationTicks = duration;
  const source = readFileSync('evals/reality-compiler/museum-source.txt', 'utf8').replace('20 sekund', `${duration / 20} sekund`);
  const directory = resolve('scratch/study-session', randomUUID()); mkdirSync(directory, { recursive: true });
  const grammar = serverGrammar(); if (typeof grammar === 'string') throw new Error('GRAMMAR_UNAVAILABLE');
  const baseURL = 'http://127.0.0.1:3118';
  let ready = false, failed = false;
  const server = execFile(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', '3118'],
    { windowsHide: true, env: { ...process.env, WORLDSMITH_MODEL_ENDPOINT: '', WORLDSMITH_MODEL_KEY: '' } });
  server.stdout?.on('data', chunk => { if (String(chunk).includes('Ready')) ready = true; });
  server.on('error', () => { failed = true; }); server.on('exit', () => { failed = true; });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    for (let n = 0; n < 60 && !ready && !failed; n++) await new Promise(r => setTimeout(r, 500));
    if (!ready || failed) throw new Error('BUILD_REQUIRED_OR_PORT_BUSY');
    browser = await chromium.launch({ headless: smoke, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    await context.route('**/api/**', async route => {
      if (route.request().url() !== `${baseURL}/api/worldstream/source` || route.request().method() !== 'POST') {
        await route.fulfill({ status: 503, json: { kind: 'rejected', code: 'PREPARED_STUDY_ONLY' } }); return;
      }
      const response = await handleSourceRequest(new Request(route.request().url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: route.request().postData() }),
        (snapshot, revision) => runSourceProposal(snapshot, revision, { grammar, emit: async request => {
          const data = JSON.parse(request.user);
          return { sim, missingCritical: [], conflicts: [], unsupported: [],
            claims: [{ claimId: 'prepared_source', text: 'Prepared study procedure; semantic review remains unchecked.', support: 'sourced',
              interventionId: null, review: { status: 'unchecked' }, spans: [{ sourceId: data.sourceId, startByte: 0,
                endByte: Buffer.byteLength(data.text), excerpt: data.text }] }],
            bindings: Object.keys(sim.rules).map(id => ({ bindingId: `study.${id}`, target: { kind: 'rule', id }, claimIds: ['prepared_source'] })) };
        } }), 'fixture');
      await route.fulfill({ status: response.status, json: await response.json() });
    });
    const page = await context.newPage(); page.setDefaultTimeout(60000);
    // Prepared study only: advance browser timers deterministically so the
    // recorded input matches the fixed table exactly. Never used by cold runs.
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await page.goto(baseURL); await page.getByText('Build from a source', { exact: true }).click();
    await page.getByLabel('Source title', { exact: true }).fill(`Prepared study ${card}`);
    await page.getByTestId('source-input').fill(source);
    const reply = page.waitForResponse(r => r.url() === `${baseURL}/api/worldstream/source`);
    await page.getByTestId('source-submit').click();
    const result = await (await reply).json();
    writeFileSync(resolve(directory, 'source-result.json'), JSON.stringify(result, null, 2));
    expect(result.kind, JSON.stringify(result)).toBe('proposed');
    await page.clock.runFor(1000);
    await page.waitForFunction(() => !!window.__realityCompiler?.snapshot() && !!window.__worldstreamStage?.ready());
    const initialFrame = await page.evaluate(() => window.__worldstreamStage!.frames());
    const act = async (actionId: string, target: string) => {
      const index = await page.evaluate(({ actionId, target }) => window.__realityCompiler!.snapshot()!.actions
        .findIndex(a => a.actor === 'visitor' && a.actionId === actionId && a.target === target), { actionId, target });
      if (index < 0) throw new Error('STUDY_ACTION_MISSING');
      await page.getByTestId('runtime-action').selectOption(String(index)); await page.getByTestId('runtime-act').click();
    };
    await act('activate', 'sensorA');
    const start = await page.evaluate(() => window.__realityCompiler!.snapshot()!.inputs.find(i => i.target === 'sensorA')!.tick);
    await act('moveTo', 'approachB');
    const index = await page.evaluate(() => window.__realityCompiler!.snapshot()!.actions.findIndex(a => a.target === 'sensorB' && a.actionId === 'activate'));
    await page.getByTestId('runtime-action').selectOption(String(index));
    const currentTick = await page.evaluate(() => window.__realityCompiler!.snapshot()!.runtime.tick);
    await page.clock.runFor((start + wait - currentTick) * 50);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-testid="runtime-act"]')!.click();
      document.querySelector<HTMLButtonElement>('[data-testid="runtime-pause"]')!.click();
    });
    await page.clock.runFor(150);
    expect(await page.evaluate(() => window.__worldstreamStage!.frames())).toBeGreaterThan(initialFrame);
    await page.clock.resume();
    await expect(page.getByTestId('runtime-input-result')).toContainText('Applied:');
    const before = await page.evaluate(() => window.__realityCompiler!.snapshot()!);
    const finish = before.inputs.find(i => i.target === 'sensorB' && i.actionId === 'activate')!.tick;
    if (finish !== start + wait) throw new Error(`STUDY_TIMING_MISMATCH: ${finish - start} != ${wait}`);
    await page.evaluate(({ card, seconds, observationTick }) => {
      const banner = document.createElement('aside');
      banner.textContent = `Prepared study ${card} · Change the timer to ${seconds} seconds · Fork tick 0 · Observation tick ${observationTick} · No model generation`;
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;padding:8px;background:#102b30;color:white;font:14px sans-serif';
      document.body.append(banner);
    }, { card, seconds: changed / 20, observationTick: start + horizon });
    writeFileSync(resolve(directory, 'prepared.json'), JSON.stringify({ card, generation: 'prepared', humanObservation: false, start, finish,
      targetDurationTicks: changed, observationTick: start + horizon, before }, null, 2));
    if (smoke) {
      await page.getByText('Experiment with a future timer', { exact: true }).evaluate(element => (element as HTMLElement).click());
      await page.getByLabel('New duration (ticks, 20 per second)', { exact: true }).fill(String(changed));
      await page.getByLabel('Fork tick', { exact: true }).fill('0');
      await page.getByLabel('Observation tick', { exact: true }).fill(String(start + horizon));
      await page.getByLabel('Reason for intervention', { exact: true }).fill('Prepared study validation');
      await page.getByRole('button', { name: 'Confirm timer experiment', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      await expect(page.getByTestId('branch-comparison')).toBeVisible();
      const observation = await page.evaluate(() => window.__realityCompiler!.snapshot()!);
      const comparison = observation.project.comparison!;
      expect(comparison.original.values['e:case:locked']).toBe(0);
      expect(comparison.original.values['f:alarm']).toBe(0);
      expect(comparison.changed.values['e:case:locked']).toBe(card === 'A' ? 1 : 0);
      expect(comparison.changed.values['f:alarm']).toBe(card === 'A' ? 1 : 0);
      writeFileSync(resolve(directory, 'validated.json'), JSON.stringify(observation, null, 2));
      const screenshot = page.screenshot({ path: resolve(directory, 'prepared-study.png'), timeout: 5000 }).catch(() => {
        writeFileSync(resolve(directory, 'screenshot-status.json'), JSON.stringify({ status: 'NOT_RUN', reason: 'SCREENSHOT_UNAVAILABLE' }));
      });
      await page.clock.runFor(200);
      await screenshot;
    }
    console.log(`STUDY_PREPARED ${card} ${directory}; not a human observation`);
    if (!smoke) await Promise.race([new Promise<void>(r => page.once('close', () => r())),
      new Promise<void>(r => { const timer = setTimeout(r, 1800000); timer.unref(); })]);
  } finally { await browser?.close(); server.kill(); }
}, 1900000);
