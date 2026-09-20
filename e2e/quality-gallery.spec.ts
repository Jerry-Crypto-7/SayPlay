import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { measureQualityFrames } from './quality-profile';

declare global {
  interface Window {
    __qualityObservation?: { firstPresentedMs: number | null };
  }
}

/**
 * **Galerie kvality — jak světy dvou modelů vypadají, ne jen že prošly.**
 *
 * `live-latency.measure.ts` ukládá hotové blueprinty do
 * `scratch/quality/<varianta>/<věta>.json`. Tahle sada je jeden po druhém
 * vyfotí produktovým plátnem (`/dev/worldstream?blueprint=`), spočítá nad
 * každým deterministickou bohatost (řádky kompozice, kusy, druhy, hrdinské
 * tvary a jejich hloubka) a složí kontaktní list `scratch/quality/gallery.png`
 * — věty v řádcích, modely ve sloupcích — pro rozhodnutí člověka.
 *
 * **Běží jen na zavolání:** bez `WORLDSMITH_QUALITY_DIR` se přeskočí, takže
 * běžná e2e sada ji nikdy nespustí ani po ní nic nepřepíše. Adresář se čte
 * z env, ne z pevné cesty, aby se dal fotit i starší běh.
 */

const DIR = process.env.WORLDSMITH_QUALITY_DIR ?? '';
const EXPECTED = process.env.WORLDSMITH_QUALITY_CASES;
const PROFILE = process.env.WORLDSMITH_QUALITY_PROFILE === '1';
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Stored {
  readonly id: string;
  readonly prompt: string;
  readonly model: string;
  readonly blueprint: {
    readonly geometry: { readonly nodes: readonly { readonly kind: string; readonly count?: number }[] };
    readonly shapes: readonly { readonly nodes: readonly { readonly kind: string; readonly children?: readonly number[]; readonly child?: number }[] }[];
    readonly objects: readonly unknown[];
  };
}

interface Richness {
  readonly rows: number;
  readonly kinds: number;
  readonly shapes: number;
  readonly shapeNodes: number;
  readonly shapeDepth: number;
  readonly objects: number;
}

function shapeDepth(nodes: Stored['blueprint']['shapes'][number]['nodes']): number {
  const depth = (index: number): number => {
    const node = nodes[index];
    const children = node.children ?? (node.child === undefined ? [] : [node.child]);
    return 1 + Math.max(0, ...children.map(depth));
  };
  return nodes.length === 0 ? 0 : depth(nodes.length - 1);
}

function richness(stored: Stored): Richness {
  const geometry = stored.blueprint.geometry.nodes;
  return {
    rows: geometry.length,
    kinds: new Set(geometry.map((node) => node.kind)).size,
    shapes: stored.blueprint.shapes.length,
    shapeNodes: stored.blueprint.shapes.reduce((sum, shape) => sum + shape.nodes.length, 0),
    shapeDepth: Math.max(0, ...stored.blueprint.shapes.map((shape) => shapeDepth(shape.nodes))),
    objects: stored.blueprint.objects.length,
  };
}

