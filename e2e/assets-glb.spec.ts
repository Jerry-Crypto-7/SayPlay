import { test, expect } from '@playwright/test';
import catalog from '../src/assets/catalog.json';

test('GLB PBR catalog renders, shares lifetime, reloads and switches LOD', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/dev/assets');
  const ready = (count: number, level: number) => expect.poll(async () => page.evaluate(({ count, hashes }) => {
    const slots = window.__worldstreamStage?.slots() ?? [];
    return { count: slots.length, failures: slots.filter(slot => slot.contentHash !== hashes[Number(slot.stableId.replace('sample', '')) % 6]
      || slot.rung !== 'g3-ready' || slot.triangles <= 12 || slot.failure).map(s => ({ id: s.stableId, failure: s.failure, hash: s.contentHash })) };
  }, { count, hashes: catalog.assets.map(a => a.lods[level].hash) }), { timeout: 30_000 }).toEqual({ count, failures: [] });
  await ready(7, 0);
  const memory = await page.evaluate(() => window.__worldstreamStage!.memory());
  const before = await page.evaluate(() => window.__worldstreamStage!.slots());
  expect(before[0].asset!.materials.some(m => m.transparent)).toBe(true);
  expect(before[5].asset!.nodes).toContain(catalog.assets[5].parts.find(p => p.id === 'leaf')!.node);
  await page.screenshot({ path: testInfo.outputPath('glb-catalog.png') });
  await page.getByRole('button', { name: 'Remove first instance' }).click();
  await ready(6, 0);
  const survivor = await page.evaluate(() => window.__worldstreamStage!.slots().find(s => s.stableId === 'sample6'));
  expect(survivor!.representationId).toBe(before[6].representationId);
  expect(survivor!.asset!.materials).toEqual(before[6].asset!.materials);
  await page.getByRole('button', { name: 'Unload all' }).click();
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage?.slots().length)).toBe(0);
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage!.memory().geometries)).toBeLessThan(memory.geometries);
  await page.getByRole('button', { name: 'Load all', exact: true }).click();
  await ready(7, 0);
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage!.memory())).toEqual(memory);
  await page.getByRole('button', { name: 'LOD 0' }).click();
  await ready(7, 1);
  expect(errors).toEqual([]);
});
