import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, type Page, expect, test } from '@playwright/test';

/**
 * Chunky scény jdou s první vlnou (P50 T5). Dřív je stahoval až `import()` po hydrataci
 * (druhá vlna 365–586 ms proti ~100 ms první). Na rychlém lokálním serveru se chunk
 * stažený pozdě ani dvakrát neprojeví – proto test na seznam požadavků, ne na čas.
 */

const GRID_FIXTURE = join(process.cwd(), 'src/play/__fixtures__/collect_exit.json');
/** Text, který je jen v kódu `ArcadeStage` (StageCanvas) – pozná jeho chunk. */
const STAGE_MARK = 'No scene registered for';

// Prohlížeč žádá `%5Bid%5D`, HTML nese `[id]`: porovnává se dekódovaná cesta.
const chunkOf = (url: string): string | null => {
  const name = /\/_next\/static\/chunks\/(.+\.js)/.exec(new URL(url).pathname)?.[1];
  return name === undefined ? null : decodeURIComponent(name);
};

/** Chunky, které HTML stránky ohlásí samo (`<script src>` a `<link rel="preload" as="script">`). */
async function announced(request: APIRequestContext, url: string): Promise<{ scripts: Set<string>; preloads: string[] }> {
  const html = await (await request.get(url)).text();
  const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!));
  const preloads = [...html.matchAll(/<link rel="preload"[^>]*as="script"[^>]*>/g)].map((m) => decodeURIComponent(/href="([^"]+)"/.exec(m[0])![1]!));
  // Adresa hry z API je relativní; z URL chunku se čte jen cesta.
  const names = (hrefs: string[]) => hrefs.map((href) => chunkOf(new URL(href, 'http://play.invalid').href)).filter((name): name is string => name !== null);
  return { scripts: new Set([...names(scripts), ...names(preloads)]), preloads: names(preloads) };
}

/** Chunky JS, které stránka stáhla, než se objevilo plátno hry. */
async function loadedChunks(page: Page, url: string, canvas: string): Promise<string[]> {
  const chunks: string[] = [];
  page.on('request', (request) => {
    const name = chunkOf(request.url());
    if (name !== null) chunks.push(name);
  });
  await page.goto(url);
  await expect(page.locator(`${canvas} canvas`).first()).toBeVisible({ timeout: 60_000 });
  return chunks;
}

test.describe('P50 T5 – scene chunks with the first wave', () => {
  test('an arcade game announces every chunk it loads in its HTML', async ({ page, request }) => {
    const created = await request.post('/api/play/games', { data: { sentence: 'Race through five neon gates in order.' } });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const { url } = (await created.json()) as { url: string };
    const { scripts, preloads } = await announced(request, url);
    const loaded = await loadedChunks(page, url, '[data-testid="arcade-stage"]');

    expect(loaded.filter((name) => !scripts.has(name))).toEqual([]);
    // Chunk se scénou je mezi ohlášenými – jinak by se test splnil i bez něj.
    const bodies = await Promise.all(preloads.map(async (name) => (await request.get(`/_next/static/chunks/${name}`)).text()));
    expect(bodies.some((body) => body.includes(STAGE_MARK))).toBe(true);
  });

  test('a grid game does not download the arcade scene', async ({ page, request }) => {
    const arcade = await request.post('/api/play/games', { data: { sentence: 'Race through five neon gates in order.' } });
    const { preloads } = await announced(request, ((await arcade.json()) as { url: string }).url);
    const stage = (await Promise.all(preloads.map(async (name) => ((await (await request.get(`/_next/static/chunks/${name}`)).text()).includes(STAGE_MARK) ? name : null)))).filter((name): name is string => name !== null);
    expect(stage.length).toBeGreaterThan(0);

    const created = await request.post('/api/play/games', { data: { spec: JSON.parse(readFileSync(GRID_FIXTURE, 'utf8')) } });
    expect(created.status(), await created.text()).toBeLessThan(300);
    const { url } = (await created.json()) as { url: string };
    const loaded = await loadedChunks(page, url, '[data-testid="play-grid-stage"]');

    expect(loaded.filter((name) => stage.includes(name))).toEqual([]);
  });
});
