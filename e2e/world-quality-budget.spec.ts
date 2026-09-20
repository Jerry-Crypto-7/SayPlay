import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import catalog from '../src/assets/catalog.json';
import { commitPart } from '../src/ir/revision';
import { sealSimHash } from '../src/ir/worlddoc';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import surface from '../evals/reality-compiler/museum.sim.json';
import { blueprintSchema } from '../src/worldstream/schema';

/**
 * **A2 — rozpočtový běh v prohlížeči nad uloženým světem.**
 *
 * Jeden deterministický běh produkčního buildu, **bez modelu**: blueprint je
 * uložená fixture, odpovědi relace obsluhuje `page.route()`. Zapisuje, co
 * renderer doopravdy udělal — draw cally včetně stínového průchodu,
 * trojúhelníky, čas snímku, stahování a dekódování assetů a paměť — a to
 * **zvlášť pro oba srovnávací pohledy**, protože každý má vlastní WebGL
 * kontext a jejich součet není to, co stojí jeden z nich.
 *
 * **Čím to NENÍ.** Není to brána G-P. Měří se na stroji, který zrovna pustil
 * sadu; jeho GPU a rozlišení jsou v JSONu a je tam i věta, že to není cílový
 * notebook v 1080p. Čísla odsud se nesmějí citovat jako důkaz výkonu na
 * cílovém hardwaru.
 */

const RUN_ID = new Date()
  .toISOString()
  .replace(/[-:T]/g, '')
  .slice(0, 12)
  .replace(/^(\d{8})(\d{4})$/, '$1-$2');
const OUT_DIR = join(process.cwd(), 'plans', 'P20', 't10-budget');

const NOT_TARGET_HARDWARE =
  'Not G-P evidence. Measured on whatever machine ran the suite, not on the recorded reference notebook at 1080p. GPU render queries are per WebGL context; the CPU asset cache is shared while GPU buffers are not.';

/** Prostředí běhu. Bez jména GPU a rozlišení je naměřený čas neinterpretovatelný. */
async function environmentOf(page: Page) {
  const browser = page.context().browser();
  return {
    ...(await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      const gpu = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
      const vendor = gl && info ? String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)) : null;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
      return {
        gpu,
        vendor,
        userAgent: navigator.userAgent,
        devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
      };
    })),
    browser: browser ? `${browser.browserType().name()} ${browser.version()}` : null,
    rendererMode: process.env.E2E_RENDERER ?? 'platform-default',
    temperatureAndLoad: 'not measured',
  };
}

/**
 * Uložený svět a nascriptovaná relace. Žádné volání modelu: `sessions` vrací
 * hotový blueprint, `changes` hotový náhled a `commit` skutečnou patch bránu.
 */
