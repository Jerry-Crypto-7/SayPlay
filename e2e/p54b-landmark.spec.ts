import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import type { FrameReport } from '../src/components/play/arcade/ArcadeStage';
import type { LandmarkReport } from '../src/components/play/arcade/look/Landmark';

/**
 * Orientační bod v záběru (P54B T8): 18 vět na žánr (`evals/play/p46g/genres.json`) projde
 * skutečnými dveřmi `POST /api/play/games`, ukázka robota se odtiká ručními hodinami do
 * tiku 150 (jako `scripts/play-look-shots.mjs shots`) a sonda `__playLandmark` promítne
 * skupinu `userData.landmark` živou kamerou. Bod mimo záběr se nikde neprojeví chybou –
 * proto počet: v záběru aspoň 16 z 18 snímků. Hrdinu bod ani rámující kusy nezakryjí:
 * z paprsků kamery, které trefí hrdinu, jich ≥ 90 % netrefí nic z T8 dřív (hrdina je vidět
 * aspoň z 90 % plochy jako před úlohou – T8 kameru nemění, přidává jen tyhle kusy).
 * Kusy nevrhají stín, takže jejich viditelné sítě jsou všechna kreslicí volání navíc: ≤ 3.
 *
 * `LANDMARK_REPORT=<cesta>` zapíše výsledek všech 18 snímků do JSON, `LANDMARK_SHOTS=<adresář>` je vyfotí.
 */

interface Sentence {
  readonly id: string;
  readonly text: string;
  readonly control: string;
}

const GENRES: readonly Sentence[] = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p46g/genres.json'), 'utf8')) as { sentences: Sentence[] }).sentences;
const TICKS = 150;
const LEAST_IN_VIEW = 16;
const HERO_VISIBLE = 0.9;
const MOST_CALLS = 3;

interface Row {
  readonly id: string;
  readonly control: string | null;
  readonly tick: number | null;
  readonly landmark: string | null;
  readonly scale: number | null;
  readonly distance: number | null;
  readonly inFrame: number | null;
  readonly inView: boolean;
  readonly framing: readonly { readonly id: string; readonly inFrame: number }[];
  readonly calls: number;
  readonly heroVisible: number | null;
  readonly heroSamples: number;
  readonly heroHeightPx: number | null;
  readonly error?: string;
}

interface HandShell {
  byHand(on: boolean): void;
  tickByHand(): { readonly tick: number; readonly runState: string };
}

/** Modely dotažené: počet sítí scény se 1,5 s nezměnil (jako `settle` ve skriptu snímků). */
async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => (window.__playRender?.().calls ?? 0) > 0, undefined, { timeout: 60_000 });
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const meshes = await page.evaluate(() => window.__playRender!().meshes);
    if (meshes !== last) {
      last = meshes;
      since = Date.now();
    } else if (Date.now() - since >= 1500) return;
    await page.waitForTimeout(250);
  }
}

/** Ukázka robota odtikaná ručními hodinami do `TICKS`; vrací tik, na kterém stojí. */
async function demoTo(page: Page): Promise<number | null> {
  await page.waitForFunction(() => typeof (window.__playShell as unknown as HandShell | undefined)?.byHand === 'function', undefined, { timeout: 30_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandShell).byHand(true));
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
  return page.evaluate((count) => {
    let state: { tick: number; runState: string } | null = null;
    for (let index = 0; index < count; index += 1) {
      state = (window.__playShell as unknown as HandShell).tickByHand();
      if (state.runState !== 'running') break;
    }
    return state?.tick ?? null;
  }, TICKS);
}

async function measure(page: Page, sentence: Sentence, url: string): Promise<Row> {
  await page.goto(url);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await settle(page);
  const tick = await demoTo(page);
  await settle(page);
  // Model bodu se načte až po umístění; hrdina po zásahu bliká – sonda ho vidí, až blikání skončí.
  await page.waitForFunction(() => window.__playLandmark?.().landmark?.loaded === true, undefined, { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const control = await page.getByTestId('arcade-stage').getAttribute('data-control');
  const [report, frame] = await page.evaluate(() => [window.__playLandmark?.() ?? null, window.__playFrame?.() ?? null] as const) as [LandmarkReport | null, FrameReport | null];
  const shots = process.env.LANDMARK_SHOTS;
  if (shots !== undefined && shots !== '') {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${sentence.id}.png`) });
  }
  const main = report?.landmark ?? null;
  return {
    id: sentence.id,
    control,
    tick,
    landmark: main?.id ?? null,
    scale: main?.scale ?? null,
    distance: main === null ? null : Math.round(main.distance * 10) / 10,
    inFrame: main === null ? null : Math.round(main.inFrame * 100) / 100,
    inView: main?.inView ?? false,
    framing: (report?.framing ?? []).map((piece) => ({ id: piece.id, inFrame: Math.round(piece.inFrame * 100) / 100 })),
    calls: report?.calls ?? 0,
    heroVisible: report?.hero === null || report?.hero === undefined ? null : Math.round(report.hero.visible * 1000) / 1000,
    heroSamples: report?.hero?.samples ?? 0,
    heroHeightPx: frame?.hero === null || frame?.hero === undefined ? null : Math.round(frame.hero.heightPx),
  };
}

test('a landmark stands in view at tick 150 in at least 16 of 18 genre scenes and covers no hero', async ({ page, request }) => {
  test.setTimeout(GENRES.length * 120_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const rows: Row[] = [];
  for (const sentence of GENRES) {
    try {
      const response = await request.post('/api/play/games', { data: { sentence: sentence.text } });
      expect(response.status(), await response.text()).toBeLessThan(300);
      const { url } = (await response.json()) as { url: string };
      rows.push(await measure(page, sentence, url));
    } catch (error) {
      rows.push({ id: sentence.id, control: null, tick: null, landmark: null, scale: null, distance: null, inFrame: null, inView: false, framing: [], calls: 0, heroVisible: null, heroSamples: 0, heroHeightPx: null, error: String(error).slice(0, 300) });
    }
    const row = rows.at(-1)!;
    test.info().annotations.push({ type: row.id, description: `${row.control} ${row.landmark} in=${row.inFrame} view=${row.inView} framing=${row.framing.length} calls=${row.calls} hero=${row.heroVisible}${row.error === undefined ? '' : ` ERROR ${row.error}`}` });
  }
  const inView = rows.filter((row) => row.inView).length;
  const out = process.env.LANDMARK_REPORT;
  if (out !== undefined && out !== '') {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ about: 'P54B T8: landmark in view at tick 150 (e2e/p54b-landmark.spec.ts), 1280x800', measuredAt: new Date().toISOString(), ticks: TICKS, inView, of: rows.length, rows }, null, 1)}\n`);
  }
  for (const row of rows) {
    expect.soft(row.error, row.id).toBeUndefined();
    if (row.heroVisible !== null) expect.soft(row.heroVisible, `${row.id}: hrdina zakrytý`).toBeGreaterThanOrEqual(HERO_VISIBLE);
    expect.soft(row.calls, `${row.id}: kreslicí volání navíc`).toBeLessThanOrEqual(MOST_CALLS);
  }
  expect(inView, rows.filter((row) => !row.inView).map((row) => row.id).join(', ')).toBeGreaterThanOrEqual(LEAST_IN_VIEW);
});
