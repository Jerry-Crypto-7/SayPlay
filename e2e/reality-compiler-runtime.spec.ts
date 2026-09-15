import { expect, test } from '@playwright/test';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import surface from '../evals/reality-compiler/museum.sim.json';
import { openInspect } from './inspect';

// Skutečná hlavní URL a autorovaný svět; žádná placená inference.
test('unsupported appearance is refused by the actual server while preserving runtime and camera', async ({ page }) => {
  test.setTimeout(180_000);
  await page.route('**/api/worldstream/sessions', async route => {
    if (route.request().postDataJSON()?.live === true) {
      return route.fulfill({ status: 503, contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'LIVE_UNAVAILABLE', message: 'disabled for this test' } }) });
    }
    return route.fallback();
  });
  await page.goto('/');
  await page.getByTestId('prompt-input').fill('A cathedral of stacked shipping containers around a light well.');
  const opened = page.waitForResponse(response => response.url().endsWith('/api/worldstream/sessions') && response.request().method() === 'POST');
  const liveRefused = page.waitForResponse(response => response.url().endsWith('/api/worldstream/sessions')
    && response.request().postDataJSON()?.live === true);
  await page.getByTestId('prompt-submit').click();
  const sessionId = (await (await opened).json()).sessionId as string;
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', { timeout: 90_000 });
  const tick = page.getByTestId('runtime-tick');
  await expect.poll(async () => Number(await tick.getAttribute('data-tick'))).toBeGreaterThan(5);
  // Odmítnuté dveře nic neslíbily, takže hláška o nedoručeném dějství II lhát nesmí.
  expect((await liveRefused).status()).toBe(503);
  await expect(page.getByTestId('second-act-missed')).toHaveCount(0);
  await page.getByTestId('runtime-pause').click();
  await expect(page.getByTestId('runtime-pause')).toHaveText('Resume');
  const paused = await tick.getAttribute('data-tick');
  const canvas = await page.getByTestId('worldstream-canvas').elementHandle();
  const builds = await page.evaluate(() => window.__worldstreamStage?.builds());
  const identities = await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })));
  const sceneCanvas = page.getByTestId('worldstream-canvas').locator('canvas');
  await sceneCanvas.focus();
  await page.keyboard.press('ArrowLeft');
  const camera = await page.evaluate(() => window.__worldstreamStage!.camera());
  await openInspect(page);
  const beforeDocument = (await (await page.request.get(`/api/worldstream/sessions/${sessionId}`)).json()).blueprint;
  await page.getByTestId('refine-input').fill('Paint the containers rust red.');
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-refusal')).toContainText('not supported in this renderer', { timeout: 30_000 });
  await expect(page.getByTestId('change-apply')).toHaveCount(0);
  expect((await (await page.request.get(`/api/worldstream/sessions/${sessionId}`)).json()).blueprint).toEqual(beforeDocument);
  expect(await tick.getAttribute('data-tick')).toBe(paused);
  await expect(page.getByTestId('runtime-pause')).toHaveText('Resume');
  expect(await canvas!.evaluate(node => node.isConnected)).toBe(true);
  const afterLook = await page.evaluate(() => window.__worldstreamStage?.builds());
  expect(afterLook).toBe(builds);
  expect(await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })))).toEqual(identities);
  expect(await page.evaluate(() => window.__worldstreamStage!.camera())).toEqual(camera);
  await page.getByTestId('runtime-pause').click();
  await expect.poll(async () => Number(await tick.getAttribute('data-tick'))).toBeGreaterThan(Number(paused) + 3);
  expect(await page.evaluate(() => window.__worldstreamStage?.builds())).toBe(afterLook);
  await page.screenshot({ path: 'scratch/reality-compiler-runtime.png' });
});

// Scriptovaný je transport fixture, nikoli controller ani renderer.
test('a runtime timer moves the actual rendered slot without rebuilding the scene', async ({ page }) => {
  test.setTimeout(90_000);
  const sim = structuredClone(surface);
  sim.state.timers.countdown.initial = 100;
  const blueprint = blueprintSchema.parse({
    version: 'worldstream-v1', sessionSeed: 4021, title: 'Runtime movement fixture',
    intent: EXAMPLE_PLAN.intent, geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry, shapes: [],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0,
      sim: { ...sim, rules: { move_after_timer: { event: { kind: 'onTimerEnd', timer: 'countdown' },
        actions: [{ kind: 'moveTo', target: 'visitor', socket: 'sensorB', ticks: 1 }] } } },
      look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'geom', node: 5 }, targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] } }],
  });
  const id = '22222222-3333-4444-5555-666666666666';
  await page.route('**/api/worldstream/sessions', async route => {
    if (route.request().postDataJSON()?.live === true) return route.fulfill({ status: 503, body: '{}' });
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ sessionId: id,
      events: `/api/worldstream/sessions/${id}/events`, snapshot: `/api/worldstream/sessions/${id}`,
      authored: { match: 'exact' } }) });
  });
  await page.route(`**/api/worldstream/sessions/${id}/events*`, route => {
    const frame = (sequence: number, type: string, payload: unknown) =>
      `data: ${JSON.stringify({ sessionId: id, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {}) });
  });
  await page.goto('/');
  await page.getByTestId('prompt-input').fill('Runtime movement fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-tick')).toBeVisible();
  await page.getByTestId('runtime-pause').click();
  await page.waitForFunction(() => window.__worldstreamStage?.slots().some(s => s.stableId === 'visitor'));
  const before = await page.evaluate(() => ({
    tick: Number(document.querySelector('[data-testid="runtime-tick"]')?.getAttribute('data-tick')),
    slot: window.__worldstreamStage!.slots().find(s => s.stableId === 'visitor')!,
    builds: window.__worldstreamStage!.builds(),
  }));
  expect(before.tick).toBeLessThan(100);
  await page.getByTestId('runtime-pause').click();
  await expect.poll(async () => Number(await page.getByTestId('runtime-tick').getAttribute('data-tick')),
    { timeout: 20_000 }).toBeGreaterThan(109);
  await page.getByTestId('runtime-pause').click();
  const after = await page.evaluate(() => ({
    slot: window.__worldstreamStage!.slots().find(s => s.stableId === 'visitor')!,
    builds: window.__worldstreamStage!.builds(),
  }));
  expect(after.slot.transform.translation[0] - before.slot.transform.translation[0]).toBeCloseTo(7);
  expect(after.slot.transform.translation[2]).toBe(before.slot.transform.translation[2]);
  expect(after.slot.groups).toBe(1);
  expect(after.builds).toBe(before.builds);
});
