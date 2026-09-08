import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { performance as nodePerformance } from 'node:perf_hooks';
import { handleSourceRequest } from '../src/app/api/worldstream/source/handler';
import { runSourceProposal, serverGrammar } from '../src/worldstream/sessions';
import type { SourceObservation } from '../src/worldstream/browser-measurement';
import type { UpstreamRequest } from '../src/model/prompt';
import type { Adapter, CaseInput, Checks, Context, Phase, ProductResult } from './measure-reality-compiler';

export interface BrowserTask {
  actor: string; startTarget: string; finishTarget: string; approachTarget: string; timerId: string;
  actionId: string; waitTicks: number; newDurationTicks: number;
}
export interface BrowserArtifact {
  observation: SourceObservation | null;
  responses: { kind: string; code: string | null; questions: string[]; conflicts: string[]; unsupported: string[] }[];
  problematicStopped: boolean | null;
  rejectedUnchanged: boolean | null;
  originalBeforeEdit: SourceObservation | null;
  renderer: { frames: number; drawCalls: number; slotIds: string[] } | null;
  screenshot: string | null;
  error: string | null;
  sourceStatus: string | null;
}
declare global { interface Window { __rcConfirmation?: { create: number | null; edit: number | null } } }
const observe = (page: Page) => page.evaluate(() => window.__realityCompiler?.snapshot() ?? null);

/** Browser používá skutečnou stránku i HTTP handler. Jen transport requestu běží v účtovaném procesu runneru.
 * Není to měření serverless hostingu: bridge je výslovně součástí metadat běhu. */
