import { expect, test } from '@playwright/test';
import { ACESFilmicToneMapping, PCFSoftShadowMap } from 'three';

import { VIEWER_BUDGETS } from '../src/kit/budgets';
import { FOG, SHADOW_MAP_TYPE } from '../src/components/viewer/Lighting';

/**
 * Oracle úlohy T6 — **rig je opravdu zapnutý a snímek se vejde do rozpočtu**.
 *
 * Ptá se rendereru, ne zdrojáku. To je celý smysl: `antialias` je atribut
 * kontextu, který ovladač smí odmítnout, `shadowMap.enabled` nastavuje R3F za
 * nás, a `calls` sčítá i stínový průchod, který ve scéně vidět není. Ani jedno
 * se ze zdrojáku odvodit nedá, takže grep by tu netvrdil nic.
 *
 * **Rozpočet se měří na nejtěžším layoutu, ne na prvním.** Layouty kitu se liší
 * počtem umístěných kusů; kdyby se měřil jen ten, se kterým se stránka načte,
 * prošel by strop i scéna, která ho pětkrát překročí hned po přepnutí.
 *
 * Čísla stropu drží `data/profiles/web-viewer.json` přes `VIEWER_BUDGETS` —
 * jedna kopie, kterou hlídá `src/kit/__tests__/budgets.test.ts`.
 */

const SETTLE_FRAMES = 3;

interface LayoutSample {
  readonly layout: string;
  readonly calls: number;
  readonly triangles: number;
}

test('plátno má zapnutý rig a vejde se do rozpočtu snímku', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/embed/harbor-pier');
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  const stats = await page.evaluate(async (frames): Promise<ReturnType<NonNullable<Window['__viewer']>['render']>> => {
    const viewer = window.__viewer!;
    const from = viewer.frames();
    while (viewer.frames() < from + frames) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    return viewer.render();
  }, SETTLE_FRAMES);

  expect(stats.toneMapping, 'tone mapping musí být ACES Filmic').toBe(ACESFilmicToneMapping);
  expect(stats.toneMappingExposure, 'ACES bez korekce expozice scénu ztmaví').toBeGreaterThan(1);
  expect(stats.shadowMapEnabled, 'bez stínové mapy se nic nedotýká podlahy').toBe(true);
  expect(stats.shadowMapType, 'renderer musí mít ten druh mapy, který mu nastavíme').toBe(
    SHADOW_MAP_TYPE,
  );
  // Tahle aserce má jméno vady, kvůli které tu je: three 0.185.1 označilo
  // `PCFSoftShadowMap` za zastaralý a `WebGLShadowMap.render()` si ho při
  // prvním snímku přepíše na tvrdý `PCFShadowMap`. Nastavení tedy nestačí
  // napsat, musí se změřit — jinak by scéna tiše měla ostré hrany stínu.
  expect(stats.shadowMapType, 'zastaralý typ si three přepíše na tvrdý sám').not.toBe(
    PCFSoftShadowMap,
  );
  expect(stats.antialias, 'kontext musí mít vyhlazování hran').toBe(true);
  expect(stats.fog, 'mlha musí existovat, jinak nemá scéna hloubku').not.toBeNull();
  expect(stats.fog!.color, 'mlha má barvu stránky, jinak vzdálený kus zbělá').toBe(FOG.color);
  expect(stats.fog!.near, 'pásmo mlhy musí být pásmo, ne bod').toBeLessThan(stats.fog!.far);
  expect(
    stats.lights,
    'rig je tři směrová a jedno polokulové — páté světlo je změna návrhu, ne detail',
  ).toBe(VIEWER_BUDGETS.maxLights);

  // Projde všechny layouty a nechá si ten nejtěžší. Strop platí pro každý z
  // nich; kdyby se měřil jen průměr, prošla by scéna, která ho na jednom
  // layoutu překročí dvojnásobně.
  const samples = await page.evaluate(async (frames): Promise<LayoutSample[]> => {
    const viewer = window.__viewer!;
    const settle = async (): Promise<void> => {
      const from = viewer.frames();
      while (viewer.frames() < from + frames) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
    };

    const out: LayoutSample[] = [];
    for (let index = 0; index < viewer.layouts.length; index += 1) {
      viewer.switchTo(index);
      await settle();
      const measured = viewer.render();
      out.push({ layout: viewer.layouts[index], calls: measured.calls, triangles: measured.triangles });
    }
    return out;
  }, SETTLE_FRAMES);

  expect(samples.length, 'bez layoutů se rozpočet nedá změřit').toBeGreaterThan(0);
  expect(
    samples.every((sample) => sample.calls > 0),
    `layout, který nekreslí nic, o rozpočtu netvrdí nic: ${JSON.stringify(samples)}`,
  ).toBe(true);

  const heaviestCalls = samples.reduce((worst, sample) => (sample.calls > worst.calls ? sample : worst));
  const heaviestTriangles = samples.reduce((worst, sample) =>
    sample.triangles > worst.triangles ? sample : worst,
  );

  expect(
    heaviestCalls.calls,
    `nejvíc kreslicích volání má ${heaviestCalls.layout}: ${heaviestCalls.calls}`,
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxDrawCallsPerFrame);
  expect(
    heaviestTriangles.triangles,
    `nejvíc trojúhelníků má ${heaviestTriangles.layout}: ${heaviestTriangles.triangles}`,
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxTrianglesPerFrame);
});
