import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

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
      .map((entry) => entry.name);
    expect(variants.length).toBeGreaterThan(0);
    const shots = join(root, 'shots');
    mkdirSync(shots, { recursive: true });

    const cells = new Map<string, Map<string, { png: string | null; note: string; richness: Richness; prompt: string }>>();
    await page.setViewportSize({ width: 960, height: 600 });

    for (const variant of variants) {
      for (const file of readdirSync(join(root, variant)).filter((name) => name.endsWith('.json'))) {
        const stored = JSON.parse(readFileSync(join(root, variant, file), 'utf8')) as Stored;
        const url = `/__quality/${encodeURIComponent(variant)}/${stored.id}.json`;
        await page.route(url, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(stored) }));
        await page.goto(`/dev/worldstream?blueprint=${encodeURIComponent(url)}&tier=full`);
        const status = page.getByTestId('stage-status');
        await expect
          .poll(async () => (await status.getAttribute('data-presented')) === 'true' || /failed|declined/.test((await status.textContent()) ?? ''), {
            timeout: 120_000,
          })
          .toBe(true);
        // Materializace hrdinů doběhne až po prvním snímku; dva klidné okamžiky stačí.
        await page.waitForTimeout(1500);
        const note = (await status.textContent()) ?? '';
        const png = join(shots, `${variant.replace(/[^\w.+@-]/g, '_')}-${stored.id}.png`);
        const ok = !/failed|declined/.test(note);
        if (ok) await page.getByTestId('worldstream-canvas').screenshot({ path: png });
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
        ? `<td class="miss">${entry.note}<br><small>${facts}</small></td>`
        : `<td><img src="${img(entry.png)}"><br><small>${facts}</small></td>`;
    };
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{background:#0b1b22;color:#e7eef0;font:13px/1.4 ui-monospace,monospace;margin:16px}
      table{border-collapse:collapse} th,td{padding:6px 8px;vertical-align:top;border:1px solid #244}
      img{width:440px;display:block} .miss{color:#f6b26b;width:440px} .prompt{max-width:220px;font-size:12px}
      small{color:#9bb}</style>
      <table><tr><th>sentence</th>${variants.map((v) => `<th>${v}</th>`).join('')}</tr>
      ${ids
        .map((id) => {
          const row = cells.get(id)!;
          const prompt = [...row.values()][0]?.prompt ?? '';
          return `<tr><td class="prompt"><b>${id}</b><br>${prompt}</td>${variants.map((v) => cell(row.get(v))).join('')}</tr>`;
        })
        .join('')}</table>`;
    writeFileSync(join(root, 'gallery.html'), html);
    await page.setViewportSize({ width: 300 + 460 * variants.length, height: 900 });
    await page.setContent(html);
    await page.screenshot({ path: join(root, 'gallery.png'), fullPage: true });

    const table = ids.map((id) =>
      Object.fromEntries([...cells.get(id)!.entries()].map(([variant, entry]) => [variant, { built: entry.png !== null, ...entry.richness }])),
    );
    writeFileSync(join(root, 'richness.json'), JSON.stringify(Object.fromEntries(ids.map((id, index) => [id, table[index]])), null, 2));
    expect(existsSync(join(root, 'gallery.png'))).toBe(true);
  });
});
