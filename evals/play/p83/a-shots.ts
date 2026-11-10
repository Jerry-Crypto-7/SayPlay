/**
 * P83A: snímky věty v prohlížeči nad běžícím `next start` – karta, pak náhodný hráč (`randomAxes`) ručními hodinami
 * a snímek ve chvíli, kdy nad scénou visí „+1“ (`.play-pop`), i na konci. Jen pozorování; do repa nic nepíše.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p83/a-shots.ts \
 *     --port 3211 --out D:/tmp/p83a --tag before [--seed 1] [--phone]
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, devices } from '@playwright/test';

import { ARCADE_HZ } from '@/play/arcade/contract';

import { JUDGE_SENTENCES } from './a-repro';
import { randomAxes } from './random-player';

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};
const port = flag('--port', '3211');
const out = flag('--out', 'D:/tmp/p83a');
const tag = flag('--tag', 'before');
const seed = Number(flag('--seed', '1'));
const phone = process.argv.includes('--phone');
const base = `http://127.0.0.1:${port}`;

interface Probe {
  byHand(on: boolean): void;
  hold(axis: number): void;
  tickByHand(): { runState: string; tick: number; items: number; score: number; health: number };
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--disable-features=OpenXR'] });
const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
const context = await browser.newContext(phone ? { ...pixel, viewport: { width: 390, height: 844 } } : { viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
const axes = Array.from(randomAxes(seed, 60 * ARCADE_HZ));

for (const [index, sentence] of JUDGE_SENTENCES.entries()) {
  const id = index === 0 ? 'knight' : 'shop';
  const name = (what: string): string => join(out, `${tag}-${id}${phone ? '-phone' : ''}-${what}.png`);
  const created = await page.request.post(`${base}/api/play/games`, { data: { sentence }, headers: { 'x-forwarded-for': `198.51.100.${String(30 + index)}` } });
  if (created.status() >= 300) throw new Error(`${id}: ${String(created.status())} ${await created.text()}`);
  const { url } = (await created.json()) as { url: string };
  await page.goto(`${base}${new URL(url, base).pathname}`);
  await page.locator('[data-testid="arcade-stage"] canvas').first().waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => typeof (window as unknown as { __playShell?: Probe }).__playShell?.byHand === 'function', undefined, { timeout: 90_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: name('card') });
  await page.evaluate(() => (window as unknown as { __playShell: Probe }).__playShell.byHand(true));
  await page.getByTestId('arcade-stage').click({ force: true });
  let popShot = false;
  let last = { runState: 'running', tick: 0, items: 0, score: 0, health: 0 };
  for (let from = 0; from < axes.length && last.runState === 'running'; from += 20) {
    last = await page.evaluate((chunk) => {
      const probe = (window as unknown as { __playShell: Probe }).__playShell;
      let now = probe.tickByHand();
      for (const axis of chunk) {
        if (now.runState !== 'running') break;
        probe.hold(axis);
        now = probe.tickByHand();
      }
      return now;
    }, axes.slice(from, from + 20));
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    if (!popShot && last.items === 0 && (await page.locator('.play-pop').count()) > 0) {
      popShot = true;
      await page.screenshot({ path: name('pop-at-zero') });
      console.log(`${id}: "+1" over the scene at ${(last.tick / ARCADE_HZ).toFixed(1)} s with items ${String(last.items)}`);
    }
    if (from === 30 * ARCADE_HZ) await page.screenshot({ path: name('30s') });
  }
  await page.screenshot({ path: name('end') });
  console.log(`${id}: ${JSON.stringify(last)} at ${(last.tick / ARCADE_HZ).toFixed(1)} s`);
}
await browser.close();
