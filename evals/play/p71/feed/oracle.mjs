#!/usr/bin/env node
/**
 * P71B T5 – oracle klipů ve feedu na telefonu (390×844, dotyk) a desktopu (1280×800).
 *
 * Feed lokálního serveru (≥ 12 her) kartu po kartě (`feed-next`). Na každé kartě:
 *   - každá karta v okně prohlížeče: dva snímky jejího výřezu po 500 ms – liší se = hýbe se; náhled „Up next“
 *     se střídá s ostatními, takže se hýbe, když se jeho snímek do 10 s liší od prvního;
 *   - uprostřed swipe (reel posunutý o 40 % karty, přichycení na chvíli vypnuté): totéž pro přijíždějící kartu;
 *   - FPS aktivní karty: 2 s `requestAnimationFrame`, medián;
 *   - chyby konzole a stránky.
 * Snímek okna na každé čtvrté kartě do `oracle-<zařízení>-<n>.png`, výsledek do `oracle.json`.
 *
 *   ORACLE_URL=http://127.0.0.1:3021 node --experimental-strip-types evals/play/p71/feed/oracle.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { chromium, devices } from '@playwright/test';

await import('../../../../scripts/ts-paths.mjs');
const { browserRenderer } = await import('../../../../scripts/browser-renderer.ts');

const BASE = process.env.ORACLE_URL ?? 'http://127.0.0.1:3011';
const CARDS = Number(process.env.ORACLE_CARDS ?? 12);
/** `ORACLE_NO_CLIPS=1`: offline klipy zablokované (A/B FPS bez dekódování videí). */
const NO_CLIPS = process.env.ORACLE_NO_CLIPS === '1';
const ONLY = process.env.ORACLE_DEVICE;
/** Snímky a `oracle.json` píše jen plný běh (obě zařízení, klipy, 12 karet). */
const FULL = ONLY === undefined && !NO_CLIPS && CARDS === 12;
const DIR = new URL('./', import.meta.url);

const DEVICES = {
  // Telefon s Androidem (Chromium), rozměr okna z plánu.
  phone: { ...(({ defaultBrowserType: _ignored, ...rest }) => rest)(devices['Pixel 7']), viewport: { width: 390, height: 844 } },
  desktop: { viewport: { width: 1280, height: 800 } },
};

/** Výřezy viditelných karet: aktivní a ostatní karty reelu, náhledy „Up next“; jen část v okně. */
async function visibleCards(page) {
  return page.evaluate(() => {
    const clips = [];
    const box = (element, kind) => {
      const rect = element.getBoundingClientRect();
      const x = Math.max(0, rect.left);
      const y = Math.max(0, rect.top);
      const width = Math.min(innerWidth, rect.right) - x;
      const height = Math.min(innerHeight, rect.bottom) - y;
      if (width >= 40 && height >= 40 && width * height >= 0.3 * rect.width * rect.height) clips.push({ kind, id: element.closest('[data-version-id]')?.getAttribute('data-version-id') ?? null, clip: { x, y, width, height } });
    };
    const reel = document.querySelector('[data-testid="feed-reel"]')?.getBoundingClientRect();
    for (const card of document.querySelectorAll('[data-testid="feed-card"]')) {
      const rect = card.getBoundingClientRect();
      // Karta reelu je vidět jen v okně reelu (zbytek ořízne posuvník).
      if (reel === undefined || rect.bottom <= reel.top + 40 || rect.top >= reel.bottom - 40) continue;
      box(card, card.getAttribute('data-active') === 'true' ? 'active' : 'card');
    }
    for (const thumb of document.querySelectorAll('.play-feed-thumb')) box(thumb, 'up-next');
    return clips;
  });
}

/** Náhledy „Up next“ se střídají (`createClipTurns` v `CardClip.tsx`): hýbe se, když se pohnul do 10 s. */
const UP_NEXT_WINDOW_MS = 10_000;

async function moving(page, cards) {
  const shots = () => Promise.all(cards.map((card) => page.screenshot({ clip: card.clip })));
  const first = await shots();
  const moved = cards.map(() => false);
  const deadline = Date.now() + UP_NEXT_WINDOW_MS;
  for (let round = 0; round === 0 || (Date.now() < deadline && cards.some((card, at) => card.kind === 'up-next' && !moved[at])); round += 1) {
    await page.waitForTimeout(500);
    const next = await shots();
    // Karty reelu soudí jen první dvojice snímků po 500 ms.
    for (const [at, card] of cards.entries()) if (round === 0 || card.kind === 'up-next') moved[at] ||= !first[at].equals(next[at]);
  }
  return cards.map((card, at) => ({ kind: card.kind, id: card.id, moved: moved[at] }));
}