test.describe('quality gallery', () => {
  test.skip(DIR === '', 'set WORLDSMITH_QUALITY_DIR to the directory live-latency.measure.ts wrote');

  test('photographs every stored world and composes the contact sheet', async ({ page }) => {
    test.setTimeout(30 * 60_000);
    const root = resolve(DIR);
    const variants = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'shots')
      .filter((entry) => readdirSync(join(root, entry.name)).some((name) => name.endsWith('.json') && JSON.parse(readFileSync(join(root, entry.name, name), 'utf8')).blueprint))
      .map((entry) => entry.name);
    expect(variants.length).toBeGreaterThan(0);
    const shots = join(root, 'shots');
    mkdirSync(shots, { recursive: true });

    const cells = new Map<string, Map<string, { png: string | null; note: string; richness: Richness; prompt: string }>>();
    await page.setViewportSize(PROFILE ? { width: 1920, height: 1080 } : { width: 960, height: 600 });
    const expected = EXPECTED ? JSON.parse(readFileSync(resolve(EXPECTED), 'utf8')) as { id: string; prompt: string }[] : [];
    for (const entry of expected) cells.set(entry.id, new Map());
    const renderFailures: string[] = [];
    const observations: { id: string; variant: string; firstPresentedMs: number | null; note: string }[] = [];
    const profiles: { id: string; variant: string; result: Awaited<ReturnType<typeof measureQualityFrames>> }[] = [];
    // Pozorujeme skutečný commit plátna v časové ose prohlížeče, ne polling test runneru.
    await page.addInitScript(() => {
      const observation = { firstPresentedMs: null as number | null };
      Object.assign(window, { __qualityObservation: observation });
      const observer = new MutationObserver(() => {
        if (document.querySelector('[data-testid="stage-status"][data-presented="true"]')) {
          observation.firstPresentedMs = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-presented'] });
    });

    for (const variant of variants) {
      for (const file of readdirSync(join(root, variant)).filter((name) => name.endsWith('.json'))) {
        const stored = JSON.parse(readFileSync(join(root, variant, file), 'utf8')) as Stored;
        if (!stored.blueprint) continue;
        const url = `/__quality/${encodeURIComponent(variant)}/${stored.id}.json`;
        await page.route(url, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(stored) }));
        await page.goto(`/dev/worldstream?blueprint=${encodeURIComponent(url)}&tier=full`);
        if (!existsSync(join(root, 'browser-environment.json'))) {
          const environment = await page.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl2');
            const info = gl?.getExtension('WEBGL_debug_renderer_info');
            const gpu = gl && info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
            gl?.getExtension('WEBGL_lose_context')?.loseContext();
            return { userAgent: navigator.userAgent, dpr: devicePixelRatio, width: innerWidth, height: innerHeight, gpu };
          });
          writeFileSync(join(root, 'browser-environment.json'), JSON.stringify({ ...environment, browser: page.context().browser()?.version(), rendererMode: process.env.E2E_RENDERER ?? 'platform-default', temperatureAndLoad: 'not measured', performanceGate: 'pending; gallery is not a frame-time benchmark' }, null, 2));
        }
        const status = page.getByTestId('stage-status');
        await expect
          .poll(async () => (await status.getAttribute('data-presented')) === 'true' || /failed|declined/.test((await status.textContent()) ?? ''), {
            timeout: 120_000,
          })
          .toBe(true);
        // Materializace hrdinů doběhne až po prvním snímku; dva klidné okamžiky stačí.
        await page.waitForTimeout(1500);
        const note = (await status.textContent()) ?? '';
        const timing = await page.evaluate(() => {
          if (!window.__qualityObservation) throw new Error('Browser observation was not installed');
          return window.__qualityObservation;
        });
        observations.push({ id: stored.id, variant, firstPresentedMs: timing.firstPresentedMs, note });
        const png = join(shots, `${variant.replace(/[^\w.+@-]/g, '_')}-${stored.id}.png`);
        const ok = !/failed|declined/.test(note);
        if (!ok) renderFailures.push(`${variant}/${stored.id}: ${note}`);
        if (ok && PROFILE) profiles.push({ id: stored.id, variant, result: await measureQualityFrames(page) });
        if (ok) await page.getByTestId('worldstream-canvas').screenshot({ path: png, style: '[data-testid="stage-status"] { visibility: hidden !important; }' });
        if (!cells.has(stored.id)) cells.set(stored.id, new Map());
        cells.get(stored.id)!.set(variant, { png: ok ? png : null, note, richness: richness(stored), prompt: stored.prompt });
        await page.unroute(url);
      }
    }

    // Kontaktní list: věty v řádcích, modely ve sloupcích, pod každým políčkem bohatost.
    const ids = [...cells.keys()].sort();
    const img = (file: string) => `data:image/png;base64,${readFileSync(file).toString('base64')}`;
    const cell = (entry: { png: string | null; note: string; richness: Richness } | undefined) => {
      if (entry === undefined) return '<td class="miss">not built</td>';
      const r = entry.richness;
      const facts = `${r.rows} rows · ${r.kinds} kinds · ${r.objects} objects · ${r.shapes} shapes (${r.shapeNodes} nodes, depth ${r.shapeDepth})`;
      return entry.png === null
        ? `<td class="miss">${escapeHtml(entry.note)}<br><small>${facts}</small></td>`
        : `<td><img src="${img(entry.png)}"><br><small>${facts}</small></td>`;
    };
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{background:#0b1b22;color:#e7eef0;font:13px/1.4 ui-monospace,monospace;margin:16px}
      table{border-collapse:collapse} th,td{padding:6px 8px;vertical-align:top;border:1px solid #244}
      img{width:440px;display:block} .miss{color:#f6b26b;width:440px} .prompt{max-width:220px;font-size:12px}
      small{color:#9bb}</style>
      <table><tr><th>sentence</th>${variants.map((v) => `<th>${escapeHtml(v)}</th>`).join('')}</tr>
      ${ids
        .map((id) => {
          const row = cells.get(id)!;
          const prompt = [...row.values()][0]?.prompt ?? expected.find((entry) => entry.id === id)?.prompt ?? '';
          return `<tr><td class="prompt"><b>${escapeHtml(id)}</b><br>${escapeHtml(prompt)}</td>${variants.map((v) => cell(row.get(v))).join('')}</tr>`;
        })
        .join('')}</table>`;
    writeFileSync(join(root, 'gallery.html'), html);
    // Hash ordering is deterministic; the private key stays separate from the blind sheet.
    const blind = ids.flatMap((id) => variants.map((variant) => ({ id, variant, entry: cells.get(id)!.get(variant) })))
      .sort((a, b) => createHash('sha256').update(`p20-v1/${a.id}/${a.variant}`).digest('hex').localeCompare(createHash('sha256').update(`p20-v1/${b.id}/${b.variant}`).digest('hex')));
    writeFileSync(join(root, 'blind-key.json'), JSON.stringify(blind.map(({ id, variant }, index) => ({ code: `B${index + 1}`, id, variant })), null, 2));
    writeFileSync(join(root, 'blind.html'), `<!doctype html><meta charset="utf-8"><title>Blind scene review</title><style>body{font:16px sans-serif;background:#eee}section{break-after:page;margin:24px}img{max-width:960px;width:100%}</style>${blind.map(({ entry }, index) => `<section><h2>B${index + 1}</h2>${entry?.png ? `<img src="${img(entry.png)}">` : '<p>No image available</p>'}<p>Describe the place and visible objects. Do not infer absent details.</p><p>Coherence / visual impression (1–5): ____</p></section>`).join('')}`);
    await page.setViewportSize({ width: 300 + 460 * variants.length, height: 900 });
    await page.setContent(html);
    await page.screenshot({ path: join(root, 'gallery.png'), fullPage: true });

    const table = ids.map((id) =>
      Object.fromEntries(variants.map((variant) => { const entry = cells.get(id)!.get(variant); return [variant, entry ? { built: entry.png !== null, ...entry.richness } : { built: false, reason: 'no valid saved blueprint' }]; })),
    );
    writeFileSync(join(root, 'richness.json'), JSON.stringify(Object.fromEntries(ids.map((id, index) => [id, table[index]])), null, 2));
    writeFileSync(join(root, 'browser-observations.json'), JSON.stringify({
      measuredAt: new Date().toISOString(),
      path: '/dev/worldstream?blueprint=<saved-world>&tier=full',
      origin: 'navigation start; saved blueprint supplied by Playwright route',
      cache: 'same browser context; Playwright routing disables HTTP cache; not a cold/warm generation experiment',
      meaning: 'first canvas presentation callback, not visual recognition or interactive simulation readiness',
      promptToIntentMs: null, promptToRecognizableCompositionMs: null, promptToInteractiveWorldMs: null,
      cases: ids.flatMap((id) => variants.map((variant) => observations.find((entry) => entry.id === id && entry.variant === variant)
        ?? { id, variant, firstPresentedMs: null, note: 'no valid saved blueprint' })),
    }, null, 2));
    if (PROFILE) {
      writeFileSync(join(root, 'frame-profile.json'), JSON.stringify({
        measuredAt: new Date().toISOString(),
        method: '180 requestAnimationFrame intervals with advancing stage frame count after 1.5s settle; 30s cap per scene; fixed camera, full tier',
        scope: 'saved static worlds at 1920x1080; browser cadence plus optional EXT_disjoint_timer_query_webgl2 GPU execution and CPU submission; unsupported/disjoint explicit; not input latency or reference-laptop G-P acceptance',
        conditions: 'live generation may run concurrently; temperature and machine load unmeasured',
        cases: ids.flatMap((id) => variants.map((variant) => profiles.find((entry) => entry.id === id && entry.variant === variant)
          ?? { id, variant, result: null })),
      }, null, 2));
      expect(profiles.every(({ result }) => result.status === 'complete' && result.visible === 'visible'
        && result.canvas?.width === 1920 && result.canvas.height === 1080), 'profile needs 180 observed frames at actual 1080p').toBe(true);
    }
    expect(observations.filter((entry) => !/failed|declined/.test(entry.note)).every((entry) => entry.firstPresentedMs !== null && entry.firstPresentedMs >= 0), 'presented worlds must have a browser observation').toBe(true);
    expect(existsSync(join(root, 'gallery.png'))).toBe(true);
    expect(renderFailures, 'valid saved blueprints must render').toEqual([]);
  });
});
