import { expect, test, type Page } from '@playwright/test';
import sim from '../evals/reality-compiler/museum.sim.json';
import { createSourceSnapshot, sealEvidenceDraft, EVIDENCE_VERSION } from '../src/worldstream/evidence';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { sealSimHash } from '../src/ir/worlddoc';
import { proposeSourceScenario } from '../src/model/source-scenario';
import { serverGrammar } from '../src/worldstream/sessions';
import { ruleSupportParts } from '../src/worldstream/rule-support';

const text = '\ufeffČasovač běží 20 sekund.\r\n';
test.setTimeout(60_000);
/** Scripted UI acknowledgement only; this fixture is NOT semantic evidence. */
async function confirmFixtureParameters(page: Page) {
  for (const key of ['trigger', 'initial', 'proximity', 'duration', 'expiration', 'reset', 'ordering'])
    await page.getByTestId(`parameter-${key}`).selectOption('supported');
  await page.getByTestId('source-confirm').click();
}
async function proposal(input: { title: string; text: string; origin: string; rights: string }, simulation = sim) {
  const source = await createSourceSnapshot({ ...input, sourceId: 'source', mediaType: 'text/plain' });
  if (!source.ok) throw new Error('source fixture');
  const evidence = await sealEvidenceDraft({ schemaVersion: EVIDENCE_VERSION, worldRevision: 'fixture-proposal',
    parentEvidenceHash: null, sources: [{ sourceId: 'source', sha256: source.value.sha256 }],
    claims: [{ claimId: 'duration', text: 'The timer lasts 20 seconds.', support: 'sourced', review: { status: 'unchecked' },
      interventionId: null, spans: [{ sourceId: 'source', startByte: 0, endByte: Buffer.byteLength(input.text), excerpt: input.text }] }],
    bindings: Object.keys(simulation.rules).map(id => ({ bindingId: `binding.${id}`, target: { kind: 'rule', id }, claimIds: ['duration'] })),
    interventions: [],
  }, { worldRevision: 'fixture-proposal', parent: null, sources: new Map([['source', source.value]]),
    ruleIds: new Set(Object.keys(simulation.rules)), entityIds: new Set(Object.keys(simulation.entities)) });
  if (!evidence.ok) throw new Error(evidence.issues.join(','));
  return { kind: 'proposed', generation: 'fixture', sim: simulation, source: source.value, evidence: evidence.value };
}
async function source(page: Page) {
  await page.route('**/api/worldstream/source', async route => route.fulfill({ json: await proposal(route.request().postDataJSON()) }));
  await page.goto('/');
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByTestId('source-input').fill(text);
  await page.getByTestId('source-submit').click();
  await confirmFixtureParameters(page);
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
  test.setTimeout(90_000);
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

test('accepting a different source starts its own runtime, evidence and camera framing', async ({ page }) => {
  test.setTimeout(90_000);
  await source(page);
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  await why(page, 'start_countdown');
  await expect(page.getByTestId('why-explanation')).toContainText('start_countdown fired');
  await page.waitForFunction(() => window.__worldstreamStage?.ready());
  const first = await page.evaluate(() => ({ observation: window.__realityCompiler!.snapshot()!, camera: window.__worldstreamStage!.camera() }));
  expect(first.observation.runtime.tick).toBeGreaterThan(0);
  expect(first.observation.inputs).toHaveLength(1);
  expect(first.observation.runtime.values['f:started']).toBe(1);
  expect(first.observation.runtime.values['t:countdown']).toBeGreaterThan(0);
  const canvas = page.getByTestId('worldstream-canvas').locator('canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * 0.78, bounds!.y + bounds!.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * 0.9, bounds!.y + bounds!.height * 0.23, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage!.camera())).not.toEqual(first.camera);
  const manualCamera = await page.evaluate(() => window.__worldstreamStage!.camera());

  const replacementSim = structuredClone(sim);
  replacementSim.layout.width = 12;
  replacementSim.sockets.case = [11, 1];
  await page.route('**/api/worldstream/source', async route =>
    route.fulfill({ json: await proposal(route.request().postDataJSON(), replacementSim) }));
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByLabel('Source title', { exact: true }).fill('Second source museum');
  await page.getByTestId('source-input').fill('\ufeffDruhý zdroj: časovač běží 20 sekund. Vitrína je na pozici (11, 1).\r\n');
  const replacementText = await page.getByTestId('source-input').inputValue();
  await page.getByTestId('source-submit').click();
  await confirmFixtureParameters(page);
  await expect.poll(() => page.evaluate(() => window.__realityCompiler?.snapshot()?.project.projectRevision))
    .not.toBe(first.observation.project.projectRevision);
  await expect(page.getByTestId('source-status')).toContainText('Source accepted');
  await expect(page.getByTestId('runtime-pause')).toHaveText('Pause');
  await page.getByTestId('runtime-pause').click();
  const second = await page.evaluate(() => window.__realityCompiler!.snapshot()!);
  expect(second.project.sources[0].text).toBe(replacementText);
  expect(second.project.sources[0].title).toBe('Second source museum');
  expect(second.project.sources[0].sha256).not.toBe(first.observation.project.sources[0].sha256);
  expect(second.project.evidence.evidenceHash).not.toBe(first.observation.project.evidence.evidenceHash);
  expect(second.project.world.sim.layout).toMatchObject({ width: 12 });
  expect(second.inputs).toEqual([]);
  expect(second.runtime.values['f:started']).toBe(0);
  expect(second.runtime.values['f:alarm']).toBe(0);
  expect(second.runtime.values['t:countdown']).toBe(0);
  expect(second.runtime.transitions.every(transition => transition.ruleIds.length === 0)).toBe(true);
  await expect(page.getByTestId('why-explanation')).toHaveCount(0);
  await expect(page.getByTestId('source-panel')).toContainText('No rule has fired');
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage!.camera())).not.toEqual(manualCamera);
  const replacementCamera = await page.evaluate(() => window.__worldstreamStage!.camera());
  expect(replacementCamera).not.toEqual(first.camera);
  await page.getByTestId('camera-reset').click();
  await expect.poll(() => page.evaluate(expected => Math.max(...window.__worldstreamStage!.camera()
    .map((coordinate, axis) => Math.abs(coordinate - expected[axis]))), replacementCamera)).toBeLessThan(0.000001);
  // This is scripted state/identity isolation, not a semantic quality verdict.
  expect(second.generation).toBe('fixture');
  expect(second.project.evidence.claims.every(claim => claim.review.status === 'unchecked')).toBe(true);
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
  await confirmFixtureParameters(page);
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

test('malformed clarification and proposal bindings cannot crash review or replace the accepted world', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await source(page);
  const original = await page.evaluate(() => window.__realityCompiler?.snapshot());
  await page.getByText('Build from a source', { exact: true }).click();
  await page.route('**/api/worldstream/source', route => route.fulfill({ json: {
    kind: 'needsClarification', questions: [{}], conflicts: [], unsupported: [],
  } }));
  await page.getByTestId('source-input').fill('Another procedure');
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-status')).toContainText('clarification has an invalid format');
  await page.route('**/api/worldstream/source', async route => {
    const result = await proposal(route.request().postDataJSON());
    return route.fulfill({ json: { ...result, evidence: { ...result.evidence, bindings: [null] } } });
  });
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-status')).toContainText('evidence has an invalid format');
  await expect(page.getByTestId('source-confirm')).toHaveCount(0);
  const retained = await page.evaluate(() => window.__realityCompiler?.snapshot());
  expect(original).not.toBeNull();
  expect(retained?.project).toEqual(original?.project);
  await act(page, 'activate sensorA (visitor)');
  await why(page, 'start_countdown');
  await expect(page.getByTestId('why-explanation').locator('q')).toHaveText(text);
  expect(errors).toEqual([]);
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
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('An ordinary museum');
  await page.getByTestId('prompt-input').press('Enter');
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('source-provenance')).toHaveCount(0);
  await page.getByTestId('inspect-toggle').click();
  await expect(page.getByTestId('no-source-evidence')).toContainText('A prompt alone is not a citation');
});

