/**
 * P83A T5: úvodní karta pěti vět soudu na telefonu 390×844 (dotyk, „Tap to start“) i na desktopu 1366×768 – snímek
 * karty a míry: zmenšení karty (`--_prompt-scale` = šířka v obraze / šířka v rozvržení), nejmenší písmo v kartě po
 * zmenšení v px, přetečení (karta mimo obraz, řádek širší než svůj box) a kolik je v kartě „Tap to start“.
 * Jen pozorování; do repa nic nepíše.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p83/a-card.ts \
 *     --port 3211 --out D:/tmp/p83a --tag before
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { chromium, devices } from '@playwright/test';

import { JUDGE_FIVE } from './a-judge5';

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
};
const port = flag('--port', '3211');
const out = flag('--out', 'D:/tmp/p83a');
const tag = flag('--tag', 'before');
const base = `http://127.0.0.1:${port}`;
const IDS = ['knight', 'shop', 'solar', 'marble', 'penguin'] as const;

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--disable-features=OpenXR'] });
const { defaultBrowserType: _ignored, ...pixel } = devices['Pixel 7'];
const screens = [
  { name: 'phone', options: { ...pixel, viewport: { width: 390, height: 844 } } },
  { name: 'desktop', options: { viewport: { width: 1366, height: 768 } } },
] as const;

for (const screen of screens) {
  const page = await (await browser.newContext(screen.options)).newPage();
  for (const [index, sentence] of JUDGE_FIVE.entries()) {
    const id = IDS[index]!;
    const created = await page.request.post(`${base}/api/play/games`, { data: { sentence }, headers: { 'x-forwarded-for': `198.51.100.${String(80 + index)}` } });
    if (created.status() >= 300) {
      console.log(JSON.stringify({ screen: screen.name, id, error: `${String(created.status())} ${(await created.text()).slice(0, 200)}` }));
      continue;
    }
    const { url } = (await created.json()) as { url: string };
    await page.goto(`${base}${new URL(url, base).pathname}`);
    await page.locator('[data-testid="arcade-stage"] canvas').first().waitFor({ timeout: 90_000 });
    await page.locator('.play-first-prompt').first().waitFor({ timeout: 90_000 });
    await page.waitForTimeout(2500);
    const shot = join(out, `card-${tag}-${screen.name}-${id}.png`);
    await page.screenshot({ path: shot });
    const facts = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.play-first-prompt')!;
      const rect = card.getBoundingClientRect();
      const scale = rect.width / card.offsetWidth;
      let minFont = Infinity;
      let minFontText = '';
      const wide: string[] = [];
      for (const element of card.querySelectorAll<HTMLElement>('*')) {
        const own = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
        if (!own || element.getClientRects().length === 0) continue;
        const px = Number.parseFloat(getComputedStyle(element).fontSize) * scale;
        if (px < minFont) {
          minFont = px;
          minFontText = (element.textContent ?? '').trim().slice(0, 40);
        }
        if (element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).display !== 'inline') wide.push((element.textContent ?? '').trim().slice(0, 30));
      }
      const outside = rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight;
      const starts = [...card.querySelectorAll('*')].filter((element) => /^(Tap to start|Click to start|Click or press Space)$/.test((element.textContent ?? '').trim())).length;
      const stage = card.closest<HTMLElement>('.play-stage');
      return {
        at: stage?.dataset.promptAt ?? 'center',
        scale: Number(scale.toFixed(3)),
        card: `${String(Math.round(rect.width))}x${String(Math.round(rect.height))}@${String(Math.round(rect.left))},${String(Math.round(rect.top))}`,
        minFontPx: Number(minFont.toFixed(1)),
        minFontText,
        outside,
        wide,
        starts,
      };
    });
    console.log(JSON.stringify({ screen: screen.name, id, ...facts, shot }));
  }
  await page.context().close();
}
await browser.close();
