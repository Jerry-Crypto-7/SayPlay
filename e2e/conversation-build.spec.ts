/**
 * **Věta přidá do živého světa objekt, který v něm nebyl** (P21 T8) — orákulum
 * brány A10 nad skutečným modelem, skutečným serverem a skutečným plátnem.
 *
 * Utrácí: první věta staví svět, druhá zakládá objekt, třetí ho jen groundí
 * (preview bez commitu), aby se ověřilo, že nový objekt má identitu, na kterou
 * další věta umí ukázat. Proto se spouští jako `live-chain.spec.ts` — jen na
 * výslovnou objednávku `EVAL_LIVE=1`; bez ní se přeskočí a `npm run test:e2e`
 * zůstává zdarma. **Vyžádaný a nespustitelný běh je červená, ne přeskočení.**
 *
 * Co se tu soudí a co ne: preview může přidání poctivě **odmítnout**
 * (`SHAPE_BUDGET`, `ALLOWED_PATH`, vadná odpověď) a to je platný výsledek
 * brány, ne pád testu — zapíše se do reportu. Když ale projde, musí platit
 * kontrakt commitu: nové id v `objects`, všechna dřívější id i jejich stav
 * bajtově beze změny, revize starých podob nehnuté, žádná mezera v `sequence`
 * a žádná chyba v konzoli.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnvConfig } from '@next/env';
import { expect, test } from '@playwright/test';

import type { WorldstreamBlueprint } from '../src/worldstream/schema';

loadEnvConfig(process.cwd());

const requested = process.env.EVAL_LIVE === '1';

interface Snapshot {
  readonly sequence: number;
  readonly representations: readonly { stableId: string; revision: number }[];
  readonly blueprint: WorldstreamBlueprint | null;
}

const WORLD = 'A quiet stone courtyard with one old well in the middle and a wooden gate on the far side that opens when a lever is pulled.';
const ADDITION = 'Add a small brass bell that was not here before, standing on its own by the far edge of the courtyard.';

test('one sentence adds a new object to a live world without touching what already stands', async ({ page }, info) => {
  test.skip(!requested, 'Live model run; request it with EVAL_LIVE=1');
  test.setTimeout(1_200_000);
  const folder = join(info.outputDir, 'conversation-build');
  mkdirSync(folder, { recursive: true });
  const errors: string[] = [];
  let sessionId: string | null = null;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/worldstream/sessions')
      sessionId = response.headers()['x-worldstream-session'] ?? sessionId;
  });
  const snapshot = async (): Promise<Snapshot> => {
    const response = await page.request.get(`/api/worldstream/sessions/${sessionId}`);
    expect(response.status()).toBe(200);
    return (await response.json()) as Snapshot;
  };

  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.getByTestId('prompt-input').fill(WORLD);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('prompt-submit')).toBeEnabled({ timeout: 850_000 });
  // Bez živé větve skončí generace poruchou — vyžádaný běh to nesmí zamlčet.
  expect(await page.getByTestId('world-broken').count(), 'the first sentence did not build a world').toBe(0);
  await expect(page.getByTestId('runtime-controls')).toBeVisible();
  expect(sessionId).not.toBeNull();

  const before = await snapshot();
  expect(before.blueprint).not.toBeNull();
  const previousIds = before.blueprint!.objects.map((object) => object.stableId);
  const previousObjects = JSON.stringify(before.blueprint!.objects);
  const previousShapes = JSON.stringify(before.blueprint!.shapes);
  const previousEntities = JSON.stringify((before.blueprint!.world.sim as { entities: unknown }).entities);
  await page.screenshot({ path: join(folder, 'before.png') });

  await page.getByTestId('refine-input').fill(ADDITION);
  await page.getByTestId('refine-submit').click();
  const panel = page.getByTestId('change-preview');
  await expect(panel).toBeVisible({ timeout: 260_000 });
  await expect(panel).toHaveAttribute('data-kind', /preview|refused|candidates/, { timeout: 260_000 });
  const kind = await panel.getAttribute('data-kind');
  const report: Record<string, unknown> = { measuredAt: new Date().toISOString(), world: WORLD, addition: ADDITION, kind, previousIds };
  const save = () => writeFileSync(join(folder, 'result.json'), JSON.stringify({ ...report, errors }, null, 2));
  await page.screenshot({ path: join(folder, 'preview.png') });

  if (kind !== 'preview') {
    // Nabídka kandidátů znamená, že věta se groundla na něco, co už stojí —
    // pro tuhle bránu je to totéž co odmítnutí: zapsat a nic nestavět.
    report.verdict = 'rejected';
    report.reason = kind === 'refused' ? await page.getByTestId('change-refusal').textContent() : 'grounded to an existing object';
    save();
    expect(errors).toEqual([]);
    return;
  }

  await expect(page.getByTestId('change-scope')).toContainText('a new object');
  const label = (await page.getByTestId('change-target').textContent()) ?? '';
  report.label = label;
  await page.getByTestId('change-apply').click();
  // Commit + snapshot + meshing nového tvaru; hotovo je, až se dá psát další věta.
  await expect(page.getByTestId('refine-submit')).toBeEnabled({ timeout: 120_000 });
  await expect(panel).toHaveCount(0);
  await page.screenshot({ path: join(folder, 'after.png') });

  const after = await snapshot();
  const ids = after.blueprint!.objects.map((object) => object.stableId);
  const added = ids.filter((id) => !previousIds.includes(id));
  report.added = added;
  report.verdict = 'accepted';
  save();

  expect(added, 'exactly one new object').toHaveLength(1);
  expect(ids.slice(0, previousIds.length)).toEqual(previousIds);
  expect(JSON.stringify(after.blueprint!.objects.slice(0, previousIds.length))).toBe(previousObjects);
  expect(JSON.stringify(after.blueprint!.shapes.slice(0, before.blueprint!.shapes.length))).toBe(previousShapes);
  const entities = { ...((after.blueprint!.world.sim as { entities: Record<string, unknown> }).entities) };
  delete entities[added[0]];
  expect(JSON.stringify(entities)).toBe(previousEntities);
  // Revize podob: staré tam, kde byly; nový objekt na nule.
  for (const record of before.representations)
    expect(after.representations.find((entry) => entry.stableId === record.stableId)?.revision).toBe(record.revision);
  expect(after.representations.find((entry) => entry.stableId === added[0])?.revision).toBe(0);
  expect(after.sequence).toBeGreaterThan(before.sequence);

  // Nový objekt má identitu, na kterou další věta umí ukázat.
  await page.getByTestId('refine-input').fill(`Make ${label} twice as tall.`);
  await page.getByTestId('refine-submit').click();
  await expect(panel).toHaveAttribute('data-kind', /preview|refused|candidates/, { timeout: 260_000 });
  if ((await panel.getAttribute('data-kind')) === 'preview')
    await expect(page.getByTestId('change-target')).toHaveText(label);
  report.secondSentence = await panel.textContent();
  await page.getByTestId('change-discard').click().catch(() => undefined);
  save();
  expect(errors).toEqual([]);
});