test('parameters require explicit review and editing the source invalidates the proposal', async ({ page }) => {
  await page.route('**/api/worldstream/source', async route => route.fulfill({ json: await proposal(route.request().postDataJSON()) }));
  await page.goto('/');
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByTestId('source-input').fill(text);
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-confirm')).toBeDisabled({ timeout: 30_000 });
  await expect(page.getByTestId('source-provenance')).toHaveCount(0);
  for (const key of ['trigger', 'initial', 'proximity', 'duration', 'expiration', 'reset', 'ordering'])
    await page.getByTestId(`parameter-${key}`).selectOption('supported');
  await page.getByTestId('parameter-reset').selectOption('missing');
  await expect(page.getByTestId('source-confirm')).toBeDisabled();
  await expect(page.getByTestId('source-parameter-review').getByRole('alert')).toContainText('cannot run');
  await page.getByTestId('parameter-reset').selectOption('conflict');
  await expect(page.getByTestId('source-confirm')).toBeDisabled();
  await page.getByTestId('parameter-reset').selectOption('supported');
  await expect(page.getByTestId('source-confirm')).toBeEnabled();
  await page.getByTestId('source-input').fill(text + 'Changed.');
  await expect(page.getByTestId('source-parameter-review')).toHaveCount(0);
  await expect(page.getByTestId('source-provenance')).toHaveCount(0);
});

