import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import { commitPart } from '../src/ir/revision';
import surface from '../evals/reality-compiler/museum.sim.json';

// Software WebGL builds the fixture before the interaction assertions begin.
test.setTimeout(90_000);

// Scripted model/transport; the accepted document uses the real patch gate.
// Runtime, visitor input, comparison and rendering execute unchanged on /.
async function museum(page: Page, options: { refuse?: boolean; hold?: boolean } = {}) {
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
  const id = '22222222-3333-4444-5555-666666666666';
  let commits = 0;
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/worldstream/sessions', route => {
    if (route.request().postDataJSON()?.live === true) return route.fulfill({ status: 503, body: '{}' });
    return route.fulfill({ status: 202, json: { sessionId: id, events: `/api/worldstream/sessions/${id}/events`,
      snapshot: `/api/worldstream/sessions/${id}`, authored: { match: 'exact' } } });
  });
  await page.route(`**/api/worldstream/sessions/${id}/events*`, route => {
    const frame = (sequence: number, type: string, payload: unknown) =>
      `data: ${JSON.stringify({ sessionId: id, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {}) });
  });
  await page.route(`**/api/worldstream/sessions/${id}/changes`, route => {
    expect(route.request().postDataJSON().prompt).toBe('Shorten the sensor countdown from 20 seconds to 10 seconds.');
    return route.fulfill({ json: { changeId: 'timer-change', summary: 'Shorten the sensor countdown to 10 seconds.',
      target: { stableId: 'visitor', label: 'sensor countdown' }, scope: { shape: false, behavior: 1, appearance: 0 },
      preserved: ['visitor', 'case', 'alarm'], authored: { match: 'exact' } } });
  });
  await page.route(`**/api/worldstream/sessions/${id}/changes/timer-change/commit`, async route => {
    commits++;
    if (options.hold) await held;
    if (options.refuse) return route.fulfill({ json: { outcome: 'REJECTED', rejections: [{ detail: 'Stale server revision.' }] } });
    const result = commitPart(blueprint.world, { part: 'sim', baseRevision: 0,
      operations: [{ op: 'replace', path: '/rules/start_countdown/actions/1/durationTicks', value: 200 }] });
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') throw new Error('fixture patch rejected');
    blueprint = { ...blueprint, world: result.doc };
    return route.fulfill({ json: { outcome: 'COMMITTED', stableId: 'visitor', summary: 'Shortened countdown' } });
  });
  await page.route(`**/api/worldstream/sessions/${id}`, route => route.fulfill({ json: { blueprint } }));
  await page.goto('/');
  await page.getByTestId('prompt-input').fill('Museum branch fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  return { commits: () => commits, release };
}

async function act(page: Page, label: string) {
  await page.getByTestId('runtime-action').selectOption({ label });
  await page.getByTestId('runtime-act').click();
}
async function preview(page: Page) {
  await page.getByTestId('refine-input').fill('Shorten the sensor countdown from 20 seconds to 10 seconds.');
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
}

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
  await preview(page);
  await page.getByTestId('branch-observation-input').fill(String(start + 300));
  expect(server.commits()).toBe(0);
  await expect(page.getByTestId('branch-comparison')).toHaveCount(0);
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('branch-rule')).toContainText('start_countdown: 20s → 10s');
  await expect(page.getByTestId('branch-horizon')).toHaveText(`Observation tick ${start + 300} · fork tick 0 · same 3 visitor inputs`);
  await expect(page.getByTestId('branch-value-e:case:locked').locator('td')).toHaveText(['unlocked', 'locked']);
  await expect(page.getByTestId('branch-value-f:alarm').locator('td')).toHaveText(['off', 'on']);
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: on');
  await expect(page.getByTestId('world-authored')).toContainText('authored ahead of time');
  await expect(page.getByText('Generated now', { exact: true })).toHaveCount(0);
  await page.getByTestId('branch-original').click();
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', originalTick!);
  await expect(page.getByTestId('runtime-value-e:case:locked')).toHaveText('case: unlocked');
  await expect(page.getByTestId('refine-submit')).toBeDisabled();
  await page.getByTestId('branch-changed').click();
  await expect(page.getByTestId('runtime-tick')).toHaveAttribute('data-tick', String(start + 300));
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
