import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type APIRequestContext, devices, expect, type Page, test } from '@playwright/test';

import type { RenderReport } from '../src/components/play/arcade/ArcadeStage';
import { arenaGenre } from '../src/play/genre/arena';
import { compileGenre, readGenreSpec } from '../src/play/genre/index';
import type { GameSpecV1 } from '../src/play/spec';

/**
 * Výkon na telefonu (P35 T4). Přejímka O10 změřila na Pixel 7 se 4× CPU kočičí
 * arénu na 15,5 FPS (ostatní hry 49–60).
 *
 * Příčina: „glowing fish“ kreslí model akvária – 19 sítí, sklo a voda průhledné.
 * `mergeBody` (`look/load.ts`) slévá tělo do jedné sítě, jen když jsou všechny
 * materiály obyčejné; průhledné akvárium nechal celé, takže 14 ryb stálo 266 sítí,
 * ~180 kreslicích volání a ~70 přepnutí programu na snímek (tučňák 58 a 23).
 *
 * Test hlídá počet viditelných sítí scény (`__playRender().meshes`), ne FPS – ty na
 * sdíleném stroji kolísají – a ne `calls`, které mění úroveň kvality (stínový výřez,
 * průchody postprocessingu).
 */

const SENTENCES = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p32/sentences.json'), 'utf8')) as { sentences: { id: string; text: string; hero: string }[] }).sentences;

/** Rychlá verze bez modelu, jako `p32-arena`. */
function arenaSpec(id: 'cat'): GameSpecV1 {
  const sentence = SENTENCES.find((entry) => entry.id === id)!;
  const read = readGenreSpec({ hero: sentence.hero, ...arenaGenre.draftFill(sentence.text, null) });
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileGenre(read.value);
}

async function publishSpec(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/**
 * Sonda kreslení, až se dotáhnou modely: počet sítí se 1,5 s nezměnil. Hra stojí
 * na tiku 0 pod „Tap to start“, všechny věci leží, pronásledovatel ještě nevyrazil.
 */
async function settledRender(page: Page): Promise<RenderReport> {
  await page.waitForFunction(() => window.__playRender !== undefined && window.__playRender().calls > 0, undefined, { timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  let last = -1;
  let since = Date.now();
  const deadline = Date.now() + 20_000;
  for (;;) {
    const report = await page.evaluate(() => window.__playRender!());
    if (report.meshes !== last) {
      last = report.meshes;
      since = Date.now();
    } else if (Date.now() - since >= 1500 || Date.now() > deadline) return report;
    await page.waitForTimeout(250);
  }
}

/**
 * Strop sítí kočičí arény: po opravě ~155 (akvárium slité po materiálech 6 sítí × 14),
 * před ní ~350. Tučňák, který na telefonu drží 54+ FPS, jich kreslí ~75.
 */
const CAT_MESHES = 200;

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

test.describe('phone performance, Pixel 7 with CPU 4× slower', () => {
  test.use(PIXEL_7);

  test('cat arena draws each glowing fish as a few merged meshes', async ({ page, request, context }) => {
    test.setTimeout(180_000);
    const url = await publishSpec(request, arenaSpec('cat'));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(url);
    const report = await settledRender(page);
    const tier = await page.getByTestId('arcade-stage').getAttribute('data-quality');
    const line = `cat: ${report.meshes} sítí, ${report.calls} volání, ${report.triangles} trojúhelníků, úroveň ${String(tier)}`;
    test.info().annotations.push({ type: 'render', description: line });
    console.log(line);
    // Modely se opravdu kreslí: náhradní kvádry by strop splnily zadarmo.
    expect(report.triangles, 'modely kočky, medvěda a ryb jsou ve scéně').toBeGreaterThan(5000);
    expect(report.meshes, 'viditelné sítě kočičí arény').toBeLessThanOrEqual(CAT_MESHES);
  });
});
