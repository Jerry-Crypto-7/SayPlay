import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const output = path.resolve(process.env.REFERENCE_OUTPUT ?? 'plans/P20/reference-scenes');
for (const [id, count] of [['interior', 7], ['courtyard', 6], ['observatory', 4]] as const) {
  test(`${id}: reference, four views, ablations, light and 20s flight`, async ({ page }) => {
    test.setTimeout(120_000);
    await mkdir(output, { recursive: true });
    await page.setViewportSize({ width: 1600, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/dev/reference-scenes');
    await page.getByLabel('Scene', { exact: true }).selectOption(id);
    await expect(page.getByRole('status')).toHaveText('Reference ready');
    const ready = async (expected: number = count) => {
      await expect.poll(() => page.evaluate(() => {
        const slots = window.__worldstreamStage?.slots() ?? [];
        return slots.filter(slot => !slot.failure && slot.rung !== 'semantic-clay' && slot.triangles > 12).length;
      }), { timeout: 30_000 }).toBe(expected);
    };
    await ready();
    const capture = async (name: string) => {
      const frames = await page.evaluate(() => window.__worldstreamStage?.frames() ?? 0);
      await expect.poll(() => page.evaluate(() => window.__worldstreamStage?.frames() ?? 0)).toBeGreaterThan(frames + 3);
      await page.locator('canvas').screenshot({ path: path.join(output, `${id}-${name}.png`) });
      return page.evaluate(() => ({ review: window.__referenceScene, slots: window.__worldstreamStage?.slots(), quality: window.__worldstreamStage?.quality() }));
    };
    const measurements: Record<string, unknown> = {};
    for (let view = 0; view < 4; view++) {
      await page.getByRole('button', { name: `View ${view + 1}`, exact: true }).click();
      measurements[`view${view + 1}`] = await capture(`view${view + 1}`);
      const rendered = await page.evaluate(() => window.__referenceScene!);
      expect(rendered.calls).toBeLessThanOrEqual(300);
      expect(rendered.triangles).toBeLessThanOrEqual(500_000);
    }
    await page.getByRole('button', { name: 'View 1', exact: true }).click();
    measurements.full = await capture('full');
    const original = await page.evaluate(() => ({ camera: window.__referenceScene!.camera, ids: window.__worldstreamStage!.slots().map(s => s.representationId) }));
    await page.getByRole('button', { name: 'Lamp on', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__referenceScene?.lampOn)).toBe(false);
    measurements.lampOff = await capture('lamp-off');
    expect(await page.evaluate(() => window.__referenceScene!.lampIntensity)).toBe(0);
    expect(await page.evaluate(() => window.__worldstreamStage!.slots().map(s => s.representationId))).toEqual(original.ids);
    await page.getByRole('button', { name: 'Lamp off', exact: true }).click();
    for (const ablation of ['clay', 'proxy', 'layout', 'light', 'camera', 'no-ibl', 'no-shadows']) {
      await page.getByLabel('Comparison').selectOption(ablation);
      await expect(page.getByRole('status')).toHaveText('Reference ready');
      await ready(ablation === 'proxy' ? (id === 'observatory' ? 1 : 0) : count);
      measurements[ablation] = await capture(ablation);
      if (ablation !== 'camera') expect(await page.evaluate(() => window.__referenceScene!.camera)).toEqual(original.camera);
      if (ablation === 'light' || ablation === 'no-ibl') expect(await page.evaluate(() => window.__referenceScene!.environment)).toBe(false);
      if (ablation === 'no-shadows') expect(await page.evaluate(() => window.__referenceScene!.shadows)).toBe(false);
    }
    await page.getByLabel('Comparison').selectOption('full');
    await ready();
    await expect.poll(() => page.evaluate(() => window.__referenceScene!.lampIntensity)).toBe(65);
    expect(await page.evaluate(() => window.__referenceScene!.lights)).toBe(4);
    // Record the actual production WebGL canvas, not a recreated motion graphic.
    const movie = await page.evaluate(async () => {
      const canvas = document.querySelector('canvas')!;
      const stream = canvas.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 5_000_000 });
      const chunks: Blob[] = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const finished = new Promise<string>(resolve => { recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(new Blob(chunks, { type: 'video/webm' }));
      }; });
      recorder.start();
      [...document.querySelectorAll('button')].find(button => button.textContent === 'Play 20s flythrough')!.click();
      setTimeout(() => recorder.stop(), 20_500);
      return finished;
    });
    await writeFile(path.join(output, `${id}-flythrough.webm`), Buffer.from(movie, 'base64'));
    await expect.poll(() => page.evaluate(() => window.__referenceScene?.time)).toBe(20);
    expect(await page.evaluate(() => window.__referenceScene!.camera)).not.toEqual(original.camera);
    const environment = await page.evaluate(() => {
      const gl = document.querySelector('canvas')!.getContext('webgl2')!;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { userAgent: navigator.userAgent, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight,
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
    });
    expect(errors).toEqual([]);
    await writeFile(path.join(output, `${id}-evidence.json`), JSON.stringify({ id, environment, measurements, errors, flythroughSeconds: 20 }, null, 2));
  });
}
