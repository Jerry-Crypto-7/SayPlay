import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { ACESFilmicToneMapping, PCFSoftShadowMap } from 'three';

import { KIT_BUDGETS, VIEWER_BUDGETS } from '../src/kit/budgets';
import { WORLDSTREAM_SHADOW_MAP_TYPE } from '../src/components/viewer/WorldstreamLighting';

/**
 * Oracle úlohy T2 — **cílový snímek se opravdu vykreslí a vejde se do rozpočtu**.
 *
 * Ptá se rendereru, ne zdrojáku. `renderer.info.render` je jediné místo, kde je
 * vidět, co plátno doopravdy udělalo: stínový průchod kreslí každý vrhající
 * objekt podruhé a ve scéně ho vidět není, takže spočítat ho z JSX nejde.
 *
 * ## Rozpočty se sem neopisují
 *
 * `KIT_BUDGETS.maxTrianglesPerWorld` a `VIEWER_BUDGETS.maxDrawCallsPerFrame`
 * jsou jediná kopie těch čísel. Druhá tabulka vedle scény by se s touhle
 * rozešla a zelený test by pak certifikoval strop, který nikde neplatí.
 *
 * ## Snímková frekvence se soudí jen na skutečném ovladači
 *
 * Playwright tady jede na **SwiftShaderu** — softwarovém rendereru bez GPU
 * (`playwright.config.ts` mu to nastavuje výslovně).
 *
 * **Naměřeno 27. 8. 2026: medián snímku 17,4 ms, tedy 57 fps — na softwarovém
 * rasterizéru.** To číslo neměří scénu, měří **kadenci `requestAnimationFrame`**:
 * 17,4 ms je vzdálenost dvou tiků 60Hz časovače a smyčka se za ní prostě
 * nezpozdila. Aserce „p50 pod 20 ms" je tady proto zelená bez ohledu na to, co
 * plátno kreslí — ověřeno mutací, která detekci softwarového ovladače vypnula:
 * test zůstal **zelený**, přestože měl v tu chvíli soudit SwiftShader jako
 * kdyby to byla grafická karta. Aserce, která nerozliší GPU od procesoru,
 * o výkonu netvrdí nic.
 *
 * **Trojúhelníky a kreslicí volání jsou naopak na ovladači nezávislé** — jsou to
 * čísla geometrie a dávkování, ne rychlosti — takže rozpočet pinuje test vždycky
 * a frekvenci soudí jen tam, kde ji lze změřit poctivě. Ovladač se čte za běhu
 * z `WEBGL_debug_renderer_info`, takže na stroji s akcelerací se aserce zapne
 * sama a nic se kvůli tomu nepřepíná ručně.
 *
 * ## Že tam není model ani API, se také měří
 *
 * AC žádá scénu **bez modelu a bez API**. Kdyby se to jen tvrdilo v komentáři,
 * první `fetch` na `/api/...` by tuhle vlastnost tiše zrušil. Test proto sleduje
 * síť stránky.
 */

/** Medián délky snímku, pod kterým je scéna na 50 fps. Číslo z AC úlohy T2. */
const MAX_MEDIAN_FRAME_MS = 20;

/** Kolik snímků se nechá proběhnout, než se čte. První snímky nesou kompilaci shaderů. */
const SETTLE_FRAMES = 30;

/** Pevný výřez, aby se `docs/target-frame.png` mezi běhy neměnil kvůli velikosti okna. */
const FRAME_SIZE = { width: 1600, height: 900 } as const;

