import { expect, test } from '@playwright/test';

import { LAYOUTS } from '../src/kit/layouts';

/**
 * Oracle úlohy T201. Otázka není „jde layout postavit v Node" — na to jsou
 * jednotkové testy v `src/kit/__tests__/layouts.test.ts`. Otázka je, jestli se
 * **vykreslí do prvního snímku bez jediného cizího požadavku**, a tu zodpoví
 * jen skutečný prohlížeč nad produkčním buildem.
 */
for (const layout of LAYOUTS) {
  test(`${layout.id} se vykreslí bez požadavku mimo vlastní origin`, async ({ page, baseURL }) => {
    const own = new URL(baseURL!).origin;
    const foreign: string[] = [];

    page.on('request', (request) => {
      const url = new URL(request.url());
      // `data:` a `blob:` nejdou po síti, takže je requestem mimo origin nejsou.
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.origin !== own) foreign.push(request.url());
    });

    await page.goto(`/fallback/kit?layout=${layout.id}`);

    await expect(page.getByTestId('layout-title')).toHaveText(
      `${layout.title} · ${layout.palette}`,
    );

    await page.waitForFunction(() => window.__kitLayout?.ready === true, undefined, {
      timeout: 30_000,
    });

    const probe = await page.evaluate(() => window.__kitLayout);
    expect(probe?.id).toBe(layout.id);
    // Prázdné plátno by taky nemělo cizí požadavky. Tohle je rozdíl mezi
    // „nic se nestáhlo" a „nakreslilo se to z toho, co už bylo v bundlu".
    expect(probe?.calls ?? 0, 'renderer nevydal jediný draw call').toBeGreaterThan(0);
    expect(probe?.triangles ?? 0, 'renderer nenakreslil jediný trojúhelník').toBeGreaterThan(0);

    expect(foreign, `požadavky mimo ${own}`).toEqual([]);
  });
}