test('pipeline timings separate human review, the rendered frame and input in a rule-firing step', async ({ page }) => {
  await page.route('**/api/worldstream/source', async route => route.fulfill({ json: await proposal(route.request().postDataJSON()) }));
  await page.goto('/');
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByTestId('source-input').fill(text);
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-confirm')).toBeVisible();
  const pending = await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!);
  expect(pending.provenance).toBe('fixture');
  expect(pending.stages.find(stage => stage.name === 'source-request')?.outcome).toBe('completed');
  expect(pending.stages.find(stage => stage.name === 'parameter-review')).toMatchObject({ outcome: 'pending', elapsedMs: null });
  expect(pending.stages.some(stage => stage.name === 'first-frame')).toBe(false);
  await confirmFixtureParameters(page);
  await expect.poll(() => page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.stages
    .find(stage => stage.name === 'first-frame')?.outcome)).toBe('completed');
  await act(page, 'activate sensorB (visitor)');
  expect(await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.stages
    .find(stage => stage.name === 'first-interaction')?.outcome)).toBe('pending');
  await act(page, 'activate sensorA (visitor)');
  await expect.poll(() => page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!.outcome)).toBe('completed');
  const completed = await page.evaluate(() => window.__worldstreamMetrics!.snapshot().runs.at(-1)!);
  const review = completed.stages.find(stage => stage.name === 'parameter-review')!;
  const request = completed.stages.find(stage => stage.name === 'source-request')!;
  expect(review.startedAtMs).toBeGreaterThanOrEqual(request.endedAtMs!);
  expect(request.elapsedMs).toBe(pending.stages.find(stage => stage.name === 'source-request')!.elapsedMs);
  expect(completed.stages.every(stage => stage.elapsedMs !== null && stage.elapsedMs >= 0)).toBe(true);
  expect(JSON.stringify(completed)).not.toContain('Časovač');
});

test('source and simulation controls stay reachable in a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await source(page);
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  const boxes = await page.evaluate(() => {
    const rect = (selector: string) => {
      const value = document.querySelector(selector)!.getBoundingClientRect();
      return { x: value.x, right: value.right, top: value.top, bottom: value.bottom };
    };
    return { controls: rect('.ws-controls'), dock: rect('.ws-dock'), width: innerWidth, height: innerHeight,
      documentWidth: document.documentElement.scrollWidth };
  });
  expect(boxes.documentWidth).toBeLessThanOrEqual(boxes.width);
  expect(boxes.controls.bottom).toBeLessThanOrEqual(boxes.dock.top);
  expect(boxes.controls.top).toBeGreaterThan(150);
  expect(boxes.dock.bottom).toBeLessThanOrEqual(boxes.height);
  const positions = await page.evaluate(() => window.__worldstreamStage!.slots().map(slot => window.__worldstreamStage!.screen(slot.stableId)));
  expect(positions.every(point => point !== null && point.y < boxes.controls.top)).toBe(true);
  await page.screenshot({ path: 'scratch/reality-compiler-mobile.png' });
  await page.getByTestId('source-save').click();
  await expect(page.getByTestId('source-status')).toContainText('saved in this browser');
});

