/**
 * P83A T3: pět vět soudu v prohlížeči nad běžícím `next start` – hra se vytvoří dveřmi (rychlá verze), záznam robota
 * (`__playShell.playWitness`) ji dohraje a snímek ukáže konec hry; vypíše, jestli je na stránce „You did it!“.
 * Jen pozorování; do repa nic nepíše.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p83/a-win-shots.ts \
 *     --port 3211 --out D:/tmp/p83a
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { JUDGE_FIVE } from './a-judge5';

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};
const port = flag('--port', '3211');
const out = flag('--out', 'D:/tmp/p83a');
const base = `http://127.0.0.1:${port}`;
const IDS = ['knight', 'shop', 'solar', 'marble', 'penguin'] as const;

interface Witness {
  readonly playWitness: () => { readonly runState: string; readonly tick: number };
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--disable-features=OpenXR'] });
const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();

for (const [index, sentence] of JUDGE_FIVE.entries()) {
  const id = IDS[index]!;
  const created = await page.request.post(`${base}/api/play/games`, { data: { sentence }, headers: { 'x-forwarded-for': `198.51.100.${String(60 + index)}` } });
  if (created.status() >= 300) {
    console.log(JSON.stringify({ id, error: `${String(created.status())} ${(await created.text()).slice(0, 200)}` }));
    continue;
  }
  const { url } = (await created.json()) as { url: string };
  await page.goto(`${base}${new URL(url, base).pathname}`);
  await page.locator('[data-testid="arcade-stage"] canvas').first().waitFor({ timeout: 90_000 });
  await page.waitForFunction(() => typeof (window as unknown as { __playShell?: Witness }).__playShell?.playWitness === 'function', undefined, { timeout: 90_000 });
  const end = await page.evaluate(() => (window as unknown as { __playShell: Witness }).__playShell.playWitness());
  await page.waitForTimeout(2500);
  const shot = join(out, `win-${id}.png`);
  await page.screenshot({ path: shot });
  const won = await page.getByText('You did it!').first().isVisible().catch(() => false);
  console.log(JSON.stringify({ id, runState: end.runState, seconds: (end.tick / 60).toFixed(1), youDidIt: won, shot }));
}
await browser.close();
