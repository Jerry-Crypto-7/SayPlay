import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import surface from '../evals/reality-compiler/museum.sim.json';
import { openInspect } from './inspect';
import type { PipelineRunSnapshot } from '../src/worldstream/pipeline-metrics';

declare global { interface Window { __editMeshJobs?: number } }

// Scripted preview/commit/snapshot on the production page. Real blueprint
// validation, mesh worker/cache, reconciliation, renderer and runtime.
test('25 ordinary shape edits retain runtime, camera and bounded renderer resources', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.__editMeshJobs = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if (message && typeof message === 'object' && 'program' in message && 'jobId' in message)
        window.__editMeshJobs!++;
      send.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };
  });
  const sim = structuredClone(surface);
  Object.entries(sim.rules).forEach(([id, rule]) => Object.assign(rule, { id }));
  const shapeA = { ...structuredClone(EXAMPLE_BLUEPRINT_ANSWER.shapes[0]), shapeId: 'visitor-shape', stableId: 'visitor' };
  const shapeB = { ...shapeA, nodes: shapeA.nodes.map((node, index) => index === 0 ? { ...node, radius: 0.42 } : node) };
  let blueprint = blueprintSchema.parse({
    version: 'worldstream-v1', sessionSeed: 4021, title: 'Ordinary edit memory fixture',
    intent: EXAMPLE_PLAN.intent, geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry, shapes: [shapeA],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0,
      sim, look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'shape', shapeId: 'visitor-shape' }, targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] } }],
  });
  const session = '33333333-4444-4555-8666-777777777777';
  let previews = 0, commits = 0, snapshots = 0;
  const accepted: { representation: number; variant: string; simRevision: number; lookRevision: number }[] = [];
  await page.route('**/api/worldstream/sessions', route => route.request().postDataJSON()?.live
    ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 202, json: {
    sessionId: session, events: `/api/worldstream/sessions/${session}/events`,
    snapshot: `/api/worldstream/sessions/${session}`, authored: { match: 'exact' },
  } }));
  await page.route(`**/api/worldstream/sessions/${session}/events*`, route => {
    const frame = (sequence: number, type: string, payload: unknown) =>
      `data: ${JSON.stringify({ sessionId: session, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    return route.fulfill({ contentType: 'text/event-stream', body:
      frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {}) });
  });
  await page.route(`**/api/worldstream/sessions/${session}/changes`, route => {
    previews++;
    expect(route.request().postDataJSON().prompt).toBe(`Set visitor shape variant ${previews % 2 ? 'B' : 'A'}.`);
    return route.fulfill({ json: { changeId: `shape-${previews}`, summary: `Shape variant ${previews % 2 ? 'B' : 'A'}`,
      target: { stableId: 'visitor', label: 'the visitor' }, scope: { shape: true, behavior: 0, appearance: 0 },
      preserved: ['visitor'], authored: { match: 'exact' } } });
  });
  await page.route(`**/api/worldstream/sessions/${session}/changes/*/commit`, route => {
    const next = commits + 1;
    expect(route.request().url()).toContain(`/shape-${next}/commit`);
    blueprint = blueprintSchema.parse({ ...blueprint, shapes: [next % 2 ? shapeB : shapeA] });
    commits++;
    accepted.push({ representation: next, variant: next % 2 ? 'B' : 'A', simRevision: blueprint.world.simRevision, lookRevision: blueprint.world.lookRevision });
    return route.fulfill({ json: { outcome: 'COMMITTED', stableId: 'visitor', summary: `Shape variant ${next % 2 ? 'B' : 'A'}`,
      representation: next, revisions: { sim: { before: 0, after: 0 }, look: { before: 0, after: 0 } } } });
  });
  await page.route(`**/api/worldstream/sessions/${session}`, route => {
    snapshots++;
    return route.fulfill({ json: { blueprint } });
  });
  await page.goto('/');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('Ordinary edit memory fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  await openInspect(page);
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', { timeout: 60_000 });
  await page.waitForFunction(() => window.__worldstreamStage?.ready());
  await settle(page);
  await page.getByTestId('runtime-action').selectOption({ label: 'activate sensorA (visitor)' });
  await page.getByTestId('runtime-act').click();
  await expect(page.getByTestId('runtime-input-result')).toContainText('Input at tick');
  await page.getByTestId('runtime-pause').click();
  const tick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  expect(Number(tick)).toBeGreaterThan(0);
  const inputResult = await page.getByTestId('runtime-input-result').innerText();
  // Explicit user camera input, then read back the real Stage camera.
  const canvas = page.locator('canvas[aria-label^="Scene camera"]');
  await canvas.focus();
  const cameraBefore = await page.evaluate(() => window.__worldstreamStage!.camera());
  await canvas.press('ArrowRight');
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage!.camera())).not.toEqual(cameraBefore);
  const camera = await page.evaluate(() => window.__worldstreamStage!.camera());
  const identity = await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({
    stableId: slot.stableId, objectId: slot.objectId, sockets: slot.sockets,
  })));
  expect(identity.length).toBeGreaterThan(0);
  expect(identity.every(slot => slot.objectId !== null)).toBe(true);
  let lastRepresentation = await page.evaluate(() => window.__worldstreamStage!.slots()[0].representationId);
  const initial = await page.evaluate(() => ({ workerJobs: window.__editMeshJobs!,
    pipeline: window.__worldstreamMetrics!.snapshot().runs.at(-1)! }));
  const device = await page.evaluate(() => {
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string : gl.getParameter(gl.RENDERER) as string,
      browser: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
      viewport: [innerWidth, innerHeight], devicePixelRatio };
  });
  const idleFrameIntervalsMs = await page.evaluate(() => new Promise<number[]>(resolve => {
    const values: number[] = [];
    let previous: number | null = null;
    const frame = (at: number) => {
      if (previous !== null) values.push(at - previous);
      previous = at;
      if (values.length === 120) resolve(values); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }));
  const samples: { edit: number; memory: { geometries: number; textures: number; programs: number }; builds: number;
    representationId: string | null; triangles: number; workerJobs: number; pipeline: PipelineRunSnapshot }[] = [];
  try {
    for (let edit = 1; edit <= 25; edit++) {
      await page.getByTestId('refine-input').fill(`Set visitor shape variant ${edit % 2 ? 'B' : 'A'}.`);
      await page.getByTestId('refine-submit').click();
      await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
      await page.getByTestId('change-apply').click();
      await expect(page.getByTestId('change-preview')).toHaveCount(0);
      await expect(page.getByTestId('refine-submit')).toBeEnabled();
      await page.waitForFunction(previous => window.__worldstreamStage!.slots()[0].representationId !== previous, lastRepresentation);
      await settle(page);
      // Runtime remains paused: the overall run can still await interaction.
      // Only the completed local mesh span is the cold/warm measurement.
      await expect.poll(() => page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)?.stages
        .find(stage => stage.name === 'mesh')?.outcome)).toBe('completed');
      samples.push(await page.evaluate(index => ({ edit: index, memory: window.__worldstreamStage!.memory(),
        builds: window.__worldstreamStage!.builds(), representationId: window.__worldstreamStage!.slots()[0].representationId,
        triangles: window.__worldstreamStage!.slots()[0].triangles, workerJobs: window.__editMeshJobs!,
        pipeline: window.__worldstreamMetrics!.snapshot().runs.at(-1)! }), edit));
      const mesh = samples.at(-1)!.pipeline.stages.find(stage => stage.name === 'mesh')!;
      expect(mesh.outcome).toBe('completed');
      expect(mesh.elapsedMs).not.toBeNull();
      if (mesh.provenance === 'cache')
        expect(samples.at(-1)!.workerJobs).toBe(edit === 1 ? initial.workerJobs : samples[edit - 2].workerJobs);
      else expect(samples.at(-1)!.workerJobs).toBeGreaterThan(edit === 1 ? initial.workerJobs : samples[edit - 2].workerJobs);
      const representation = samples.at(-1)!.representationId;
      expect(representation).not.toBeNull();
      expect(representation).not.toBe(lastRepresentation);
      lastRepresentation = representation;
      expect(commits).toBe(edit);
      await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', tick!);
      await expect(page.getByTestId('runtime-input-result')).toHaveText(inputResult);
      expect(await page.evaluate(() => window.__worldstreamStage!.camera())).toEqual(camera);
      expect(await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({
        stableId: slot.stableId, objectId: slot.objectId, sockets: slot.sockets,
      })))).toEqual(identity);
    }
  } finally {
    await testInfo.attach('ordinary-edit-resource-trend.json', { contentType: 'application/json', body: JSON.stringify({
      scope: 'production page ordinary shape edits with scripted preview/commit/snapshot', modelCalls: 0,
      humanObservation: false, units: 'renderer resource counts, not VRAM bytes',
      limitation: 'Does not test server shape commit gate or model inference; two alternating programs use warm mesh cache after their first mesh.',
      timingScope: 'Client mesh stage includes queue/cache/proxy work; separate idle rAF intervals are browser scheduling, not GPU execution or scanout. One session/two shapes, not a general latency percentile benchmark.',
      device, initial, idleFrameIntervalsMs, plannedEdits: 25, previews, commits, snapshots, accepted, samples, tick, identity, camera,
    }, null, 2) });
  }
  expect(samples).toHaveLength(25);
  expect(accepted.map(item => item.representation)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
  expect(accepted.every(item => item.simRevision === 0 && item.lookRevision === 0)).toBe(true);
  expect(snapshots).toBe(25);
  expect(samples[0].memory.geometries).toBeGreaterThan(0);
  expect(samples[0].memory.programs).toBeGreaterThan(0);
  expect(samples[0].triangles).not.toBe(samples[1].triangles);
  expect(initial.workerJobs).toBeGreaterThan(0);
  expect(samples.filter(sample => sample.pipeline.stages.find(stage => stage.name === 'mesh')?.provenance === 'cache').length).toBeGreaterThanOrEqual(23);
  for (const sample of samples) expect(sample.memory, `resource counts after edit ${sample.edit}`).toEqual(samples[0].memory);
});

async function settle(page: Page) {
  const frame = await page.evaluate(() => window.__worldstreamStage!.frames());
  await page.waitForFunction(previous => window.__worldstreamStage!.frames() > previous + 3, frame);
}
