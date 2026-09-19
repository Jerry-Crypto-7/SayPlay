import { expect, test, type Page } from '@playwright/test';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import { commitPart } from '../src/ir/revision';
import surface from '../evals/reality-compiler/museum.sim.json';

/**
 * Oracle úlohy P22 T10 — **přijaté alternativy zůstávají a dá se mezi nimi vybírat**.
 *
 * Do T10 stránka držela jedinou `comparison`; druhá přijatá změna tu první
 * přepsala a porotce ji už nikdy neviděl. Teď se každá přijatá změna zapíše
 * do seznamu „Futures" a klik na položku postaví její svět vedle originálu —
 * **bez nového volání modelu** (dvojník počítá volání `/changes` a `/commit`).
 *
 * Neviditelná vada, kterou test pinuje: seznam, ve kterém přepnutí nechá starý
 * runtime na plátně, ukáže správnou větu a špatný svět. Proto se měří hash
 * stavu, který pravý pohled doopravdy vykresluje, ne text položky.
 *
 * Dvojník je zkrácená kopie `museum()` z `reality-compiler-branch.spec.ts`:
 * scriptovaný je model a transport, brána patche, runtime, porovnání
 * i vykreslení běží doopravdy.
 */

test.setTimeout(120_000);

const FIRST = 'The first sensor activates the alarm.';
const SECOND = 'Shorten the sensor countdown from 20 seconds to 10 seconds.';

async function museum(page: Page) {
  const sim = structuredClone(surface);
  Object.entries(sim.rules).forEach(([id, rule]) => Object.assign(rule, { id }));
  let blueprint = blueprintSchema.parse({
    version: 'worldstream-v1', sessionSeed: 4021, title: 'Museum future list fixture',
    intent: EXAMPLE_PLAN.intent, geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry, shapes: [],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0,
      sim, look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'geom', node: 5 }, targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] } }],
  });
  const id = '22222222-3333-4444-5555-777777777777';
  const original = structuredClone(blueprint);
  const changes: string[] = [];
  let commits = 0;
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
    const prompt = route.request().postDataJSON().prompt as string;
    changes.push(prompt);
    const changeId = `change-${changes.length}`;
    return route.fulfill({ json: { changeId, summary: prompt,
      target: { stableId: 'visitor', label: 'sensor countdown' }, scope: { shape: false, behavior: 1, appearance: 0 },
      preserved: ['visitor', 'case', 'alarm'], authored: { match: 'exact' } } });
  });
  await page.route(`**/api/worldstream/sessions/${id}/changes/*/commit`, route => {
    commits++;
    const prompt = changes[commits - 1];
    const result = commitPart(blueprint.world, { part: 'sim', baseRevision: blueprint.world.simRevision,
      operations: prompt === FIRST
        ? [{ op: 'replace', path: '/rules/start_countdown/actions/0', value: { kind: 'setFlag', ref: 'alarm', value: true } }]
        : [{ op: 'replace', path: '/rules/start_countdown/actions/1/durationTicks', value: 200 }] });
    if (result.verdict !== 'COMMITTED') throw new Error('fixture patch rejected');
    blueprint = { ...blueprint, world: result.doc };
    return route.fulfill({ json: { outcome: 'COMMITTED', stableId: 'visitor', summary: prompt,
      revisions: { sim: { before: result.doc.simRevision - 1, after: result.doc.simRevision },
        look: { before: blueprint.world.lookRevision, after: blueprint.world.lookRevision } } } });
  });
  await page.route(`**/api/worldstream/sessions/${id}/comparison/restore`, route => {
    blueprint = { ...blueprint, world: sealSimHash({ ...blueprint.world, sim: original.world.sim, simRevision: blueprint.world.simRevision + 1 }) };
    return route.fulfill({ json: { outcome: 'RESTORED', acceptedBlueprint: blueprint } });
  });
  await page.route(`**/api/worldstream/sessions/${id}`, route => route.fulfill({ json: { blueprint: structuredClone(blueprint) } }));
  await page.goto('/');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('Museum future list fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  return { changes: () => changes.length, commits: () => commits };
}

