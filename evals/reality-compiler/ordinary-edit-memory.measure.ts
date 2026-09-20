/** Opt-in fixture browser LRU eviction; no inference/server commit-gate credit. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect as browserExpect } from '@playwright/test';
import { expect, it } from 'vitest';
import { browserRenderer } from '../../scripts/browser-renderer';
import { ORDINARY_MEMORY_SEQUENCE, ordinaryMemoryFixture, ordinaryMemoryFixtureHashes, validateOrdinaryMemorySamples,
  type OrdinaryMemorySample } from '../../scripts/reality-compiler-ordinary-edit-memory';
import type { StageProbe } from '../../src/components/viewer/WorldstreamStage';
import type { PipelineMetricsSnapshot } from '../../src/worldstream/pipeline-metrics';
import type { RuntimeController } from '../../src/worldstream/runtime-controller';

declare global { interface Window { __ordinaryMemoryJobs?: number; __worldstreamStage?: StageProbe;
  __worldstreamMetrics?: { snapshot(): PipelineMetricsSnapshot;
    explainTick(tick: number): ReturnType<RuntimeController['explainTick']> } } }
const sources = ['src/shape/mesh-cache.ts', 'src/shape/mesh-client.ts', 'src/app/page.tsx',
  'src/components/viewer/WorldstreamStage.tsx', 'src/worldstream/pipeline-metrics.ts',
  'scripts/reality-compiler-ordinary-edit-memory.ts', 'evals/reality-compiler/ordinary-edit-memory.measure.ts'];
const hashes = () => Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));

it.skipIf(process.env.RC_ORDINARY_MEMORY !== '1')('crosses the ordinary browser cache eviction boundary and revisits recent data', async () => {
  const baseURL = process.env.RC_ORDINARY_MEMORY_BASE_URL;
  if (!baseURL || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseURL)) throw new Error('FIXED_LOOPBACK_BASE_REQUIRED');
  const directory = resolve('scratch/session7-ordinary-edit-memory', randomUUID()); mkdirSync(directory, { recursive: true });
  const before = hashes(), build = { buildId: readFileSync('.next/BUILD_ID', 'utf8').trim(),
    pageSha256: createHash('sha256').update(readFileSync('.next/server/app/page.js')).digest('hex') };
  const buildReceiptPath = process.env.RC_ORDINARY_MEMORY_BUILD_RECEIPT ?? null;
  const buildReceipt = buildReceiptPath ? JSON.parse(readFileSync(buildReceiptPath, 'utf8').replace(/^\uFEFF/, '')) : null;
  const prepared = { version: 1, origin: 'fixture', modelCalls: 0, humanObservation: false, liveMeasurement: 'NOT_RUN',
    units: 'renderer resource counts, not VRAM bytes', vramBytes: null, heapBytes: null,
    sequence: ORDINARY_MEMORY_SEQUENCE, fixtureHashes: ordinaryMemoryFixtureHashes(), sourceHashesBefore: before, build,
    buildReceiptPath, buildReceipt, buildSourceIdentity: 'See explicit build receipt; no attestation from BUILD_ID alone',
    limitations: ['Scripted preview/commit/snapshot; server commit gate and model inference not tested.',
      'Frame completion follows gl.render, not GPU scanout; no human quality or general latency percentile claim.',
      'Crossing16programs forces cache eviction; this does not expose exact internal byte accounting or prove VRAM byte bounds.'] };
  writeFileSync(resolve(directory, 'prepared.json'), JSON.stringify(prepared, null, 2), { flag: 'wx' });
  const browser = await chromium.launch({ headless: true, args: browserRenderer().args });
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const samples: OrdinaryMemorySample[] = []; const accepted: unknown[] = []; const blocked: string[] = [];
  let blueprint = ordinaryMemoryFixture(0), previews = 0, commits = 0, snapshots = 0, initialWorkerJobs = 0;
  let device: unknown = null, failure: string | null = null;
  const session = '44444444-4444-4555-8666-777777777777';
  try {
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== baseURL && ['http:', 'https:'].includes(url.protocol)) {
        blocked.push(url.origin); return route.abort();
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'FIXTURE_UNHANDLED_ENDPOINT' } });
      return route.continue();
    });
    await page.addInitScript(() => {
      window.__ordinaryMemoryJobs = 0;
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        if (message && typeof message === 'object' && 'program' in message && 'jobId' in message) window.__ordinaryMemoryJobs!++;
        original.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
      };
    });
    await page.route('**/api/worldstream/sessions', route => route.request().postDataJSON()?.live
      ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 202, json: { sessionId: session,
        events: `/api/worldstream/sessions/${session}/events`, snapshot: `/api/worldstream/sessions/${session}`, authored: { match: 'exact' } } }));
    await page.route(`**/api/worldstream/sessions/${session}/events*`, route => route.fulfill({ contentType: 'text/event-stream', body:
      [ ['blueprint.ready', { blueprint }], ['session.complete', {}] ].map(([type, payload], i) =>
        `data: ${JSON.stringify({ sessionId: session, sequence: i + 1, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`).join('') }));
    await page.route(`**/api/worldstream/sessions/${session}/changes`, route => {
      const variant = ORDINARY_MEMORY_SEQUENCE[previews++];
      expect(route.request().postDataJSON().prompt).toBe(`Set visitor shape variant ${variant}.`);
      return route.fulfill({ json: { changeId: `shape-${previews}`, summary: `Variant ${variant}`,
        target: { stableId: 'visitor', label: 'the visitor' }, scope: { shape: true, behavior: 0, appearance: 0 },
        preserved: ['visitor'], authored: { match: 'exact' } } });
    });
    await page.route(`**/api/worldstream/sessions/${session}/changes/*/commit`, route => {
      expect(route.request().url()).toContain(`/shape-${commits + 1}/commit`);
      const variant = ORDINARY_MEMORY_SEQUENCE[commits++]; blueprint = ordinaryMemoryFixture(variant);
      accepted.push({ edit: commits, variant, fixtureSha256: createHash('sha256').update(JSON.stringify(blueprint)).digest('hex') });
      return route.fulfill({ json: { outcome: 'COMMITTED', stableId: 'visitor', summary: `Variant ${variant}`, representation: commits,
        revisions: { sim: { before: 0, after: 0 }, look: { before: 0, after: 0 } } } });
    });
    await page.route(`**/api/worldstream/sessions/${session}`, route => { snapshots++; return route.fulfill({ json: { blueprint } }); });
    await page.goto('/');
    await page.getByTestId('prompt-input').fill('Ordinary cache eviction fixture'); await page.getByTestId('prompt-submit').click();
    await browserExpect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30000 });
    if (await page.getByTestId('inspect').getAttribute('data-open') !== 'true') await page.getByTestId('inspect-toggle').click();
    await browserExpect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', { timeout: 60000 });
    await page.waitForFunction(() => window.__worldstreamStage?.ready());
    await page.getByTestId('runtime-pause').click();
    initialWorkerJobs = await page.evaluate(() => window.__ordinaryMemoryJobs!);
    device = await page.evaluate(() => { const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const extension = gl.getExtension('WEBGL_debug_renderer_info'); return { browser: navigator.userAgent,
        renderer: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER), hardwareConcurrency: navigator.hardwareConcurrency,
        viewport: [innerWidth, innerHeight], devicePixelRatio }; });
    let previous = await page.evaluate(() => window.__worldstreamStage!.slots()[0].representationId);
    for (const [index, variant] of ORDINARY_MEMORY_SEQUENCE.entries()) {
      await page.getByTestId('refine-input').fill(`Set visitor shape variant ${variant}.`); await page.getByTestId('refine-submit').click();
      await browserExpect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview'); await page.getByTestId('change-apply').click();
      await browserExpect(page.getByTestId('change-preview')).toHaveCount(0);
      await browserExpect(page.getByTestId('refine-submit')).toBeEnabled();
      await page.waitForFunction(old => window.__worldstreamStage!.slots()[0].representationId !== old, previous);
      await page.waitForFunction(() => {
        const stages = window.__worldstreamMetrics!.snapshot().runs.at(-1)?.stages;
        return stages?.some(s => s.name === 'mesh' && s.outcome === 'completed') && stages.some(s => s.name === 'first-frame' && s.outcome === 'completed');
      });
      const frame = await page.evaluate(() => window.__worldstreamStage!.frames());
      await page.waitForFunction(old => window.__worldstreamStage!.frames() > old + 3, frame);
      const sample = await page.evaluate(({ edit, variant }) => {
        const pipeline = window.__worldstreamMetrics!.snapshot().runs.at(-1)!;
        return { edit, variant, workerJobs: window.__ordinaryMemoryJobs!, representationId: window.__worldstreamStage!.slots()[0].representationId,
          memory: window.__worldstreamStage!.memory(), mesh: pipeline.stages.find(s => s.name === 'mesh')!,
          frame: pipeline.stages.find(s => s.name === 'first-frame') ?? null,
          triangles: window.__worldstreamStage!.slots()[0].triangles, pipeline };
      }, { edit: index + 1, variant });
      samples.push(sample); previous = sample.representationId;
      writeFileSync(resolve(directory, `edit-${index + 1}.json`), JSON.stringify(sample, null, 2), { flag: 'wx' });
    }
    expect(previews).toBe(18); expect(commits).toBe(18); expect(snapshots).toBe(18);
    expect(validateOrdinaryMemorySamples(initialWorkerJobs, samples).status).toBe('PASS');
    expect(hashes()).toEqual(before);
  } catch (error) { failure = String(error); throw error; }
  finally {
    await context.close(); await browser.close();
    const report = { ...prepared, sourceHashesAfter: hashes(), failure, status: failure ? 'FAIL' : 'PASS',
      device, initialWorkerJobs, previews, commits, snapshots, accepted, samples, blockedExternalOrigins: blocked,
      evaluation: validateOrdinaryMemorySamples(initialWorkerJobs, samples), browserClosed: true };
    writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(`ORDINARY_EDIT_MEMORY_${report.status} ${directory}`);
  }
}, 180000);