export function createBrowserAdapter(options: {
  browser: Browser; baseURL: string; tasks: Readonly<Record<string, BrowserTask>>;
  evaluate(input: CaseInput, created: BrowserArtifact | null, edited: BrowserArtifact | null): Promise<Checks>;
  fixture?: (request: UpstreamRequest) => Promise<unknown>;
  artifactDirectory?: string;
  timeoutMs?: number;
}): Adapter & { dispose(): Promise<void> } {
  let page: Page | null = null;
  let active: Context | null = null;
  const pending = new Set<Promise<Response>>();
  let responses: BrowserArtifact['responses'] = [];
  let problematicStopped: boolean | null = null;
  let rejectedUnchanged: boolean | null = null;
  let originalBeforeEdit: SourceObservation | null = null;
  let pair = -1;
  const timeout = options.timeoutMs ?? 180_000;
  const grammar = serverGrammar();
  if (typeof grammar === 'string') throw new Error('GRAMMAR_UNAVAILABLE');
  const taskFor = (input: CaseInput) => {
    const task = options.tasks[input.id];
    if (!task) throw new Error('TASK_MISSING');
    return task;
  };
  async function act(actor: string, actionId: string, target: string) {
    const snapshot = await observe(page!);
    const index = snapshot?.actions.findIndex((a) => a.actor === actor && a.actionId === actionId && a.target === target) ?? -1;
    if (index < 0) throw new Error('DECLARED_ACTION_MISSING');
    await page!.getByTestId('runtime-action').selectOption(String(index));
    await page!.getByTestId('runtime-act').click();
  }
  async function waitForFrame() {
    await page!.waitForFunction(() => {
      const stage = window.__worldstreamStage;
      return stage?.ready() && stage.frames() > 1 && (stage.quality()?.drawCalls ?? 0) > 0 &&
        (stage.slots().some(s => s.attached && s.triangles > 0) ?? false);
    }, undefined, { timeout });
    const before = await page!.evaluate(() => window.__worldstreamStage!.frames());
    await page!.waitForFunction(n => (window.__worldstreamStage?.frames() ?? 0) > n + 1, before, { timeout });
  }
  async function snapshot(error: string | null, phase: Phase): Promise<BrowserArtifact> {
    const observation = page && !page.isClosed() ? await observe(page).catch(() => null) : null;
    const renderer = page && !page.isClosed() ? await page.evaluate(() => {
      const stage = window.__worldstreamStage;
      return stage ? { frames: stage.frames(), drawCalls: stage.quality()?.drawCalls ?? 0,
        slotIds: stage.slots().filter(s => s.attached).map(s => s.stableId) } : null;
    }).catch(() => null) : null;
    let screenshot: string | null = null;
    if (options.artifactDirectory && page && !page.isClosed()) {
      mkdirSync(options.artifactDirectory, { recursive: true });
      screenshot = join(options.artifactDirectory, `pair-${pair}-${phase}.png`);
      await page.screenshot({ path: screenshot }).catch(() => { screenshot = null; });
    }
    return { observation, renderer, responses: structuredClone(responses), problematicStopped,
      rejectedUnchanged, originalBeforeEdit, screenshot, error,
      sourceStatus: page && !page.isClosed() ? await page.getByTestId('source-status').textContent().catch(() => null) : null };
  }
  async function fillIntervention(task: BrowserTask, fork: number, horizon: number) {
    const state = await observe(page!);
    const rules = state?.project.world.sim.rules as Record<string, { actions?: { kind: string; ref?: string }[] }>;
    const rule = Object.entries(rules ?? {}).find(([, r]) => r.actions?.some(a => a.kind === 'startTimer' && a.ref === task.timerId));
    if (!rule) throw new Error('TARGET_TIMER_MISSING');
    await page!.getByLabel(/^Timer rule/).selectOption(rule[0]);
    await page!.getByLabel('New duration (ticks, 20 per second)', { exact: true }).fill(String(task.newDurationTicks));
    await page!.getByLabel('Fork tick', { exact: true }).fill(String(fork));
    await page!.getByLabel('Observation tick', { exact: true }).fill(String(horizon));
  }
  return {
    async prepare(input, phase, previous) {
      try {
      const task = taskFor(input);
      if (phase === 'prompt') throw new Error('SOURCE_ADAPTER_DOES_NOT_MEASURE_PROMPT_ONLY');
      if (phase === 'create') {
        if (page) await page.context().close();
        const context = await options.browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
        page = await context.newPage();
        page.setDefaultTimeout(timeout);
        pair++; responses = []; problematicStopped = null; rejectedUnchanged = null; originalBeforeEdit = null;
        await page.addInitScript(() => {
          window.__rcConfirmation = { create: null, edit: null };
          document.addEventListener('submit', event => {
            const form = event.target as HTMLFormElement;
            if (form.querySelector('[data-testid="source-submit"]')) window.__rcConfirmation!.create ??= performance.now();
            if (form.querySelector('button')?.textContent === 'Confirm timer experiment') window.__rcConfirmation!.edit = performance.now();
          }, true);
        });
        await page.route('**/api/**', async route => {
          if (new URL(route.request().url()).pathname !== '/api/worldstream/source' || !active) {
            await route.fulfill({ status: 503, json: { kind: 'rejected', code: 'BENCHMARK_UNMEASURED_REQUEST' } }); return;
          }
          const current = active;
          const request = new Request(route.request().url(), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: route.request().postData() });
          const operation = handleSourceRequest(request, async (source, revision) => {
            const start = nodePerformance.now(); let modelMs = 0;
            const result = await runSourceProposal(source, revision, { grammar, emit: async r => {
              const at = nodePerformance.now();
              // A clarified source is a new request, not a transport retry.
              try { return options.fixture ? await options.fixture(r) : await current.emit(r, 'compiler', 0); }
              finally { modelMs += nodePerformance.now() - at; }
            } });
            current.recordStage('validation', Math.max(0, nodePerformance.now() - start - modelMs));
            return result;
          }, options.fixture ? 'fixture' : 'live');
          pending.add(operation);
          let response: Response;
          try { response = await operation; } finally { pending.delete(operation); }
          const result = await response.json();
          responses.push({ kind: result.kind ?? 'http-error', code: result.code ?? null, questions: result.questions ?? [],
            conflicts: result.conflicts ?? [], unsupported: result.unsupported ?? [] });
          await route.fulfill({ status: response.status, json: result, headers: { 'Cache-Control': 'no-store' } });
        });
        await page.goto(options.baseURL);
        await page.getByText('Build from a source', { exact: true }).click();
        await page.getByLabel('Source title', { exact: true }).fill(input.id);
        await page.getByTestId('source-input').fill(input.source);
      } else {
        const created = previous as BrowserArtifact;
        if (!created.observation || !page) throw new Error('CREATE_ARTIFACT_MISSING');
        const startTick = created.observation.inputs.find(i => i.target === task.startTarget && i.actionId === task.actionId)?.tick;
        if (startTick === undefined) throw new Error('START_INPUT_MISSING');
        await page.getByTestId('runtime-pause').click();
        await act(task.actor, 'moveTo', task.approachTarget);
        const action = (await observe(page))?.actions.findIndex(a => a.actor === task.actor && a.actionId === task.actionId && a.target === task.finishTarget);
        if (action === undefined || action < 0) throw new Error('FINISH_ACTION_MISSING');
        await page.getByTestId('runtime-action').selectOption(String(action));
        // Dispatch the selected UI action at the observed tick in the browser,
        // without a slow automation round trip or a writable runtime probe.
        await page.waitForFunction(targetTick => {
          if ((window.__realityCompiler?.snapshot()?.runtime.tick ?? -1) < targetTick) return false;
          const button = document.querySelector<HTMLButtonElement>('[data-testid="runtime-act"]');
          if (!button || button.disabled) return false;
          button.click();
          document.querySelector<HTMLButtonElement>('[data-testid="runtime-pause"]')!.click();
          return true;
        }, startTick + task.waitTicks, { timeout, polling: 25 });
        await expect(page.getByTestId('runtime-input-result')).toContainText('Applied:');
        await page.getByText('Experiment with a future timer', { exact: true }).click();
        await page.getByLabel('Reason for intervention', { exact: true }).fill(input.intervention);
        originalBeforeEdit = await observe(page);
        if (!originalBeforeEdit?.runtime.paused) throw new Error('ORIGINAL_NOT_PAUSED');
        const horizon = originalBeforeEdit.runtime.tick + 1;
        // Skutečný negativní commit: změna běžícího timeru v dřívějším forku.
        await fillIntervention(task, startTick + 1, horizon);
        await page.getByRole('button', { name: 'Confirm timer experiment', exact: true }).click();
        await expect(page.getByTestId('source-status')).toContainText('Intervention refused');
        rejectedUnchanged = JSON.stringify(await observe(page)) === JSON.stringify(originalBeforeEdit);
        await fillIntervention(task, 0, horizon);
        await page.evaluate(() => { window.__rcConfirmation!.edit = null; });
      }
      } catch (error) {
        if (options.artifactDirectory) {
          const artifact = await snapshot('PREPARATION_FAILED', phase);
          writeFileSync(join(options.artifactDirectory, `pair-${pair}-${phase}-preparation.json`),
            JSON.stringify({ error: String(error), artifact }, null, 2));
        }
        throw error;
      }
    },
    async execute(input, phase, _previous, context): Promise<ProductResult> {
      if (!page) throw new Error('PAGE_MISSING');
      active = context;
      context.notUsed('queue'); // Admission is immediate; the source handler has no waiting queue.
      context.notUsed('planner');
      context.notUsed('repair'); // Clarification resubmits source; no automatic repair loop.
      context.notUsed('humanWait'); // Stored answers supplied automatically; real human time is a separate study.
      if (phase === 'edit' || options.fixture) context.notUsed('compiler');
      let completed = false;
      let error: string | null = null;
      let timing: ProductResult['timing'];
      try {
        if (phase === 'create') {
          const submitSource = async () => {
            await Promise.all([
              page!.waitForResponse(r => new URL(r.url()).pathname === '/api/worldstream/source' && r.request().method() === 'POST', { timeout }),
              page!.getByTestId('source-submit').click(),
            ]);
            await expect(page!.getByTestId('source-submit')).toBeEnabled({ timeout });
          };
          await submitSource();
          if (responses[0]?.kind === 'needsClarification') {
            problematicStopped = (await observe(page)) === null;
            if (!input.clarification) throw new Error('UNEXPECTED_CLARIFICATION');
            // Předem uložená odpověď se poskytne až po skutečném zastavení.
            await page.getByTestId('source-input').fill(`${input.source}\n\nClarification: ${input.clarification}`);
            await submitSource();
          } else if (input.kind !== 'complete') problematicStopped = false;
          if (responses.at(-1)?.kind !== 'proposed') throw new Error('SOURCE_NOT_PROPOSED');
          await expect(page.getByTestId('source-status')).toContainText('Source accepted');
          await context.stage('mesh', waitForFrame);
          await context.stage('firstInteraction', async () => {
            const task = taskFor(input);
            await act(task.actor, task.actionId, task.startTarget);
            await expect(page!.getByTestId('runtime-input-result')).toContainText('Applied:');
            await waitForFrame();
          });
        } else {
          await context.stage('comparison', async () => {
            await page!.getByRole('button', { name: 'Confirm timer experiment', exact: true }).click();
            await expect(page!.getByTestId('source-status')).toContainText('Intervention accepted');
            await expect(page!.getByTestId('branch-comparison')).toBeVisible();
            await waitForFrame();
            const state = await observe(page!);
            const c = state?.project.comparison;
            if (!c || c.original.observationTick !== c.changed.observationTick || c.observationTick !== c.original.observationTick)
              throw new Error('COMPARISON_HORIZON_MISMATCH');
          });
        }
        completed = true;
      } catch (e) { error = e instanceof Error && /Timeout|timeout|Timed out/.test(e.message) ? 'TIMEOUT' : 'VALIDATION_FAILED'; }
      finally {
        active = null;
        // Nezačít další pár, dokud je předchozí placená odpověď v letu.
        await Promise.allSettled([...pending]);
        timing = await page.evaluate(p => {
          const at = p === 'create' ? window.__rcConfirmation?.create : window.__rcConfirmation?.edit;
          const result = at == null ? undefined : { wallMs: performance.now() - at, humanWaitMs: 0 };
          // Freeze via the existing UI after the measured endpoint, before
          // screenshots and preparation can consume the task's timer window.
          if (p === 'create' && window.__realityCompiler?.snapshot()?.runtime.paused === false)
            document.querySelector<HTMLButtonElement>('[data-testid="runtime-pause"]')?.click();
          return result;
        }, phase).catch(() => undefined);
      }
      if (completed && !timing) { completed = false; error = 'VALIDATION_FAILED'; }
      const artifact = await snapshot(error, phase);
      return { completed, artifact, timing, execution: phase === 'edit' ? 'deterministic' : options.fixture ? 'replay' : 'inference',
        ...(error ? { error: error as 'TIMEOUT' | 'VALIDATION_FAILED' } : {}) };
    },
    async evaluate(input, created, edited) {
      return options.evaluate(input, created as BrowserArtifact ?? null, edited as BrowserArtifact ?? null);
    },
    async dispose() { active = null; if (page) await page.context().close(); page = null; },
  };
}
