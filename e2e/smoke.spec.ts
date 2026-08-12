import { expect, test } from '@playwright/test';

test('plátno dostane ŽIVÝ WebGL2 kontext, ne jen element canvas', async ({ page }) => {
  await page.goto('/');

  const canvas = page.locator('canvas');
  await expect(canvas).toBeVisible();

  // Existence <canvas> nedokazuje nic — element vznikne i když kontext selže.
  // Proto se čeká na zápis, který dělá až R3F onCreated se skutečným rendererem.
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 30_000 });

  const probe = await page.evaluate(() => window.__worldsmith);
  expect(probe?.webgl2, 'kontext není WebGL2').toBe(true);

  // Druhá, nezávislá cesta k téže otázce: zeptat se přímo elementu. Kdyby R3F
  // jen zapsal true a kontext byl ve skutečnosti WebGL1, tohle to chytí.
  const direct = await page.evaluate(() => {
    const el = document.querySelector('canvas');
    if (!el) return { ok: false, version: 'no canvas' };
    const gl = (el as HTMLCanvasElement).getContext('webgl2');
    return { ok: gl instanceof WebGL2RenderingContext, version: gl ? gl.getParameter(gl.VERSION) : 'none' };
  });
  expect(direct.ok, `přímý dotaz na webgl2 selhal (${direct.version})`).toBe(true);
  expect(String(direct.version)).toContain('WebGL 2.0');
});

test('plátno má nenulové rozměry', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 30_000 });

  const box = await page.locator('canvas').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(0);
  expect(box?.height ?? 0).toBeGreaterThan(0);
});
