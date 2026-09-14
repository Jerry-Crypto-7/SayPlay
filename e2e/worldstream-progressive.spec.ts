import { expect, test, type Page } from '@playwright/test';
import { openInspect } from './inspect';

async function holdFutureMeshes(page: Page) {
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    let released = false;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      if (released) send.call(this, message, Array.isArray(transfer) ? { transfer } : transfer);
    };
    window.addEventListener('resume-test-mesh', () => { released = true; });
  });
  await page.route('**/api/worldstream/sessions', route => route.request().postDataJSON()?.live
    ? route.fulfill({ status: 503, json: {} }) : route.fallback());
}

test('keyboard users can stop pending detail and complete another world in a narrow viewport', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await holdFutureMeshes(page);
  await page.goto('/');
  const status = page.getByTestId('world-status');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status).toHaveAttribute('aria-atomic', 'true');
  const originalStatus = await status.elementHandle();
  expect(originalStatus).not.toBeNull();

  // Real sequential navigation: no pointer clicks or programmatic focus.
  async function tabTo(testId: string) {
    const target = page.getByTestId(testId);
    for (let count = 0; count < 40; count++) {
      if (await target.evaluate(node => node === document.activeElement)) break;
      await page.keyboard.press('Tab');
    }
    await expect(target).toBeFocused();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  }

  await tabTo('prompt-input');
  await page.keyboard.type('A cathedral of stacked shipping containers around a light well.');
  await page.keyboard.press('Enter');
  await expect(status).toContainText('validated scene is ready', { timeout: 30_000 });
  await page.waitForFunction(() => window.__worldstreamStage?.ready());
  const objects = await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })));
  expect(objects.length).toBeGreaterThan(0);
  await tabTo('world-cancel');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('world-cancelled')).toHaveAttribute('role', 'status');
  await expect(page.getByTestId('world-cancelled')).toContainText('Stopped waiting');
  await expect(page.getByTestId('world-cancel')).toHaveCount(0);
  expect(await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })))).toEqual(objects);
  expect(await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.outcome)).toBe('cancelled');

  await page.evaluate(() => window.dispatchEvent(new Event('resume-test-mesh')));
  await tabTo('prompt-input');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('A bridge town: houses hanging under a single span over a dry canyon.');
  await page.keyboard.press('Enter');
  await expect(status).toHaveAttribute('data-state', 'live', { timeout: 45_000 });
  await expect(status).toHaveAttribute('role', 'status');
  expect(await originalStatus!.evaluate(node => node === document.querySelector('[data-testid="world-status"]'))).toBe(true);
  await expect(page.getByTestId('world-authored')).toBeVisible();
  await expect(page.getByTestId('prompt-input')).toBeFocused();
  await originalStatus!.dispose();
});

test('validated scene runs before worker detail and keeps the same objects when detail arrives', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    const pending: (() => void)[] = [];
    let released = false;
    Worker.prototype.postMessage = function(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
      const worker = this;
      const dispatch = () => send.call(worker, message, Array.isArray(transfer) ? { transfer } : transfer);
      if (released) dispatch(); else pending.push(dispatch);
    };
    window.addEventListener('release-test-mesh', () => { released = true; pending.splice(0).forEach(dispatch => dispatch()); });
  });
  await page.route('**/api/worldstream/sessions', route => route.request().postDataJSON()?.live
    ? route.fulfill({ status: 503, json: {} }) : route.fallback());
  await page.goto('/');
  await page.getByTestId('prompt-input').fill('A cathedral of stacked shipping containers around a light well.');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toContainText('validated scene is ready', { timeout: 30_000 });
  await expect(page.getByTestId('runtime-pause')).toBeEnabled();
  await page.waitForFunction(() => window.__worldstreamStage?.ready());
  const before = await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })));
  expect(before.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.stages
    .find(stage => stage.name === 'first-frame')?.outcome)).toBe('completed');
  const pendingMesh = await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.stages.find(stage => stage.name === 'mesh'));
  expect(pendingMesh).toMatchObject({ outcome: 'pending', elapsedMs: null });
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-mesh')));
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', { timeout: 45_000 });
  expect(await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })))).toEqual(before);
  await expect(page.getByTestId('world-authored')).toBeVisible();
  expect(await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.stages.find(stage => stage.name === 'mesh')?.outcome)).toBe('completed');
});