async function storedWorld(page: Page) {
  const sim = structuredClone(surface);
  Object.entries(sim.rules).forEach(([id, rule]) => Object.assign(rule, { id }));
  const terminal = catalog.assets.find((item) => item.assetId === 'desktop-terminal')!;
  const terminalBounds = { min: [2, 0, 2], max: [3.1, 0.8, 2.65] };
  let blueprint = blueprintSchema.parse({
    version: 'worldstream-v2',
    sessionSeed: 4021,
    title: 'Budget run fixture',
    intent: EXAMPLE_PLAN.intent,
    geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry,
    shapes: [],
    world: sealSimHash({
      irVersion: 'v1',
      simRevision: 0,
      lookRevision: 0,
      sim,
      look: EXAMPLE_BLUEPRINT_ANSWER.world.look,
    }),
    objects: [
      {
        stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
        source: { kind: 'geom', node: 5 },
        targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] },
      },
      {
        stableId: 'alarmSignal', label: 'alarm terminal', synonyms: [], role: 'hero', importance: 3,
        source: { kind: 'asset', assetId: terminal.assetId, version: terminal.version, hash: terminal.hash },
        targetBounds: terminalBounds,
        binding: { collider: terminalBounds, sockets: [], parts: [], signalFlag: 'alarm' },
      },
    ],
  });
  const id = '22222222-3333-4444-5555-666666666666';

  await page.route('**/api/worldstream/sessions', (route) => {
    if (route.request().postDataJSON()?.live === true) return route.fulfill({ status: 503, body: '{}' });
    return route.fulfill({
      status: 202,
      json: {
        sessionId: id,
        events: `/api/worldstream/sessions/${id}/events`,
        snapshot: `/api/worldstream/sessions/${id}`,
        authored: { match: 'exact' },
      },
    });
  });
  await page.route(`**/api/worldstream/sessions/${id}/events*`, (route) => {
    const frame = (sequence: number, type: string, payload: unknown) =>
      `data: ${JSON.stringify({ sessionId: id, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {}),
    });
  });
  await page.route(`**/api/worldstream/sessions/${id}/changes`, (route) =>
    route.fulfill({
      json: {
        changeId: 'alarm-change',
        summary: 'The first sensor activates the alarm.',
        target: { stableId: 'visitor', label: 'sensor countdown' },
        scope: { shape: false, behavior: 1, appearance: 0 },
        preserved: ['visitor', 'case', 'alarm'],
        authored: { match: 'exact' },
      },
    }),
  );
  await page.route(`**/api/worldstream/sessions/${id}/changes/alarm-change/commit`, (route) => {
    const result = commitPart(blueprint.world, {
      part: 'sim',
      baseRevision: 0,
      operations: [
        { op: 'replace', path: '/rules/start_countdown/actions/0', value: { kind: 'setFlag', ref: 'alarm', value: true } },
      ],
    });
    if (result.verdict !== 'COMMITTED') throw new Error('fixture patch rejected');
    blueprint = { ...blueprint, world: result.doc };
    return route.fulfill({
      json: {
        outcome: 'COMMITTED',
        stableId: 'visitor',
        summary: 'The first sensor activates the alarm.',
        revisions: {
          sim: { before: 0, after: blueprint.world.simRevision },
          look: { before: 0, after: blueprint.world.lookRevision },
        },
      },
    });
  });
  await page.route(`**/api/worldstream/sessions/${id}`, (route) =>
    route.fulfill({ json: { blueprint: structuredClone(blueprint) } }),
  );

  await page.goto('/');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('Budget run fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
}

test('a stored world measures the real frame cost of both comparison viewports', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.setViewportSize({ width: 1280, height: 900 });
  await storedWorld(page);
  const environment = await environmentOf(page);

  await page.getByTestId('runtime-action').selectOption({ label: 'activate sensorA (visitor)' });
  await page.getByTestId('runtime-act').click();
  await page.getByTestId('runtime-pause').click();
  const tick = Number(await page.getByTestId('runtime-tick').getAttribute('data-tick'));
  await page.getByTestId('rewind-before-action').click();
  await page.getByTestId('refine-input').fill('The first sensor activates the alarm.');
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
  await page.getByText('Exact simulation times', { exact: true }).click();
  await page.getByTestId('branch-observation-input').fill(String(tick + 40));
  await page.getByTestId('change-apply').click();

  await expect(page.getByTestId('future-views')).toBeVisible();
  const canvases = page.getByTestId('future-views').locator('canvas');
  await expect(canvases).toHaveCount(2);
  // Dekódování assetu a první úplný průchod včetně stínové mapy.
  await page.waitForTimeout(1500);

  const views = await canvases.evaluateAll((elements) =>
    Promise.all(
      elements.map(async (element, index) => {
        const canvas = element as HTMLCanvasElement;
        const probe = canvas.__worldstreamStage!;
        // Interval mezi snímky TOHOTO plátna, ne tik rAF stránky: dvě plátna
        // sdílejí jednu smyčku a počítat je dohromady by z každého udělalo
        // polovinu.
        const intervals: number[] = [];
        let previous: number | null = null;
        let frame = probe.frames();
        await new Promise<void>((resolve) => {
          const deadline = setTimeout(resolve, 8_000);
          const sample = (now: number) => {
            const next = probe.frames();
            if (next > frame) {
              if (previous !== null) intervals.push(now - previous);
              previous = now;
              frame = next;
            }
            if (intervals.length >= 90) {
              clearTimeout(deadline);
              resolve();
            } else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        const sorted = [...intervals].sort((a, b) => a - b);
        const quantile = (q: number) =>
          sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] : null;
        const quality = probe.quality();
        return {
          side: index === 0 ? 'original' : 'changed',
          // `gl.info.render.calls` sčítá i stínový průchod — každý vrhající
          // objekt se kreslí dvakrát. Je to účet za poslední snímek.
          drawCalls: quality?.drawCalls ?? null,
          triangles: quality?.triangles ?? null,
          tier: quality?.tier ?? null,
          budget: quality?.budget ?? null,
          pixelRatio: quality?.pixelRatio ?? null,
          drawingBufferPixels: quality?.drawingBufferPixels ?? null,
          canvas: { width: canvas.width, height: canvas.height },
          frameTimeMs: { samples: intervals.length, median: quantile(0.5), p95: quantile(0.95) },
          renderTiming: await probe.measureRender(60),
          memory: probe.memory(),
          streaming: probe.streaming(),
          assetLoads: probe.assetLoads().map((timing) => ({
            assetId: timing.assetId, level: timing.level, bytes: timing.bytes,
            status: timing.status, totalMs: timing.totalMs, phases: timing.phases,
          })),
          camera: probe.camera(),
        };
      }),
    ),
  );

  expect(views).toHaveLength(2);
  for (const view of views) {
    expect(view.drawCalls).toBeGreaterThan(0);
    expect(view.triangles).toBeGreaterThan(0);
    expect(view.frameTimeMs.samples).toBeGreaterThan(0);
    // Rozpočet §23 je to jediné, co tenhle běh soudí. Výkon na cílovém
    // notebooku zůstává otevřený a je to v JSONu napsané.
    expect(view.drawCalls!).toBeLessThanOrEqual(view.budget!.maxDrawCalls);
  }
  // Jedna kamera, dva pohledy: rozdíl v ceně nesmí být rozdíl v tom, kam se
  // kdo dívá.
  expect(views[0].camera).toEqual(views[1].camera);
  expect(errors).toEqual([]);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, `${RUN_ID}.json`),
    JSON.stringify(
      {
        runId: RUN_ID,
        measuredAt: new Date().toISOString(),
        provenance: 'production build, stored blueprint, scripted session, no model call',
        notTargetHardware: NOT_TARGET_HARDWARE,
        environment,
        views,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: info.outputPath('two-view-budget.png') });
});

test('re-entering three zones does not grow the live resource count', async ({ page }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/dev/asset-hot-swap?zones=1');
  await expect.poll(() => page.evaluate(() => window.__worldstreamStage?.slots().length ?? 0)).toBe(6);

  type Visit = {
    readonly zone: number;
    readonly streaming: { readonly cacheEntries: number };
    readonly memory: { readonly geometries: number; readonly textures: number };
  };
  const visits: Visit[] = [];
  for (const zone of [1, 2, 3, 1, 2, 3, 1]) {
    await page.getByRole('button', { name: `Zone ${zone}`, exact: true }).click();
    const ids = [`listener${(zone - 1) * 2 + 1}`, `listener${(zone - 1) * 2 + 2}`];
    await expect
      .poll(
        () =>
          page.evaluate(
            (ids) =>
              window
                .__worldstreamStage!.slots()
                .filter((slot) => ids.includes(slot.stableId))
                .every((slot) => slot.rung === 'g3-ready' && slot.contentHash !== null),
            ids,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    visits.push(
      (await page.evaluate(
        (zone) => ({
          zone,
          streaming: window.__worldstreamStage!.streaming(),
          memory: window.__worldstreamStage!.memory(),
        }),
        zone,
      )) as Visit,
    );
  }

  // **To jediné tvrzení téhle části.** Sedm návštěv tří zón; kdyby se při
  // každém návratu zakládal nový resource místo znovupoužití, rostly by tyhle
  // počty s pořadím návštěvy. Rozhoduje vrchol obou koleček, ne poslední
  // vzorek: jeden uklizený snímek by jinak schoval růst uprostřed.
  const peak = (rows: readonly Visit[], read: (row: Visit) => number) => Math.max(...rows.map(read));
  const reads: ((row: Visit) => number)[] = [
    (row) => row.streaming.cacheEntries,
    (row) => row.memory.geometries,
    (row) => row.memory.textures,
  ];
  for (const read of reads) expect(peak(visits.slice(3), read)).toBeLessThanOrEqual(peak(visits.slice(0, 3), read));
  expect(errors).toEqual([]);

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    join(OUT_DIR, `${RUN_ID}-zones.json`),
    JSON.stringify(
      {
        runId: RUN_ID,
        measuredAt: new Date().toISOString(),
        route: '/dev/asset-hot-swap?zones=1',
        notTargetHardware: NOT_TARGET_HARDWARE,
        environment: await environmentOf(page),
        visits,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: info.outputPath('zone-return-budget.png') });
});
