import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import { commitPart } from '../src/ir/revision';
import surface from '../evals/reality-compiler/museum.sim.json';
import { openInspect } from './inspect';
import catalog from '../src/assets/catalog.json';
import { mkdir, writeFile } from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';

// Software WebGL builds the fixture before the interaction assertions begin.
test.setTimeout(90_000);

// Scripted model/transport; the accepted document uses the real patch gate.
// Runtime, visitor input, comparison and rendering execute unchanged on /.
async function museum(page: Page, options: {
  refuse?: boolean; hold?: boolean; failSnapshot?: boolean;
  snapshotStatus?: number; staleSnapshot?: boolean; holdRecovery?: boolean;
  failReplacement?: boolean; meshAfterCommit?: boolean; appearanceRefused?: boolean;
  nonTimer?: boolean;
} = {}) {
  const sim = structuredClone(surface);
  Object.entries(sim.rules).forEach(([id, rule]) => Object.assign(rule, { id }));
  let blueprint = blueprintSchema.parse({
    version: 'worldstream-v1', sessionSeed: 4021, title: 'Museum branch fixture',
    intent: EXAMPLE_PLAN.intent, geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry, shapes: [],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0,
      sim, look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'geom', node: 5 }, targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] } }],
  });
  if (options.nonTimer) {
    const asset = catalog.assets.find(item => item.assetId === 'desktop-terminal')!;
    const targetBounds = { min: [2, 0, 2], max: [3.1, 0.8, 2.65] };
    blueprint = blueprintSchema.parse({ ...blueprint, version: 'worldstream-v2', objects: [...blueprint.objects, {
      stableId: 'alarmSignal', label: 'alarm terminal', synonyms: [], role: 'hero', importance: 3,
      source: { kind: 'asset', assetId: asset.assetId, version: asset.version, hash: asset.hash }, targetBounds,
      binding: { collider: targetBounds, sockets: [], parts: [], signalFlag: 'alarm' },
    }] });
  }
  const id = '22222222-3333-4444-5555-666666666666';
  const original = structuredClone(blueprint);
  let sessions = 0;
  let commits = 0;
  let snapshots = 0;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let releaseRecovery = () => {};
  const recoveryHeld = new Promise<void>(resolve => { releaseRecovery = resolve; });
  await page.route('**/api/worldstream/sessions', route => {
    if (route.request().postDataJSON()?.live === true) return route.fulfill({ status: 503, body: '{}' });
    sessions++;
    if (options.failReplacement && sessions === 2)
      return route.fulfill({ status: 503, json: { error: { code: 'FIXTURE_UNAVAILABLE', message: 'Replacement unavailable.' } } });
    return route.fulfill({ status: 202, json: { sessionId: id, events: `/api/worldstream/sessions/${id}/events`,
      snapshot: `/api/worldstream/sessions/${id}`, authored: { match: 'exact' } } });
  });
  await page.route(`**/api/worldstream/sessions/${id}/events*`, route => {
    const frame = (sequence: number, type: string, payload: unknown) =>
      `data: ${JSON.stringify({ sessionId: id, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: frame(1, 'blueprint.ready', { blueprint: sessions > 1
        ? { ...original, title: 'Replacement museum' } : blueprint }) + frame(2, 'session.complete', {}) });
  });
  await page.route(`**/api/worldstream/sessions/${id}/changes`, route => {
    if (options.appearanceRefused) return route.fulfill({ status: 422, json: { error: {
      code: 'APPEARANCE_UNSUPPORTED', message: 'Appearance palette, material, lighting and atmosphere edits are not supported in this renderer. Shape edits remain available; nothing was changed.',
    } } });
    expect(route.request().postDataJSON().prompt).toBe(options.nonTimer ? 'The first sensor activates the alarm.' : 'Shorten the sensor countdown from 20 seconds to 10 seconds.');
    return route.fulfill({ json: { changeId: 'timer-change', summary: options.nonTimer ? 'The first sensor activates the alarm.' : 'Shorten the sensor countdown to 10 seconds.',
      target: { stableId: 'visitor', label: 'sensor countdown' }, scope: { shape: options.meshAfterCommit === true, behavior: 1, appearance: 0 },
      preserved: ['visitor', 'case', 'alarm'], authored: { match: 'exact' } } });
  });
  await page.route(`**/api/worldstream/sessions/${id}/changes/timer-change/commit`, async route => {
    commits++;
    if (options.hold) await held;
    if (options.refuse) return route.fulfill({ json: { outcome: 'REJECTED', rejections: [{ detail: 'Stale server revision.' }] } });
    const result = commitPart(blueprint.world, { part: 'sim', baseRevision: 0,
      operations: options.nonTimer
        ? [{ op: 'replace', path: '/rules/start_countdown/actions/0', value: { kind: 'setFlag', ref: 'alarm', value: true } }]
        : [{ op: 'replace', path: '/rules/start_countdown/actions/1/durationTicks', value: 200 }] });
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') throw new Error('fixture patch rejected');
    blueprint = { ...blueprint, world: result.doc };
    if (options.meshAfterCommit) {
      // Only the accepted snapshot needs this shape. No initial mesh order can
      // populate its cache entry, so the recovery path must reach the worker.
      const shape = { ...structuredClone(EXAMPLE_BLUEPRINT_ANSWER.shapes[0]),
        shapeId: 'accepted-visitor-shape', stableId: 'visitor' };
      blueprint = blueprintSchema.parse({ ...blueprint, shapes: [shape],
        objects: blueprint.objects.map(object => ({ ...object, source: { kind: 'shape', shapeId: shape.shapeId } })) });
    }
    return route.fulfill({ json: { outcome: 'COMMITTED', stableId: 'visitor', summary: 'Shortened countdown',
      revisions: { sim: { before: 0, after: blueprint.world.simRevision }, look: { before: 0, after: blueprint.world.lookRevision } } } });
  });
  await page.route(`**/api/worldstream/sessions/${id}/comparison/restore`, route => {
    const expected=route.request().postDataJSON();
    expect(expected.simRevision).toBe(blueprint.world.simRevision);
    blueprint={...blueprint,world:sealSimHash({...blueprint.world,sim:original.world.sim,simRevision:blueprint.world.simRevision+1})};
    return route.fulfill({json:{outcome:'RESTORED',acceptedBlueprint:blueprint}});
  });
  let snapshotFailed = false;
  await page.route(`**/api/worldstream/sessions/${id}`, async route => {
    snapshots++;
    if (options.failSnapshot && commits > 0 && !snapshotFailed) {
      snapshotFailed = true; return route.fulfill({ status: 503, json: {} });
    }
    if (options.snapshotStatus) return route.fulfill({ status: options.snapshotStatus, json: {} });
    const snapshot = structuredClone(options.staleSnapshot ? original : blueprint);
    if (options.holdRecovery && commits > 0) await recoveryHeld;
    return route.fulfill({ json: { blueprint: snapshot } });
  });
  await page.goto('/studio');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('Museum branch fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  return { commits: () => commits, snapshots: () => snapshots, release, releaseRecovery };
}

async function act(page: Page, label: string) {
  await page.getByTestId('runtime-action').selectOption({ label });
  await page.getByTestId('runtime-act').click();
}
async function preview(page: Page, prompt = 'Shorten the sensor countdown from 20 seconds to 10 seconds.') {
  await page.getByTestId('refine-input').fill(prompt);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
  await page.getByText('Exact simulation times', {exact:true}).click();
}

test('an accepted non-timer action compares the same visitor input on the main page', async ({ page }, info) => {
  const server = await museum(page, { nonTimer: true });
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  const tick = Number(await page.getByTestId('runtime-tick').getAttribute('data-tick'));
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: off');
  await page.getByTestId('rewind-before-action').click();
  await preview(page, 'The first sensor activates the alarm.');
  await page.getByTestId('branch-observation-input').fill(String(tick + 40));
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('branch-rule')).toContainText('start_countdown: action changed');
  await expect(page.getByTestId('branch-horizon')).toContainText('same 1 visitor inputs');
  await expect(page.getByTestId('branch-value-f:alarm').locator('td')).toHaveText(['off', 'on']);
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: on');
  await expect(page.getByTestId('future-views')).toBeVisible();
  await expect(page.getByTestId('future-views').locator('canvas')).toHaveCount(2);
  await page.waitForTimeout(800); // asset decode and the first complete render pass
  const canvases = page.getByTestId('future-views').locator('canvas');
  const images = await Promise.all([canvases.nth(0).screenshot(), canvases.nth(1).screenshot()]);
  const pixels = await Promise.all(images.map(buffer => sharp(buffer).resize(640,480).removeAlpha().raw().toBuffer()));
  let different = 0;
  for (let i=0; i<pixels[0].length; i+=3) if (Math.max(...[0,1,2].map(c => Math.abs(pixels[0][i+c]-pixels[1][i+c]))) > 20) different++;
  expect(different / (640*480)).toBeGreaterThan(0.001);
  const artifacts=info.outputPath('a4');
  await mkdir(artifacts, { recursive: true });
  const futureBounds=await page.getByTestId('future-views').boundingBox();
  const controlBounds=await page.locator('.ws-controls').boundingBox();
  expect(futureBounds!.y+futureBounds!.height).toBeLessThanOrEqual(controlBounds!.y);
  const budget = await canvases.evaluateAll(elements => Promise.all(elements.map(async element => {
    const probe = (element as HTMLCanvasElement).__worldstreamStage!;
    return { quality: probe.quality(), memory: probe.memory(), camera: probe.camera(), renderTiming:await probe.measureRender(60) };
  })));
  for (const view of budget) expect(view.quality!.drawCalls).toBeLessThanOrEqual(view.quality!.budget.maxDrawCalls);
  expect(budget[0].camera).toEqual(budget[1].camera);
  await writeFile(join(artifacts,'two-view-gpu-budget.json'),JSON.stringify({provenance:'production-browser deterministic fixture, two WebGL contexts',
    views:budget,totalDrawCalls:budget.reduce((sum,view)=>sum+view.quality!.drawCalls,0),
    limitation:'GPU render queries measured per context; CPU asset cache shared; GPU buffers belong to separate contexts. Not target-notebook G-P evidence.'},null,2));
  await page.screenshot({ path: join(artifacts,'two-futures-gpu.png') });
  await page.getByTestId('future-time').focus();
  await page.getByTestId('future-time').press('Home');
  await expect(page.getByTestId('future-time')).toHaveValue((await page.getByTestId('future-time').getAttribute('min'))!);
  await page.getByTestId('future-time').press('End');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button', {name:'Original view',exact:true}).click();
  await expect(page.getByRole('region',{name:'Original future'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Changed future'})).toBeHidden();
  await page.screenshot({ path: join(artifacts,'mobile-future.png') });
  await page.setViewportSize({width:1280,height:900});
  expect(server.commits()).toBe(1);
  await page.getByTestId('branch-original').click();
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: off');
  await page.getByTestId('branch-restart').click();
  await expect(page.getByTestId('future-views')).toHaveCount(0);
  await expect(page.getByTestId('refine-submit')).toBeEnabled();
  await preview(page, 'The first sensor activates the alarm.');
  await expect(page.getByTestId('change-apply')).toBeEnabled();
});

test('an unsupported appearance preview explains the limitation and preserves the running world', async ({ page }) => {
  const server = await museum(page, { appearanceRefused: true });
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  const tick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  const input = await page.getByTestId('runtime-input-result').innerText();
  await page.getByTestId('refine-input').fill('Make the visitor red.');
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-refusal')).toContainText('not supported in this renderer');
  await expect(page.getByTestId('change-refusal')).toContainText('nothing was changed');
  await expect(page.getByTestId('change-apply')).toHaveCount(0);
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', tick!);
  await expect(page.getByTestId('runtime-input-result')).toHaveText(input);
  await page.getByTestId('runtime-pause').click();
  await act(page, 'Walk to approachB (visitor)');
  await expect(page.getByTestId('runtime-input-result')).toContainText('Applied: sys.moveTo.approachB');
  expect(server.commits()).toBe(0);
  expect(server.snapshots()).toBe(0);
  const measured = await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!);
  expect(measured).toMatchObject({ kind: 'prompt-edit', outcome: 'failed' });
});

test('an accepted change whose snapshot fails is recovered without a second commit', async ({ page }) => {
  const server = await museum(page, { failSnapshot: true });
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  await preview(page);
  await page.getByTestId('branch-observation-input').fill('300');
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-recovery')).toContainText('accepted');
  await expect(page.getByTestId('change-recovery')).toContainText('simulation 1');
  await expect(page.getByTestId('refine-submit')).toBeDisabled();
  expect(server.commits()).toBe(1);
  await page.getByTestId('change-resync').click();
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
  await expect(page.getByTestId('branch-comparison')).toBeVisible();
  await expect(page.getByTestId('branch-comparison')).toContainText('20s → 10s');
  expect(server.commits()).toBe(1);
  await expect.poll(async () => page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)?.outcome)).toBe('completed');
  const measured = await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!);
  expect(measured.kind).toBe('prompt-edit');
  expect(measured.stages.filter(stage => stage.name === 'snapshot-request').map(stage => stage.outcome)).toEqual(['failed', 'completed']);
  expect(measured.stages.filter(stage => stage.name === 'commit-request')).toHaveLength(1);
  expect(measured.stages.map(stage => stage.name)).toEqual(expect.arrayContaining([
    'change-request', 'change-review', 'validation', 'mesh', 'compare', 'lowering', 'first-frame',
  ]));
  expect(measured.stages.some(stage => stage.name === 'first-interaction')).toBe(false);
});

test('worker failure after acceptance keeps the committed branch usable with an explicit clay fallback', async ({ page }) => {
  const server = await museum(page, { meshAfterCommit: true });
  await openInspect(page);
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live');
  await page.waitForFunction(() => window.__worldstreamStage?.ready());
  const originalObject = await page.evaluate(() => window.__worldstreamStage!.slots().find(slot => slot.stableId === 'visitor')!.objectId);
  expect(originalObject).not.toBeNull();
  await act(page, 'activate sensorA (visitor)');
  const start = Number((await page.getByTestId('runtime-input-result').innerText()).match(/tick (\d+)/)![1]);
  await page.getByTestId('runtime-pause').click();
  await preview(page);
  await page.getByTestId('branch-observation-input').fill(String(start + 300));
  // Install only after initial loading. The real browser mesh client receives
  // a synchronous worker transport failure; neither its fallback nor its
  // accepted-revision handling is mocked.
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    document.body.dataset.acceptedMeshFaults = '0';
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const job = message as { jobId?: string; program?: { shapeId?: string } };
      if (job.program?.shapeId === 'accepted-visitor-shape' && document.body.dataset.allowAcceptedMesh !== 'true') {
        document.body.dataset.acceptedMeshFaults = String(Number(document.body.dataset.acceptedMeshFaults) + 1);
        document.body.dataset.acceptedMeshJob = job.jobId ?? '';
        throw new Error('TEST_ACCEPTED_MESH_UNAVAILABLE');
      }
      send.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };
  });
  const acceptedResponse = page.waitForResponse(response => response.url().endsWith('/changes/timer-change/commit'));
  await page.getByTestId('change-apply').click();
  const accepted = await (await acceptedResponse).json();
  expect(accepted.outcome).toBe('COMMITTED');
  expect(accepted.revisions.sim.after).toBe(1);
  await expect(page.locator('body')).toHaveAttribute('data-accepted-mesh-faults', '1');
  await expect(page.locator('body')).toHaveAttribute('data-accepted-mesh-job', /.+/);
  await expect(page.getByTestId('branch-rule')).toContainText('20s → 10s');
  await expect(page.getByTestId('branch-value-f:alarm').locator('td')).toHaveText(['off', 'on']);
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: on');
  const fallback = page.getByTestId('world-facts-slot').filter({ hasText: 'the visitor' });
  await expect(fallback).toHaveAttribute('data-rung', 'semantic-clay');
  await expect(fallback).toContainText('TEST_ACCEPTED_MESH_UNAVAILABLE');
  const changedCanvas = page.getByTestId('future-views').locator('.ws-future-changed canvas');
  await expect.poll(() => changedCanvas.evaluate(canvas => (canvas as HTMLCanvasElement).__worldstreamStage?.ready())).toBe(true);
  const changedObject = await changedCanvas.evaluate(canvas => (canvas as HTMLCanvasElement).__worldstreamStage!.slots().find(slot => slot.stableId === 'visitor')!.objectId);
  expect(changedObject).not.toBeNull(); // a separate renderer owns a separate Object3D, with the same stableId
  await expect(page.getByTestId('change-recovery')).toContainText('accepted (simulation 1');
  await expect(page.getByTestId('change-resync')).toHaveText('Retry accepted detail');
  await page.getByTestId('change-resync').click();
  await expect(page.getByTestId('change-recovery')).toContainText('still unavailable');
  await expect(page.locator('body')).toHaveAttribute('data-accepted-mesh-faults', '2');
  expect(server.commits()).toBe(1);
  expect(server.snapshots()).toBe(1);
  await page.getByTestId('branch-original').click();
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: off');
  await page.getByTestId('branch-changed').click();
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: on');
  await expect(page.getByTestId('runtime-pause')).toBeDisabled();
  const acceptedTick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  await page.getByTestId('branch-original').click();
  await page.evaluate(() => { document.body.dataset.allowAcceptedMesh = 'true'; });
  await page.getByTestId('change-resync').click();
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: off');
  // Both futures are rendered simultaneously, so changed detail can paint
  // while the original branch is selected in the textual inspector.
  await expect.poll(async () => page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)?.outcome)).toBe('completed');
  await page.getByTestId('branch-changed').click();
  await expect(fallback).not.toHaveAttribute('data-rung', 'semantic-clay');
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', acceptedTick!);
  await expect(page.getByTestId('branch-value-f:alarm').locator('td')).toHaveText(['off', 'on']);
  expect(await changedCanvas.evaluate(canvas => (canvas as HTMLCanvasElement).__worldstreamStage!.slots().find(slot => slot.stableId === 'visitor')!.objectId)).toBe(changedObject);
  await expect.poll(async () => page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)?.outcome)).toBe('completed');
  const retries = await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.filter(run => run.kind === 'prompt-detail-retry'));
  expect(retries.map(run => run.outcome)).toEqual(['failed', 'completed']);
  expect(retries.every(run => run.stages.every(stage => stage.name === 'mesh' || stage.name === 'first-frame'))).toBe(true);
  expect(server.commits()).toBe(1);
  expect(server.snapshots()).toBe(1);
});

test('a late detail retry cannot replace a new generation', async ({ page }) => {
  const server = await museum(page, { meshAfterCommit: true });
  await preview(page);
  await page.evaluate(() => {
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if ((message as { program?: { shapeId?: string } }).program?.shapeId === 'accepted-visitor-shape') {
        if (document.body.dataset.holdAcceptedDetail !== 'true') throw new Error('TEST_DETAIL_UNAVAILABLE');
        const worker = this;
        Object.assign(window, { releaseAcceptedDetail: () => send.call(worker, message, Array.isArray(transfer) ? { transfer } : transfer) });
        document.body.dataset.acceptedDetailHeld = 'true';
        return;
      }
      send.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };
  });
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-resync')).toHaveText('Retry accepted detail');
  await page.evaluate(() => { document.body.dataset.holdAcceptedDetail = 'true'; });
  await page.getByTestId('change-resync').click();
  await expect(page.locator('body')).toHaveAttribute('data-accepted-detail-held', 'true');
  await page.getByTestId('prompt-input').fill('Replacement museum');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live');
  await page.evaluate(() => (window as unknown as { releaseAcceptedDetail(): void }).releaseAcceptedDetail());
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
  await expect(page.getByTestId('runtime-act')).toBeEnabled();
  await expect(page.getByTestId('runtime-input-result')).not.toContainText('Input at tick');
  await expect(page.getByTestId('refine-submit')).toBeEnabled();
  expect(server.commits()).toBe(1);
  expect(server.snapshots()).toBe(1);
});

test('an expired accepted session preserves the paused view and repeated recovery never recommits', async ({ page }) => {
  const server = await museum(page, { snapshotStatus: 404 });
  await page.getByTestId('runtime-pause').click();
  const tick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  await preview(page);
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-recovery')).toContainText('accepted (simulation 1');
  await expect(page.getByTestId('change-recovery')).toContainText('HTTP 404');
  await expect(page.getByTestId('change-recovery')).toContainText('Start a new world');
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByTestId('change-resync').click();
    await expect.poll(server.snapshots).toBe(attempt + 2);
    await expect(page.getByTestId('change-resync')).toBeEnabled();
    await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', tick!);
    await expect(page.getByTestId('runtime-pause')).toHaveText('Resume');
    await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
    await expect(page.getByTestId('refine-submit')).toBeDisabled();
    expect(server.commits()).toBe(1);
  }
});

test('a snapshot from the wrong revision cannot masquerade as the accepted change', async ({ page }) => {
  const server = await museum(page, { staleSnapshot: true });
  await page.getByTestId('runtime-pause').click();
  const tick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  await preview(page);
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-recovery')).toContainText('different revision');
  await page.getByTestId('change-resync').click();
  await expect.poll(server.snapshots).toBe(2);
  await expect(page.getByTestId('change-resync')).toBeEnabled();
  await expect(page.getByTestId('change-recovery')).toContainText('simulation 1');
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', tick!);
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
  expect(server.commits()).toBe(1);
});

test('a new generation cancels pending recovery and ignores the old accepted snapshot', async ({ page }) => {
  const server = await museum(page, { failSnapshot: true, holdRecovery: true });
  await openInspect(page);
  await page.getByTestId('runtime-pause').click();
  await preview(page);
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-recovery')).toBeVisible();
  await page.getByTestId('change-resync').click();
  await expect.poll(server.snapshots).toBe(2);
  await expect(page.getByTestId('change-resync')).toBeDisabled();
  const aborted = page.waitForEvent('requestfailed', request =>
    request.url().endsWith('/sessions/22222222-3333-4444-5555-666666666666'));
  await page.getByTestId('prompt-input').fill('Replacement museum');
  await page.getByTestId('prompt-submit').click();
  await aborted;
  await expect(page.getByTestId('world-facts').getByRole('heading')).toHaveText('Replacement museum');
  server.releaseRecovery();
  await expect(page.getByTestId('runtime-act')).toBeEnabled();
  await act(page, 'activate sensorA (visitor)');
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
  await expect(page.getByTestId('world-facts').getByRole('heading')).toHaveText('Replacement museum');
  await expect(page.getByTestId('refine-submit')).toBeEnabled();
  expect(server.commits()).toBe(1);
});

test('failed replacement generation reports its own failure and offers no obsolete recovery action', async ({ page }) => {
  const server = await museum(page, { snapshotStatus: 404, failReplacement: true });
  await page.getByTestId('runtime-pause').click();
  await preview(page);
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-recovery')).toContainText('HTTP 404');
  await page.getByTestId('prompt-input').fill('Replacement museum');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-broken')).toBeVisible();
  await expect(page.getByTestId('world-fault')).toContainText('FIXTURE_UNAVAILABLE');
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
  await expect(page.getByTestId('change-resync')).toHaveCount(0);
  await expect(page.getByTestId('runtime-controls')).toHaveCount(0);
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();
  expect(server.commits()).toBe(1);
  expect(server.snapshots()).toBe(1);
  // A later explicit attempt can still start a world; the failed attempt must
  // not leave changing/recovery state locking the new session's controls.
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('refine-submit')).toBeEnabled();
  await expect(page.getByTestId('world-broken')).toHaveCount(0);
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
  expect(server.commits()).toBe(1);
});

test('confirmed timer change compares the same inputs and horizon and returns to the preserved original', async ({ page }) => {
  const server = await museum(page);
  await act(page, 'activate sensorA (visitor)');
  const start = Number((await page.getByTestId('runtime-input-result').innerText()).match(/tick (\d+)/)![1]);
  await act(page, 'Walk to approachB (visitor)');
  await expect.poll(async () => Number(await page.getByTestId('runtime-tick').getAttribute('data-tick')), { timeout: 20_000 }).toBeGreaterThan(start + 235);
  await act(page, 'activate sensorB (visitor)');
  await expect(page.getByTestId('runtime-value-e:case:locked')).toHaveText('case: unlocked');
  await page.getByTestId('runtime-pause').click();
  const originalTick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  // Include the actually observed completion. Slow automation can submit the
  // third input after start+300 even though the original timer is still valid.
  const horizon = Math.max(start + 300, Number(originalTick));
  await preview(page);
  await page.getByTestId('branch-observation-input').fill(String(horizon));
  expect(server.commits()).toBe(0);
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('branch-rule')).toContainText('start_countdown: 20s → 10s');
  await expect(page.getByTestId('branch-horizon')).toHaveText(`Observation tick ${horizon} · fork tick 0 · same 3 visitor inputs`);
  await expect(page.getByTestId('branch-value-e:case:locked').locator('td')).toHaveText(['unlocked', 'locked']);
  await expect(page.getByTestId('branch-value-f:alarm').locator('td')).toHaveText(['off', 'on']);
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: on');
  await expect(page.getByTestId('world-authored')).toContainText('authored ahead of time');
  await expect(page.getByText('Generated now', { exact: true })).toHaveCount(0);
  await page.getByTestId('branch-original').click();
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', String(horizon));
  await expect(page.getByTestId('runtime-value-e:case:locked')).toHaveText('case: unlocked');
  await expect(page.getByTestId('refine-submit')).toBeDisabled();
  await page.getByTestId('branch-changed').click();
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', String(horizon));
  await expect(page.getByTestId('refine-submit')).toBeDisabled();
  await page.getByTestId('branch-comparison').evaluate(element => {
    element.scrollTop = 0;
    element.parentElement!.scrollTop = 0;
  });
  await page.screenshot({ path: 'scratch/reality-compiler-branch.png' });
});

test('discard and server rejection never create a comparison', async ({ page }) => {
  const server = await museum(page, { refuse: true });
  await page.getByTestId('runtime-pause').click();
  const tick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  await preview(page);
  await page.getByTestId('change-discard').click();
  expect(server.commits()).toBe(0);
  await preview(page);
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-preview')).toContainText('Stale server revision');
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', tick!);
});

test('new visitor input invalidates the preview before sending commit', async ({ page }) => {
  const server = await museum(page);
  await preview(page);
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('change-preview')).toContainText('Visitor inputs changed');
  expect(server.commits()).toBe(0);
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
});

test('input during a pending accepted commit cannot silently change the comparison log', async ({ page }) => {
  const server = await museum(page, { hold: true });
  await preview(page);
  await page.getByTestId('change-apply').click();
  await expect.poll(server.commits).toBe(1);
  await act(page, 'activate sensorA (visitor)');
  server.release();
  await expect(page.getByTestId('branch-note')).toContainText('Change accepted. Comparison unavailable');
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
});