test('stopping detail preserves a static scene and a subsequent authored shape edit renders', async ({ page }) => {
  test.setTimeout(90_000);
  await holdFutureMeshes(page);
  await page.goto('/');
  await page.getByTestId('prompt-input').fill('A bridge town: houses hanging under a single span over a dry canyon.');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toContainText('validated scene is ready', { timeout: 30_000 });
  await page.waitForFunction(() => window.__worldstreamStage?.ready());
  const before = await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })));
  await page.getByTestId('world-cancel').click();
  await expect(page.getByTestId('world-cancelled')).toContainText('Stopped waiting');
  expect(await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.outcome)).toBe('cancelled');
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();
  expect(await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })))).toEqual(before);
  // This fixture's runtime has ended; it cannot exercise pausing a running
  // visitor. Its historical sway declaration is explicitly excluded at preview.
  await expect(page.getByTestId('runtime-pause')).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('resume-test-mesh')));
  await openInspect(page);
  await page.getByTestId('refine-input').fill('Make the hanging houses bigger and let them sway.');
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-apply')).toBeVisible();
  await expect(page.getByTestId('change-summary')).toContainText('Only the shape');
  await expect(page.getByTestId('change-summary')).toContainText('Behavior stays unchanged');
  const previousShape = await page.evaluate(() => window.__worldstreamStage!.slots()
    .find(slot => slot.stableId === 'hangingHouses')!.representationId);
  const commitResponse = page.waitForResponse(response => response.url().endsWith('/commit'));
  await page.getByTestId('change-apply').click();
  const committed = await commitResponse;
  expect(committed.ok()).toBe(true);
  const result = await committed.json();
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'COMMITTED', stableId: 'hangingHouses' });
  expect(result.representation).not.toBeNull();
  expect(result.representation).toBeDefined();
  await expect(page.getByTestId('change-preview')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage!.slots()
    .find(slot => slot.stableId === 'hangingHouses')!.representationId), { timeout: 30_000 }).not.toBe(previousShape);
  const changedShape = await page.evaluate(() => window.__worldstreamStage!.slots().find(slot => slot.stableId === 'hangingHouses')!);
  expect(changedShape.representationId).not.toBeNull();
  expect(changedShape.rung).not.toBe('semantic-clay');
  expect(changedShape.failure).toBeNull();
  expect(changedShape.triangles).toBeGreaterThan(0);
  await expect(page.getByTestId('change-recovery')).toHaveCount(0);
  await expect(page.getByTestId('runtime-pause')).toBeDisabled();
});

test('stopping pending detail preserves a paused runtime input and actual object identities', async ({ page }) => {
  test.setTimeout(90_000);
  await holdFutureMeshes(page);
  await page.goto('/');
  await page.getByTestId('prompt-input').fill('A cathedral of stacked shipping containers around a light well.');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('world-status')).toContainText('validated scene is ready', { timeout: 30_000 });
  await page.waitForFunction(() => window.__worldstreamStage?.ready());
  await expect(page.getByTestId('runtime-act')).toBeEnabled();
  await page.getByTestId('runtime-act').click();
  await expect(page.getByTestId('runtime-input-result')).toContainText('Input at tick');
  await page.getByTestId('runtime-pause').click();
  await expect(page.getByTestId('runtime-pause')).toHaveText('Resume');
  const tick = await page.getByTestId('runtime-tick').getAttribute('data-tick');
  const input = await page.getByTestId('runtime-input-result').innerText();
  const identities = await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })));
  expect(identities.length).toBeGreaterThan(0);
  expect(identities.every(slot => slot.object !== null)).toBe(true);
  await page.getByTestId('world-cancel').click();
  await expect(page.getByTestId('world-cancelled')).toContainText('Stopped waiting');
  expect(await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.outcome)).toBe('cancelled');
  await page.evaluate(() => window.dispatchEvent(new Event('resume-test-mesh')));
  const frame = await page.evaluate(() => window.__worldstreamStage!.frames());
  await page.waitForFunction(previous => window.__worldstreamStage!.frames() > previous + 3, frame);
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', tick!);
  await expect(page.getByTestId('runtime-input-result')).toHaveText(input);
  await expect(page.getByTestId('runtime-pause')).toHaveText('Resume');
  await expect(page.getByTestId('runtime-pause')).toBeEnabled();
  expect(await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => ({ id: slot.stableId, object: slot.objectId })))).toEqual(identities);
});
