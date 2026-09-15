import { expect, test } from '@playwright/test';
import { browserRenderer } from '../scripts/browser-renderer';

test('graphics test renderer matches the requested hardware or software mode', async ({ page }, info) => {
  const { mode } = browserRenderer();
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: !!gl, renderer: ext ? String(gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '' };
  });
  console.log(`[graphics] ${mode}: ${gpu.renderer}`);
  await info.attach('renderer.json', { body: JSON.stringify({ mode, ...gpu }), contentType: 'application/json' });
  expect(gpu.webgl2).toBe(true);
  expect(gpu.renderer).not.toBe('');
  if (mode === 'software') expect(gpu.renderer).toMatch(/swiftshader|llvmpipe|software/i);
  else expect(gpu.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
});