test('supplements and component evidence survive review, a timer intervention and reload', async ({ page }) => {
  test.setTimeout(120_000);
  const supplement = '\ufeffExplicit user addition: the timer runs for 20 seconds.\r\n';
  const grammar = serverGrammar(); if (typeof grammar === 'string') throw new Error(grammar);
  await page.route('**/api/worldstream/source', async route => {
    const { supplement, ...input } = route.request().postDataJSON();
    const result = await proposeSourceScenario({ source: { ...input, sourceId: 'source', mediaType: 'text/plain' },
      supplement, worldRevision: 'component-fixture', grammar, emit: async () => ({
        missingCritical: [], conflicts: [], unsupported: [], sim,
        // Scripted bindings test plumbing, not semantic accuracy of this text.
        claims: [{ claimId: 'original', text: 'Original fixture conditions.', support: 'sourced', review: { status: 'unchecked' }, interventionId: null,
          spans: [{ sourceId: 'source', startByte: 0, endByte: Buffer.byteLength(input.text), excerpt: input.text }] },
        { claimId: 'addition', text: 'The user supplies the duration.', support: 'sourced', review: { status: 'unchecked' }, interventionId: null,
          spans: [{ sourceId: 'user_supplement', startByte: 0, endByte: Buffer.byteLength(supplement), excerpt: supplement }] }],
        bindings: ruleSupportParts(sim.rules).map(({ ruleId, part }) => ({
          target: { kind: 'rule', id: ruleId }, part,
          claimIds: [ruleId === 'start_countdown' && part === 'action.1' ? 'addition' : 'original'] })),
      }) });
    await route.fulfill({ json: { ...result, generation: 'fixture' } });
  });
  await page.goto('/');
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByTestId('source-input').fill(text);
  await page.getByTestId('source-supplement').fill(supplement);
  // HTML textarea normalizes CRLF before React sees the value. The application
  // must preserve the actual submitted bytes, not the pre-paste JS fixture.
  const submittedText = await page.getByTestId('source-input').inputValue();
  const submittedSupplement = await page.getByTestId('source-supplement').inputValue();
  await page.getByTestId('source-submit').click();
  await expect(page.getByTestId('source-parameter-review')).toBeVisible();
  await page.getByTestId('parameter-trigger').selectOption('supported');
  await page.getByTestId('source-supplement').fill(supplement + 'Changed.');
  await expect(page.getByTestId('source-parameter-review')).toHaveCount(0);
  await page.getByTestId('source-supplement').fill(supplement);
  await page.getByTestId('source-submit').click();
  await confirmFixtureParameters(page);
  await expect(page.getByTestId('source-status')).toContainText('Source accepted');
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  await why(page, 'start_countdown');
  await expect(page.getByTestId('why-part-action.1')).toContainText('user addition, not original source');
  await expect(page.getByTestId('why-part-action.1').locator('q')).toHaveText(supplement);
  await expect(page.getByTestId('why-part-condition').locator('q')).toHaveText(text);
  const before = await page.evaluate(() => window.__realityCompiler!.snapshot()!.project);
  expect(before.sources[0].text).toBe(submittedText);
  expect(before.sources[1].text).toBe(submittedSupplement);
  expect(before.sources[1].origin).toBe('user-supplement');
  await page.getByText('Experiment with a future timer', { exact: true }).click();
  await page.getByLabel('Reason for intervention').fill('Test shorter duration, keep other support.');
  await page.getByRole('button', { name: 'Confirm timer experiment' }).click();
  await expect(page.getByTestId('source-status')).toContainText('Intervention accepted');
  await why(page, 'start_countdown');
  await expect(page.getByTestId('why-part-action.1')).toContainText('assumed');
  await expect(page.getByTestId('why-part-action.1').locator('q')).toHaveCount(0);
  await expect(page.getByTestId('why-part-condition').locator('q')).toHaveText(text);
  const changed = await page.evaluate(() => window.__realityCompiler!.snapshot()!.project);
  await page.getByTestId('source-save').click();
  await page.reload();
  await page.getByTestId('source-restore').click();
  await expect(page.getByTestId('source-status')).toContainText('restored by validated replay');
  expect(await page.evaluate(() => window.__realityCompiler!.snapshot()!.project)).toEqual(changed);
  await page.getByText('Original source', { exact: true }).click();
  await expect(page.getByTestId('source-bytes')).toHaveText(text);
  await expect(page.getByTestId('supplement-bytes')).toHaveText(supplement);
});