async function acceptChange(page: Page, prompt: string, observationTick: number) {
  await page.getByTestId('refine-input').fill(prompt);
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
  await page.getByText('Exact simulation times', { exact: true }).click();
  await page.getByTestId('branch-observation-input').fill(String(observationTick));
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('future-views')).toBeVisible();
}

test('two accepted changes stay listed and the picked one stands next to the original', async ({ page }) => {
  const server = await museum(page);
  await page.getByTestId('runtime-action').selectOption({ label: 'activate sensorA (visitor)' });
  await page.getByTestId('runtime-act').click();
  await page.getByTestId('runtime-pause').click();
  const start = Number((await page.getByTestId('runtime-input-result').innerText()).match(/tick (\d+)/)![1]);
  await page.getByTestId('rewind-before-action').click();

  const items = page.getByTestId('future-list').locator('[data-testid^="future-item-"]');
  const changed = page.getByTestId('future-changed');
  const originalView = page.getByTestId('future-original');

  await acceptChange(page, FIRST, start + 300);
  await expect(items).toHaveCount(1);
  await expect(page.getByTestId('future-item-1')).toContainText(FIRST);
  await expect(page.getByTestId('future-item-1')).toHaveAttribute('aria-pressed', 'true');
  const firstHash = await changed.getAttribute('data-hash');
  expect(firstHash).not.toBe('');

  // Cesta k druhé změně: vrátit původní pravidla, věta, přijmout. Seznam
  // přitom první budoucnost nesmí ztratit.
  await page.getByTestId('branch-restart').click();
  await expect(page.getByTestId('future-views')).toHaveCount(0);
  await expect(page.getByTestId('refine-submit')).toBeEnabled();
  await acceptChange(page, SECOND, start + 300);
  await expect(items).toHaveCount(2);
  await expect(page.getByTestId('future-item-2')).toContainText(SECOND);
  await expect(page.getByTestId('future-item-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('future-item-1')).toHaveAttribute('aria-pressed', 'false');
  const secondHash = await changed.getAttribute('data-hash');
  expect(secondHash).not.toBe(firstHash);
  const originalHash = await originalView.getAttribute('data-hash');
  expect(originalHash).not.toBe(secondHash);
  expect(server.changes()).toBe(2);
  expect(server.commits()).toBe(2);

  // Přepnutí: pravý pohled ukáže první budoucnost, levý zůstane originál, čas
  // obou pohledů sedí, a model se nevolá.
  await page.getByTestId('future-item-1').click();
  await expect(page.getByTestId('future-item-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(changed).toHaveAttribute('data-hash', firstHash!);
  await expect(originalView).toHaveAttribute('data-hash', originalHash!);
  await expect(page.getByTestId('branch-rule')).toContainText('action changed');
  await expect(changed).toHaveAttribute('data-tick', (await originalView.getAttribute('data-tick'))!);
  expect(server.changes()).toBe(2);
  expect(server.commits()).toBe(2);

  // Tažení po společné ose pohne oběma stranami na tentýž tik.
  const slider = page.getByTestId('future-time');
  const min = Number(await slider.getAttribute('min'));
  const seek = Math.min(start + 100, start + 300);
  await slider.fill(String(Math.max(min, seek)));
  await expect(changed).toHaveAttribute('data-tick', String(Math.max(min, seek)));
  await expect(originalView).toHaveAttribute('data-tick', String(Math.max(min, seek)));

  // A zpátky na druhou: tentýž hash jako při přijetí, ne přepočítaná náhoda.
  await page.getByTestId('future-item-2').click();
  await slider.fill(String(start + 300));
  await expect(changed).toHaveAttribute('data-hash', secondHash!);
  await expect(page.getByTestId('branch-rule')).toContainText('20s → 10s');
  await expect(changed).toHaveAttribute('data-tick', (await originalView.getAttribute('data-tick'))!);
});
