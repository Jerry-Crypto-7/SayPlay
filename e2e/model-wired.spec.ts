/**
 * T9 — model je skutečná třetí cesta za korpusem a rozpoznávačem.
 * Obě větve volají skutečný `/api/generate`; váhy ani endpoint se nestubují.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page } from '@playwright/test';

import { isWeightRequest } from '../src/model/local/capability';

const UNKNOWN = 'a world that the frozen corpus and recogniser have never heard of';
// P003 z T8: rozpoznávač ho poslal modelu a celá produkční certifikační brána
// prošla. Ve starším offline korpusu `/api/generate` není, takže endpoint pořád
// skutečně vrátí NO_SOURCE a model zůstává třetí cestou.
const MODEL_SENTENCE = 'a zen garden where raking the sand makes ripples that spread outward';
const INITIAL_WORLD_BUDGET_MS = 20_000;
const MODEL_TIMEOUT_MS = 45 * 60 * 1000;

function observe(page: Page): { readonly weights: string[]; readonly generate: string[]; readonly errors: Error[] } {
  const weights: string[] = [];
  const generate: string[] = [];
  const errors: Error[] = [];
  page.on('request', (request) => {
    if (isWeightRequest(request.url())) weights.push(request.url());
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/generate') generate.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error));
  return { weights, generate, errors };
}

async function submit(page: Page, sentence: string): Promise<void> {
  await page.getByTestId('prompt-input').fill(sentence);
  await page.getByTestId('prompt-submit').click();
}

async function expectWorld(page: Page, timeout: number): Promise<void> {
  await page.waitForFunction(() => window.__worldsmith !== undefined && window.__worldsmith.entities().length > 0, undefined, {
    timeout,
  });
}

function removeOwnedProfile(profile: string): void {
  const root = resolve(tmpdir());
  const target = resolve(profile);
  if (!target.startsWith(`${root}${sep}`) || !basename(target).startsWith('worldsmith-model-wired-'))
    throw new Error(`refusing to remove a profile outside the test namespace: ${target}`);
  rmSync(target, { recursive: true, force: true });
}

test('bez akcelerace zůstane okamžitá náhradní místnost a neodejde jediný byte vah', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'no-acceleration', 'větev bez WebGPU patří do no-acceleration projektu');
  test.setTimeout(120_000);
  const seen = observe(page);

  await page.goto('/');
  await expect(page.getByTestId('model-progress')).toHaveAttribute('data-phase', 'unavailable', { timeout: 20_000 });
  await submit(page, UNKNOWN);
  await expectWorld(page, INITIAL_WORLD_BUDGET_MS);

  await expect(page.getByTestId('emission-source')).toHaveAttribute('data-source', 'substitute');
  await expect(page.getByTestId('prompt-substitute')).toBeVisible();
  await page.waitForTimeout(5_000);

  expect(seen.generate.length, 'prompt nešel přes skutečný /api/generate').toBe(1);
  expect(seen.weights, `bez WebGPU odešly požadavky na váhy: ${seen.weights.join(', ')}`).toEqual([]);
  expect(seen.errors.map((error) => error.message)).toEqual([]);
});

async function warmGpu(context: BrowserContext, page: Page, baseUrl: string): Promise<string> {
  const route = '/__model-wired-gpu-warmup.html';
  await context.route(`**${route}`, (request) =>
    request.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>gpu warmup</title>',
    }),
  );
  await page.goto(new URL(route, baseUrl).toString());
  return page.evaluate(async () => {
    let adapter: GPUAdapter | null = null;
    for (let attempt = 0; attempt < 20 && adapter === null && navigator.gpu; attempt += 1) {
      adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
      if (adapter === null) await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    return adapter === null ? 'none' : `${adapter.info.vendor || '?'}/${adapter.info.architecture || '?'}`;
  });
}

async function visibleModelState(page: Page): Promise<{
  readonly source: string | null;
  readonly phase: string | null;
  readonly status: string;
  readonly detail: string;
}> {
  return page.evaluate(() => ({
    source: document.querySelector('[data-testid="emission-source"]')?.getAttribute('data-source') ?? null,
    phase: document.querySelector('[data-testid="model-progress"]')?.getAttribute('data-phase') ?? null,
    status: document.querySelector('[data-testid="prompt-model-status"]')?.textContent?.trim() ?? '',
    detail: document.querySelector('[data-testid="model-progress-detail"]')?.textContent?.trim() ?? '',
  }));
}

async function waitForModelTerminal(page: Page): Promise<Awaited<ReturnType<typeof visibleModelState>>> {
  const deadline = Date.now() + MODEL_TIMEOUT_MS;
  let state = await visibleModelState(page);
  while (
    state.source !== 'model' &&
    state.phase !== 'unavailable' &&
    !/could not certify|failed \(/i.test(state.status) &&
    Date.now() < deadline
  ) {
    console.log(`[model-wired] waiting ${JSON.stringify(state)}`);
    await page.waitForTimeout(Math.min(30_000, Math.max(0, deadline - Date.now())));
    state = await visibleModelState(page);
  }
  return state;
}

test('skutečný prohlížečový model nahradí okamžitý svět certifikovanou emisí', async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium', 'živá WebGPU větev běží jednou v hlavním projektu');
  test.setTimeout(50 * 60 * 1000);

  const baseUrl = testInfo.project.use.baseURL;
  expect(baseUrl, 'projekt nemá baseURL').toBeTruthy();
  const profile = mkdtempSync(join(tmpdir(), 'worldsmith-model-wired-'));
  let context: BrowserContext | null = null;

  try {
    // Prázdné args zahodí SwiftShader zděděný z hlavní konfigurace. Systémový
    // Chrome má na tomhle stroji funkční D3D12 WebGPU; Playwright Chromium ne.
    // Hranice oraclu vyžaduje skutečný request na původ vah. Sdílená měřicí
    // cache by správně obsloužila vše lokálně a síťový kontrakt by neotestovala,
    // proto má tenhle jediný cold-start běh vlastní profil.
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chrome',
      headless: true,
      args: [],
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const adapter = await warmGpu(context, page, baseUrl as string);
    expect(adapter, 'systémový Chrome nedostal hardwarový WebGPU adaptér').not.toBe('none');
    console.log(`[model-wired] adapter ${adapter}`);

    const seen = observe(page);
    await page.goto(baseUrl as string);
    await expect
      .poll(() => page.getByTestId('model-progress').getAttribute('data-phase'), {
        timeout: 20_000,
        message: 'model nezačal načítat na stroji s hardwarovým WebGPU',
      })
      .toMatch(/^(loading|ready)$/);

    await submit(page, MODEL_SENTENCE);
    await expectWorld(page, INITIAL_WORLD_BUDGET_MS);
    await expect(page.getByTestId('emission-source')).toHaveAttribute('data-source', 'substitute');
    await expect(page.getByTestId('prompt-substitute')).toBeVisible();

    const final = await waitForModelTerminal(page);
    console.log(`[model-wired] final ${JSON.stringify(final)}`);
    expect(final.source, `modelová cesta skončila bez certifikované emise: ${JSON.stringify(final)}`).toBe('model');
    await expectWorld(page, INITIAL_WORLD_BUDGET_MS);
    await expect(page.getByTestId('prompt-substitute')).toHaveCount(0);
    await expect(page.getByTestId('prompt-model-status')).toContainText('certified the world');

    expect(seen.generate.length, 'prompt nešel přes skutečný /api/generate').toBe(1);
    expect(seen.weights.length, 'hardwarová větev neoslovila skutečný původ vah').toBeGreaterThan(0);
    expect(seen.errors.map((error) => error.message)).toEqual([]);
  } finally {
    await context?.close().catch(() => undefined);
    removeOwnedProfile(profile);
  }
});