async function fps(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const gaps = [];
        let last = performance.now();
        const start = last;
        const tick = (now) => {
          gaps.push(now - last);
          last = now;
          if (now - start < 2000) requestAnimationFrame(tick);
          else resolve(Math.round(10000 / [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]) / 10);
        };
        requestAnimationFrame(tick);
      }),
  );
}

async function run(browser, name, options) {
  const context = await browser.newContext(options);
  if (NO_CLIPS) await context.route('**/play/feed-clips/**', (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message.split('\n')[0]));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text().split('\n')[0]));
  await page.goto(`${BASE}/play`);
  await page.getByTestId('feed-reel').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => window.__playFeed?.().mode === 'preview', undefined, { timeout: 60_000 });
  const steps = [];
  for (let n = 0; n < CARDS; n += 1) {
    await page.waitForFunction(() => ['preview', 'still'].includes(window.__playFeed?.().mode ?? ''), undefined, { timeout: 30_000 }).catch(() => null);
    await page.waitForTimeout(1500);
    const feed = await page.evaluate(() => window.__playFeed());
    const cards = await moving(page, await visibleCards(page));
    const rate = await fps(page);
    // Uprostřed swipe: reel o 40 % karty dolů, přichycení vypnuté jen na dobu snímků.
    await page.evaluate(() => {
      const reel = document.querySelector('[data-testid="feed-reel"]');
      reel.style.scrollSnapType = 'none';
      reel.scrollBy({ top: reel.clientHeight * 0.4, behavior: 'instant' });
    });
    await page.waitForTimeout(800);
    const swipe = n < CARDS - 1 ? await moving(page, (await visibleCards(page)).filter((card) => card.kind !== 'up-next')) : [];
    await page.evaluate(() => {
      const reel = document.querySelector('[data-testid="feed-reel"]');
      reel.scrollBy({ top: -reel.clientHeight * 0.4, behavior: 'instant' });
      reel.style.scrollSnapType = '';
    });
    if (FULL && n % 4 === 0) await page.screenshot({ path: fileURLToPath(new URL(`oracle-${name}-${String(n)}.png`, DIR)) });
    steps.push({ n, versionId: feed.versionId, mode: feed.mode, fpsP50: rate, cards, swipe });
    console.log(JSON.stringify({ name, n, mode: feed.mode, fpsP50: rate, moved: `${String(cards.filter((card) => card.moved).length)}/${String(cards.length)}`, swipe: swipe.map((card) => `${card.kind}:${String(card.moved)}`).join(' ') }));
    if (n < CARDS - 1) {
      await page.getByTestId('feed-next').click();
      await page.waitForFunction((id) => window.__playFeed?.().versionId !== id, feed.versionId, { timeout: 15_000 });
    }
  }
  await context.close();
  const all = steps.flatMap((step) => [...step.cards, ...step.swipe]);
  const rates = steps.map((step) => step.fpsP50).sort((a, b) => a - b);
  return {
    viewport: options.viewport,
    cards: steps.length,
    checked: all.length,
    stillCards: all.filter((card) => !card.moved),
    fpsP50Median: rates[Math.floor(rates.length / 2)],
    fpsP50Min: rates[0],
    errors,
    steps,
  };
}

const browser = await chromium.launch({ args: [...browserRenderer().args, '--disable-features=OpenXR'] });
const result = { measuredAt: new Date().toISOString(), base: BASE, method: 'Card by card via feed-next; every reel card in the viewport compared over two screenshots 500 ms apart, every Up next thumb (clips take turns) against screenshots every 500 ms for up to 10 s, also mid-swipe (reel scrolled 40 % of a card, snap off for the shots); active-card FPS = median rAF interval over 2 s; console and page errors collected.' };
try {
  for (const [name, options] of Object.entries(DEVICES)) if (ONLY === undefined || ONLY === name) result[name] = await run(browser, name, options);
} finally {
  await browser.close();
}
// Jen plný běh (obě zařízení, klipy, 12 karet) přepíše `oracle.json`; A/B běhy jen vypíšou souhrn.
if (FULL) writeFileSync(new URL('oracle.json', DIR), `${JSON.stringify(result, null, 2)}\n`);
for (const name of Object.keys(DEVICES).filter((device) => result[device] !== undefined)) {
  const device = result[name];
  console.log(JSON.stringify({ name, cards: device.cards, checked: device.checked, still: device.stillCards.length, fpsP50Median: device.fpsP50Median, fpsP50Min: device.fpsP50Min, errors: device.errors.length }));
}
