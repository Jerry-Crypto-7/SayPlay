import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import surface from '../evals/reality-compiler/museum.sim.json';

async function museum(page: Page) {
  const blueprint = blueprintSchema.parse({
    version: 'worldstream-v1', sessionSeed: 4021, title: 'Museum interaction fixture',
    // The visitor starts at visual x4.5 for runtime cell1. Declare the full
    // ten-cell corridor, so a stable camera can frame its actual travel area.
    intent: EXAMPLE_PLAN.intent, geometry: {...EXAMPLE_BLUEPRINT_ANSWER.geometry,nodes:[...EXAMPLE_BLUEPRINT_ANSWER.geometry.nodes,
      {kind:'mass',variant:'block',at:[6,-0.2,5.5],scale:[5,0.2,3]},
      {kind:'repeat',child:9,count:2,step:[5,0,0]},
      {kind:'group',children:[8,10]}],root:11}, shapes: [],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0,
      sim: surface, look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'geom', node: 5 }, targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] } },
      {stableId:'corridorFloor',label:'the ten-cell fixture corridor',synonyms:[],role:'prop',importance:1,
        source:{kind:'geom',node:10},targetBounds:{min:[3.5,-0.3,4],max:[13.5,-0.1,7]}}],
  });
  const id = '22222222-3333-4444-5555-666666666666';
  await page.route('**/api/worldstream/sessions', route => {
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
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('Museum interaction fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
}

async function act(page: Page, label: string) {
  await page.getByTestId('runtime-action').selectOption({ label });
  await page.getByTestId('runtime-act').click();
}

// Only transport is scripted; movement, guards, timers and trace use the real engine on /.
test('remote sensor input cannot unlock; walking then activating produces unlock_case', async ({ page }) => {
  test.setTimeout(90_000);
  await museum(page);
  await act(page, 'activate sensorA (visitor)');
  await expect(page.getByTestId('runtime-input-result')).toContainText('start_countdown');
  await act(page, 'activate sensorB (visitor)');
  await expect(page.getByTestId('runtime-input-result')).toContainText('No rule applied');
  await expect(page.getByTestId('runtime-value-e:case:locked')).toHaveText('case: locked');
  await page.waitForFunction(() => window.__worldstreamStage?.slots().some(s => s.stableId === 'visitor'));
  const before = await page.evaluate(() => window.__worldstreamStage!.slots().find(s => s.stableId === 'visitor')!.transform.translation[0]);
  await act(page, 'Walk to approachB (visitor)');
  await expect(page.getByTestId('runtime-positions')).toContainText('visitor: (7, 1)');
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage!.slots().find(s => s.stableId === 'visitor')!.transform.translation[0]))
    .toBeCloseTo(before + 6);
  await expect.poll(() => page.evaluate(() => {
    const point = window.__worldstreamStage!.screen('visitor');
    return point !== null && point.x > 0 && point.x < innerWidth && point.y > 0 && point.y < innerHeight;
  })).toBe(true);
  await act(page, 'activate sensorB (visitor)');
  await expect(page.getByTestId('runtime-value-e:case:locked')).toHaveText('case: unlocked');
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: off');
  await expect(page.getByTestId('runtime-input-result')).toContainText('unlock_case');
  await page.getByText('Rule trace', { exact: true }).click();
  await expect(page.getByTestId('runtime-rule-trace')).toContainText('activate sensorB → No rule applied');
  await expect(page.getByTestId('runtime-rule-trace')).toContainText('unlock_case');
  await page.screenshot({ path: 'scratch/reality-compiler-interaction.png' });
});

test('timer expiration updates the alarm and exposes expire_countdown without a click', async ({ page }) => {
  test.setTimeout(60_000);
  await museum(page);
  await act(page, 'activate sensorA (visitor)');
  await expect(page.getByTestId('runtime-value-f:alarm')).toHaveText('alarm: on', { timeout: 35_000 });
  await expect(page.getByTestId('runtime-value-e:case:locked')).toHaveText('case: locked');
  await page.getByText('Rule trace', { exact: true }).click();
  await expect(page.getByTestId('runtime-rule-trace')).toContainText('expire_countdown');
});