/** Softwarové renderery. Na žádném z nich se snímková frekvence nesoudí. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softwarerasterizer|software adapter/i;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

test('cílový snímek se vykreslí, drží rozpočet a nesáhne na model ani API', async ({ page, baseURL }) => {
  test.setTimeout(120_000);

  // Síť se sleduje od začátku, ne až po načtení: emise by proběhla při montáži.
  //
  // Původ se bere z `baseURL`, ne z `page.url()`. Naměřeno: v okamžiku prvního
  // requestu je stránka pořád `about:blank`, jehož `origin` je řetězec `"null"` —
  // porovnání proti němu označí za cizí i vlastní stránku a test pak padá na
  // vlastnost, kterou nikdo neporušil.
  const pageOrigin = new URL(baseURL!).origin;
  const foreignCalls: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'data:' || url.protocol === 'blob:') return;
    if (url.pathname.startsWith('/api/') || url.origin !== pageOrigin) {
      foreignCalls.push(request.url());
    }
  });

  await page.setViewportSize({ ...FRAME_SIZE });
  await page.goto('/target');
  await expect(page.getByTestId('target-root')).toBeVisible();
  await page.waitForFunction(() => window.__target !== undefined, undefined, { timeout: 60_000 });

  const measured = await page.evaluate(async (frames) => {
    const target = window.__target!;
    const from = target.frames();
    while (target.frames() < from + frames) {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    return { stats: target.stats(), frameTimes: target.frameTimes() };
  }, SETTLE_FRAMES);

  const { stats } = measured;
  const p50 = median(measured.frameTimes);
  console.log(
    `[target-frame] ${String(stats.triangles)} trojúhelníků, ${String(stats.calls)} volání, ` +
      `${String(stats.lights)} světla, medián snímku ${p50.toFixed(1)} ms, ovladač ${stats.renderer}`,
  );

  // Rig. Snímek bez stínů a bez ACES není ten snímek, o kterém se rozhoduje.
  expect(stats.toneMapping, 'tone mapping musí být ACES Filmic').toBe(ACESFilmicToneMapping);
  expect(stats.toneMappingExposure, 'ACES bez korekce expozice scénu ztmaví').toBeGreaterThan(1);
  expect(stats.shadowMapEnabled, 'bez stínové mapy se nic nedotýká hladiny').toBe(true);
  expect(stats.shadowMapType, 'renderer musí mít ten druh mapy, který mu nastavíme').toBe(
    WORLDSTREAM_SHADOW_MAP_TYPE,
  );
  // three 0.185.1 si zastaralý `PCFSoftShadowMap` při prvním snímku přepíše na
  // tvrdý `PCFShadowMap`. Nastavit ho tedy nestačí, musí se změřit.
  expect(stats.shadowMapType, 'zastaralý typ si three přepíše na tvrdý sám').not.toBe(
    PCFSoftShadowMap,
  );
  expect(stats.antialias, 'kontext musí mít vyhlazování hran').toBe(true);
  expect(
    stats.lights,
    'rig je tři směrová a jedno polokulové — páté světlo je změna návrhu, ne detail',
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxLights);

  // Rozpočet. Horní strop je AC úlohy, spodní podlaha hlídá měření samo:
  // prázdné plátno by strop splnilo se stem procent rezervy.
  expect(stats.triangles, 'plátno, které nic nenakreslilo, o snímku netvrdí nic').toBeGreaterThan(0);
  expect(stats.calls, 'nula kreslicích volání znamená prázdnou scénu').toBeGreaterThan(0);
  expect(
    stats.triangles,
    `cílový snímek překračuje strop trojúhelníků: ${stats.triangles} za snímek ` +
      `(číslo sčítá i stínový průchod, takže je zhruba dvojnásobek scény)`,
  ).toBeLessThanOrEqual(KIT_BUDGETS.maxTrianglesPerWorld);
  expect(
    stats.calls,
    `cílový snímek překračuje strop kreslicích volání na snímek: ${stats.calls}`,
  ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxDrawCallsPerFrame);

  // Scéna je ručně napsaná: žádný backend, žádné stažené váhy, žádný cizí původ.
  expect(foreignCalls, 'cílový snímek nesmí sáhnout na model ani na API').toEqual([]);

  // Snímková frekvence jen tam, kde ji lze změřit. Viz hlavička.
  const software = SOFTWARE_RENDERER.test(stats.renderer);
  expect(measured.frameTimes.length, 'bez historie snímků se medián spočítat nedá').toBeGreaterThan(
    SETTLE_FRAMES / 2,
  );
  if (software) {
    test.info().annotations.push({
      type: 'skipped-assertion',
      description:
        `snímková frekvence se nesoudí: ovladač je ${stats.renderer}, medián snímku ` +
        `${p50.toFixed(1)} ms. Software renderer o výkonu na GPU netvrdí nic.`,
    });
  } else {
    expect(
      p50,
      `medián snímku je ${p50.toFixed(1)} ms na ovladači ${stats.renderer}, tedy pod 50 fps`,
    ).toBeLessThanOrEqual(MAX_MEDIAN_FRAME_MS);
  }

  // Obraz je deliverable brány K0 — člověk se na něj dívá, stroj o něm nesoudí nic.
  const shot = resolve(process.cwd(), 'docs/target-frame.png');
  mkdirSync(dirname(shot), { recursive: true });
  await page.screenshot({ path: shot, animations: 'disabled' });
});