test('source saves survive reload with exact inputs and a usable original and changed branch', async ({ page }) => {
  test.setTimeout(120_000);
  await source(page);
  await act(page, 'activate sensorA (visitor)');
  await page.getByTestId('runtime-pause').click();
  const before = await page.evaluate(() => window.__realityCompiler!.snapshot()!);
  await page.getByTestId('source-save').click();
  await expect(page.getByTestId('source-status')).toContainText('saved in this browser');
  await page.reload();
  await page.getByTestId('source-restore').click();
  await expect(page.getByTestId('source-status')).toContainText('restored by validated replay', { timeout: 30_000 });
  let restored = await page.evaluate(() => window.__realityCompiler!.snapshot()!);
  expect(restored.project).toEqual(before.project);
  expect(restored.inputs).toEqual(before.inputs);
  expect(restored.runtime.values).toEqual(before.runtime.values);
  expect(restored.runtime.paused).toBe(true);
  await page.getByText('Experiment with a future timer', { exact: true }).click();
  await page.getByLabel('Reason for intervention').fill('Persist a shorter window.');
  await page.getByRole('button', { name: 'Confirm timer experiment' }).click();
  await expect(page.getByTestId('source-status')).toContainText('Intervention accepted');
  const changed = await page.evaluate(() => window.__realityCompiler!.snapshot()!);
  await page.getByTestId('source-save').click();
  await page.reload();
  await page.getByTestId('source-restore').click();
  await expect(page.getByTestId('source-status')).toContainText('restored by validated replay', { timeout: 30_000 });
  restored = await page.evaluate(() => window.__realityCompiler!.snapshot()!);
  expect(restored.project).toEqual(changed.project);
  expect(restored.runtime.values).toEqual(changed.runtime.values);
  await page.getByRole('button', { name: 'Show original source branch' }).click();
  await expect.poll(() => page.evaluate(() => window.__realityCompiler?.snapshot()?.project.branchId)).toBe('origin');
});

test('corrupt saves and unavailable storage leave the current source world intact', async ({ page }) => {
  await source(page);
  const revision = await page.evaluate(() => window.__realityCompiler!.snapshot()!.project.projectRevision);
  await page.evaluate(() => localStorage.setItem('worldstream.source-project.v1', '{broken'));
  await page.getByTestId('source-restore').click();
  await expect(page.getByTestId('source-status')).toContainText('invalid or unavailable');
  expect(await page.evaluate(() => window.__realityCompiler!.snapshot()!.project.projectRevision)).toBe(revision);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Quota', 'QuotaExceededError'); }; });
  await page.getByTestId('source-save').click();
  await expect(page.getByTestId('source-status')).toContainText('could not be saved');
  expect(await page.evaluate(() => window.__realityCompiler!.snapshot()!.project.projectRevision)).toBe(revision);
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
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('A different world');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  release();
  await expect(page.getByTestId('source-provenance')).toHaveCount(0);
  await expect(page.getByTestId('source-submit')).toBeEnabled();
});

test('stopping a source request preserves the accepted project and ignores its late result', async ({ page }) => {
  await source(page);
  const before = await page.evaluate(() => window.__realityCompiler!.snapshot()?.project.projectRevision);
  expect(before).toBeTruthy();
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/worldstream/source', async route => {
    const response = await proposal(route.request().postDataJSON());
    await held;
    await route.fulfill({ json: response }).catch(() => {});
  });
  await page.getByText('Build from a source', { exact: true }).click();
  await page.getByTestId('source-input').fill('A different source.');
  const sent = page.waitForRequest('**/api/worldstream/source');
  await page.getByTestId('source-submit').click(); await sent;
  const aborted = page.waitForEvent('requestfailed', request => request.url().endsWith('/api/worldstream/source'));
  await page.getByTestId('source-cancel').click();
  await aborted;
  await expect(page.getByTestId('source-status')).toContainText('Stopped waiting');
  await expect(page.getByTestId('source-submit')).toBeEnabled();
  release();
  await expect(page.getByTestId('source-parameter-review')).toHaveCount(0);
  expect(await page.evaluate(() => window.__realityCompiler!.snapshot()?.project.projectRevision)).toEqual(before);
  await expect(page.getByTestId('runtime-act')).toBeEnabled();
});
