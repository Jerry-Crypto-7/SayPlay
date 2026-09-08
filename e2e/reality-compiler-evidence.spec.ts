import { expect, test, type Page } from '@playwright/test';
import sim from '../evals/reality-compiler/museum.sim.json';
import { createSourceSnapshot, sealEvidenceDraft, EVIDENCE_VERSION } from '../src/worldstream/evidence';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { sealSimHash } from '../src/ir/worlddoc';

const text = '\ufeffČasovač běží 20 sekund.\r\n';
test.setTimeout(60_000);
async function proposal(input: { title: string; text: string; origin: string; rights: string }) {
  const source = await createSourceSnapshot({ ...input, sourceId: 'source', mediaType: 'text/plain' });
  if (!source.ok) throw new Error('source fixture');
  const evidence = await sealEvidenceDraft({ schemaVersion: EVIDENCE_VERSION, worldRevision: 'fixture-proposal',
    parentEvidenceHash: null, sources: [{ sourceId: 'source', sha256: source.value.sha256 }],
    claims: [{ claimId: 'duration', text: 'The timer lasts 20 seconds.', support: 'sourced', review: { status: 'unchecked' },
      interventionId: null, spans: [{ sourceId: 'source', startByte: 0, endByte: Buffer.byteLength(input.text), excerpt: input.text }] }],
    bindings: Object.keys(sim.rules).map(id => ({ bindingId: `binding.${id}`, target: { kind: 'rule', id }, claimIds: ['duration'] })),
    interventions: [],
  }, { worldRevision: 'fixture-proposal', parent: null, sources: new Map([['source', source.value]]),
    ruleIds: new Set(Object.keys(sim.rules)), entityIds: new Set(Object.keys(sim.entities)) });
  if (!evidence.ok) throw new Error(evidence.issues.join(','));
  return { kind: 'proposed', generation: 'fixture', sim, source: source.value, evidence: evidence.value };
}
async function source(page: Page) {
  await page.route('**/api/worldstream/source', async route => route.fulfill({ json: await proposal(route.request().postDataJSON()) }));
  await page.goto('/');
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByTestId('source-input').fill(text);
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-status')).toContainText('Source accepted', { timeout: 30_000 });
}
async function act(page: Page, label: string) {
  await page.getByTestId('runtime-action').selectOption({ label });
  await page.getByTestId('runtime-act').click();
}
async function why(page: Page, rule: string) {
  const panel = page.getByTestId('source-panel');
  const summary = panel.getByText('Why?', { exact: true });
  if (!(await page.getByTestId('why-rule').isVisible())) await summary.click();
  const value = await page.getByTestId('why-rule').locator('option').evaluateAll((options, target) =>
    (options.find(option => option.textContent?.endsWith(`: ${target}`)) as HTMLOptionElement)?.value, rule);
  expect(value).toBeTruthy();
  await page.getByTestId('why-rule').selectOption(value!);
}
async function ordinaryTransport(page: Page) {
  const id = '33333333-3333-4444-5555-666666666666';
  const blueprint = { version: 'worldstream-v1', sessionSeed: 4021, title: 'Ordinary prompt world',
    intent: EXAMPLE_PLAN.intent, geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry, shapes: [],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0, sim, look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'geom', node: 5 }, targetBounds: { min: [1, 0, 1], max: [2, 1, 2] } }] };
  await page.route('**/api/worldstream/sessions', route => route.request().postDataJSON().live
    ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ status: 202, json: { sessionId: id,
      events: `/api/worldstream/sessions/${id}/events`, snapshot: `/api/worldstream/sessions/${id}`, authored: { match: 'exact' } } }));
  await page.route(`**/api/worldstream/sessions/${id}/events*`, route => route.fulfill({ contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({ sessionId: id, sequence: 1, type: 'blueprint.ready', at: '1970-01-01T00:00:00.000Z', payload: { blueprint } })}\n\n` }));
}

test('own source creates a real running scene and Why resolves only fired rules and exact evidence', async ({ page }) => {
  await source(page);
  await expect(page.getByTestId('source-provenance')).toContainText('Scripted test fixture');
  await page.getByText('Why?', { exact: true }).click();
  await expect(page.getByTestId('source-panel')).toContainText('No rule has fired');
  await act(page, 'activate sensorB (visitor)');
  await expect(page.getByTestId('runtime-input-result')).toContainText('No rule applied');
  await expect(page.getByTestId('why-explanation')).toHaveCount(0);
  await act(page, 'activate sensorA (visitor)');
  await why(page, 'start_countdown');
  await expect(page.getByTestId('why-explanation')).toContainText('Runtime trace: start_countdown fired');
  await expect(page.getByTestId('claim-axes')).toContainText('sourced');
  await expect(page.getByTestId('claim-axes')).toContainText('original');
  await expect(page.getByTestId('claim-axes')).toContainText('unchecked');
  await expect(page.getByTestId('why-explanation').locator('q')).toHaveText(text);
  await expect(page.getByTestId('runtime-positions')).toContainText('visitor: (1, 1)');
  await page.screenshot({ path: 'scratch/reality-compiler-evidence.png' });
});

test('clarification and invalid evidence keep the accepted source and runtime usable', async ({ page }) => {
  await source(page);
  await page.getByText('Build from a source', { exact: true }).click();
  await page.route('**/api/worldstream/source', route => route.fulfill({ json: { kind: 'needsClarification',
    questions: ['What happens when time expires?'], conflicts: ['Two different durations.'], unsupported: ['Teleportation.'] } }));
  await page.getByTestId('source-input').fill('Ambiguous procedure');
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-questions')).toContainText('What happens when time expires?');
  await expect(page.getByTestId('source-questions')).toContainText('Conflict: Two different durations.');
  await expect(page.getByTestId('runtime-act')).toBeEnabled();
  await page.route('**/api/worldstream/source', async route => {
    const result = structuredClone(await proposal(route.request().postDataJSON())); result.evidence.evidenceHash = '0'.repeat(64);
    return route.fulfill({ json: result });
  });
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-status')).toContainText('EVIDENCE_HASH_MISMATCH');
  await page.getByText('Original source', { exact: true }).click();
  await expect(page.getByTestId('source-bytes')).toHaveText(text);
  await page.route('**/api/worldstream/source', async route => route.fulfill({
    json: await proposal({ ...route.request().postDataJSON(), text: 'A different source.' }),
  }));
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-status')).toContainText('does not match your input');
  await expect(page.getByTestId('source-bytes')).toHaveText(text);
});

test('changed branch explains an assumption and returning to origin restores the original citation', async ({ page }) => {
  await source(page);
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  await page.getByText('Experiment with a future timer', { exact: true }).click();
  await page.getByLabel('Reason for intervention').fill('Test a shorter visitor window.');
  await page.getByRole('button', { name: 'Confirm timer experiment' }).click();
  await expect(page.getByTestId('source-status')).toContainText('Intervention accepted');
  await why(page, 'start_countdown');
  await expect(page.getByTestId('evidence-revision')).toContainText('branch-1');
  await expect(page.getByTestId('claim-axes')).toContainText('assumed');
  await expect(page.getByTestId('claim-axes')).toContainText('changed');
  await expect(page.getByTestId('why-explanation').locator('q')).toHaveCount(0);
  await expect(page.getByTestId('why-explanation')).toContainText('400 → 200');
  await page.getByRole('button', { name: 'Show original source branch' }).click();
  await why(page, 'start_countdown');
  await expect(page.getByTestId('evidence-revision')).toContainText('origin');
  await expect(page.getByTestId('claim-axes')).toContainText('sourced');
  await expect(page.getByTestId('why-explanation').locator('q')).toHaveText(text);
});

test('keyboard source input enforces size and ordinary prompts never inherit source citations', async ({ page }) => {
  await ordinaryTransport(page);
  await page.goto('/');
  await page.getByText('Build from a source', { exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('source-input')).toBeVisible();
  await page.getByTestId('source-input').fill('x'.repeat(4001));
  await expect(page.getByTestId('source-submit')).toBeDisabled();
  await page.getByTestId('prompt-input').fill('An ordinary museum');
  await page.getByTestId('prompt-input').press('Enter');
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('source-provenance')).toHaveCount(0);
  await page.getByTestId('inspect-toggle').click();
  await expect(page.getByTestId('no-source-evidence')).toContainText('A prompt alone is not a citation');
});

test('a late source response cannot replace a newer ordinary world', async ({ page }) => {
  await ordinaryTransport(page);
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/worldstream/source', async route => {
    const response = await proposal(route.request().postDataJSON()); await held;
    await route.fulfill({ json: response }).catch(() => {});
  });
  await page.goto('/');
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByTestId('source-input').fill(text);
  const sent = page.waitForRequest('**/api/worldstream/source');
  await page.getByTestId('source-submit').click(); await sent;
  await page.getByTestId('prompt-input').fill('A different world');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  release();
  await expect(page.getByTestId('source-provenance')).toHaveCount(0);
  await expect(page.getByTestId('source-submit')).toBeEnabled();
});
