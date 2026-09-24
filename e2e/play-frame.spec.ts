import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Hrdina a cíl v záběru (P27A T6). Každé arkádové ovládání z fixture, na
 * telefonu (390×844) i na počítači (1280×800): v 1., 3. a 5. sekundě musí
 * být střed hrdiny i nejbližšího cíle/hrozby v záběru (|x|, |y| ≤ 0,95 NDC)
 * a hrdina větší než 24 px. Čísla dává `window.__playFrame()` – promítnutí
 * kvádrů objektů skutečnou kamerou scény, ne odhad z atributu. Screenshoty
 * jdou do `test-results/` jako podklad pro lidskou kontrolu.
 *
 * Hra se nehraje: ovládání, která čekají na první ťuk (poletování, střelnice,
 * načasování, rytmus, souboj), dostanou jediný mezerník na start a dál nic.
 * Když běh bez vstupu skončí dřív než v 5. s (ptáček spadne, běžec narazí),
 * měří se poslední snímek – scéna i kamera zůstávají, jak hra skončila.
 *
 * `tap_go` (mřížka v `PlayShell`) arkádové plátno nemá a sem nepatří.
 */

const FIXTURES = ['runner', 'platform', 'flap', 'steer', 'arena', 'shooter', 'throw', 'timing', 'rhythm', 'duel'] as const;

/** Stejná množina jako `TAP_TO_START` v ArcadePlay.tsx; mezerník je u všech pěti start. */
const TAP_TO_START = new Set(['flap', 'shooter', 'timing', 'rhythm', 'duel']);

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

const EDGE = 0.95;
const MIN_HERO_PX = 24;
const SECONDS = [1, 3, 5] as const;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly sizePx: number;
  readonly behind: boolean;
}
interface Report {
  readonly control: string;
  readonly hero: Box | null;
  readonly target: Box | null;
  readonly targets: number;
}

async function publish(request: APIRequestContext, fixture: string): Promise<string> {
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${fixture}.json`), 'utf8')) as { control: string };
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

const probe = (page: Page): Promise<Report> => page.evaluate(() => window.__playFrame!() as unknown as Report);

function checkBox(label: string, box: Box | null, hero: boolean): void {
  expect.soft(box, `${label}: nothing drawn`).not.toBeNull();
  if (box === null) return;
  expect.soft(box.behind, `${label}: behind the camera`).toBe(false);
  expect.soft(Math.abs(box.x), `${label}: x ${box.x.toFixed(3)} out of frame`).toBeLessThanOrEqual(EDGE);
  expect.soft(Math.abs(box.y), `${label}: y ${box.y.toFixed(3)} out of frame`).toBeLessThanOrEqual(EDGE);
  if (hero) expect.soft(box.sizePx, `${label}: ${box.sizePx.toFixed(1)} px is too small`).toBeGreaterThan(MIN_HERO_PX);
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const fixture of FIXTURES) {
      test(`${fixture}: hero and target stay in frame`, async ({ page, request }) => {
        const url = await publish(request, fixture);
        await page.goto(url);
        const stage = page.getByTestId('arcade-stage');
        await expect(stage).toBeVisible();
        await page.locator('canvas').first().waitFor();
        await page.waitForFunction(() => typeof window.__playFrame === 'function');
        const control = (await stage.getAttribute('data-control')) ?? '';
        // Modely se dotahují; první měření až po prvním vykresleném hrdinovi (načasování ho má až po startu).
        if (TAP_TO_START.has(control)) await page.keyboard.press('Space');
        await page.waitForFunction(() => window.__playFrame!().hero !== null, undefined, { timeout: 10_000 }).catch(() => undefined);
        const start = Date.now();
        const samples: { second: number; report: Report }[] = [];
        for (const second of SECONDS) {
          const wait = start + second * 1000 - Date.now();
          if (wait > 0) await page.waitForTimeout(wait);
          const report = await probe(page);
          samples.push({ second, report });          await stage.screenshot({ path: test.info().outputPath(`${fixture}-${viewport.name}-${second}s.png`) });
          checkBox(`${control} ${viewport.name} ${second}s hero`, report.hero, true);
          checkBox(`${control} ${viewport.name} ${second}s target (${report.targets} candidates)`, report.target, false);
        }
        await test.info().attach('frame.json', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
      });
    }
  });
}
