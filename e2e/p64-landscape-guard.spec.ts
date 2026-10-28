import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { type APIRequestContext, type Browser, devices, expect, type Page, test } from '@playwright/test';

import type { CameraPrint } from '../src/components/play/arcade/ArcadeStage';
import { P64_CELLS } from './p64-cells';

/**
 * Stráž desktopu a šířky (P64 T1): P64 mění rámování jen na výšku (`camera.aspect < 1`). Otisk kamery (`__playFrame()
 * .camera` – poloha, kvaternion, zorné pole, poměr stran a projekční matice) po 30, 90 a 180 tikách robota na každé
 * buňce `p64-cells.ts` se musí shodovat s `evals/play/p64/landscape-baseline.json` do `TOLERANCE`. Na `chromium`
 * 1280 × 720, na `pixel7-touch` týž telefon na šířku.
 *
 * Kamera se po tiku ustálí, než se čte: úvodní průlet a dojezdy kamer běží po snímcích (wall-clock), stav hry po
 * tikách. Otisk se čte, až se dva snímky po sobě liší míň než `SETTLED`. `P64_GUARD=write` zapíše výchozí stav.
 */

const OUT = 'evals/play/p64/landscape-baseline.json';
const WRITE = process.env.P64_GUARD === 'write';
const AT = [30, 90, 180] as const;
const TOLERANCE = 1e-4;
const SETTLED = 1e-7;
/** Nejvíc snímků čekání na ustálení (~8 s). Aréna, úkol, plošinovka a přeskákání dojíždějí 150–200 snímků (T1). */
const SETTLE_FRAMES = 480;

const VIEWS: Readonly<Record<string, string | null>> = { chromium: null, 'pixel7-touch': 'Pixel 7 landscape' };

interface HandProbe {
  byHand(on: boolean): void;
  tickByHand(): { readonly runState: string };
}
interface Print {
  readonly tick: number;
  readonly settledAfter: number;
  readonly camera: CameraPrint;
}
type Baseline = Record<string, Record<string, readonly Print[]>>;

const numbersOf = (camera: CameraPrint): number[] => [...camera.position, ...camera.quaternion, camera.fov ?? 0, camera.aspect ?? 0, ...camera.projection];

async function prints(page: Page): Promise<Print[]> {
  await page.waitForFunction(() => typeof (window.__playShell as unknown as HandProbe | undefined)?.byHand === 'function' && typeof window.__playFrame === 'function', undefined, { timeout: 60_000 });
  await page.evaluate(() => (window.__playShell as unknown as HandProbe).byHand(true));
  await page.getByTestId('play-pause').click();
  await page.getByTestId('play-demo-start').click({ timeout: 30_000 });
  return page.evaluate(
    async ({ at, settled, frames }) => {
      const frame = () => new Promise((done) => requestAnimationFrame(() => done(undefined)));
      const flat = (c: CameraPrint): number[] => [...c.position, ...c.quaternion, c.fov ?? 0, c.aspect ?? 0, ...c.projection];
      const out: Print[] = [];
      let tick = 0;
      for (const until of at) {
        for (; tick < until; tick += 1) {
          const state = (window.__playShell as unknown as HandProbe).tickByHand();
          await frame();
          if (state.runState !== 'running') break;
        }
        let last = window.__playFrame!().camera;
        let n = 0;
        for (; n < frames; n += 1) {
          await frame();
          const next = window.__playFrame!().camera;
          const a = flat(last);
          const moved = flat(next).some((value, i) => Math.abs(value - a[i]!) > settled);
          last = next;
          if (!moved) break;
        }
        out.push({ tick, settledAfter: n, camera: last });
      }
      return out;
    },
    { at: [...AT], settled: SETTLED, frames: SETTLE_FRAMES },
  );
}

async function measure(browser: Browser, page: Page, view: string | null, baseURL: string, url: string): Promise<Print[]> {
  if (view === null) {
    await page.goto(url);
    return prints(page);
  }
  const { defaultBrowserType: _browser, ...use } = devices[view]!;
  const context = await browser.newContext({ ...use, baseURL });
  try {
    const phone = await context.newPage();
    await phone.goto(url);
    return await prints(phone);
  } finally {
    await context.close();
  }
}

const readBaseline = (): Baseline => (existsSync(OUT) ? ((JSON.parse(readFileSync(OUT, 'utf8')) as { prints?: Baseline }).prints ?? {}) : {});

function record(project: string, key: string, printed: readonly Print[]): void {
  const all = readBaseline();
  const byProject = (all[project] ??= {});
  byProject[key] = printed;
  all[project] = Object.fromEntries(P64_CELLS.filter((c) => byProject[c.key] !== undefined).map((c) => [c.key, byProject[c.key]!]));
  const about = {
    plan: 'P64 T1',
    measure: 'e2e/p64-landscape-guard.spec.ts',
    what: 'camera print (world position, quaternion, fov, aspect, projection matrix) after 30, 90 and 180 robot ticks, read once the camera settles; chromium 1280x720 and Pixel 7 landscape',
    tolerance: TOLERANCE,
  };
  writeFileSync(OUT, `${JSON.stringify({ about, prints: all }, null, 1)}\n`);
}

async function publish(request: APIRequestContext, spec: unknown): Promise<string> {
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

test.describe('P64 landscape and desktop camera guard', () => {
  test.setTimeout(180_000);

  for (const cell of P64_CELLS) {
    test(`${cell.key}: the camera print matches the baseline`, async ({ browser, page, request }, testInfo) => {
      const project = testInfo.project.name;
      test.skip(!(project in VIEWS), 'chromium and pixel7-touch only');
      const url = await publish(request, cell.spec);
      const printed = await measure(browser, page, VIEWS[project]!, testInfo.project.use.baseURL!, url);
      expect(printed).toHaveLength(AT.length);
      if (WRITE) record(project, cell.key, printed);

      const baseline = readBaseline()[project]?.[cell.key];
      expect(baseline, `no baseline for ${project} ${cell.key} – run with P64_GUARD=write`).toBeDefined();
      for (const [i, print] of printed.entries()) {
        const want = baseline![i]!;
        expect(print.tick, 'tick').toBe(want.tick);
        expect(print.settledAfter, `camera did not settle by tick ${String(print.tick)}`).toBeLessThan(SETTLE_FRAMES);
        const got = numbersOf(print.camera);
        const drift = Math.max(...numbersOf(want.camera).map((value, j) => Math.abs(value - got[j]!)));
        expect(drift, `${cell.key} camera at tick ${String(print.tick)}: ${JSON.stringify(print.camera)} vs ${JSON.stringify(want.camera)}`).toBeLessThanOrEqual(TOLERANCE);
      }
    });
  }
});
