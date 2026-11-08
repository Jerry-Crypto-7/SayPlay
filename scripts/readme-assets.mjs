#!/usr/bin/env node
/**
 * Obrázky do README (P79 T2) – složené ze snímků, které už v repu jsou, takže
 * každý obrázek má za sebou měřicí běh a jeho manifest:
 *
 * - `docs/README-assets/scenes.jpg` – šest her ze šesti vět, snímek ve 3. s
 *   ukázky robota (`evals/play/p76/after`, P76, 7. 11. 2026), pod každou věta.
 * - `docs/README-assets/start-card.jpg` – karta před startem na telefonu:
 *   jak hra větu přečetla a co prověřil robot (týž běh, `s6-phone-0start.jpg`).
 *
 * ```
 * node scripts/readme-assets.mjs
 * ```
 *
 * Barvy jsou tokeny značky (`docs/brand/tokens`): cream, ink.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'evals/play/p76/after');
const OUT = join(ROOT, 'docs/README-assets');
const { chromium } = createRequire(import.meta.url)('@playwright/test');

/** Které věty jdou do mřížky; pořadí = pořadí v obrázku. */
const SCENES = ['s1', 's6', 's12', 's2', 's10', 's5'];
const CREAM = '#FFF3DF';
const INK = '#1F1A17';

const manifest = JSON.parse(readFileSync(join(SHOTS, 'manifest.json'), 'utf8'));
const sentence = (id) => manifest.sentences.find((entry) => entry.id === id).text;
/** Data URI: stránka ze `setContent` je `about:blank` a soubory z disku nenačte. */
const url = (file) => `data:image/jpeg;base64,${readFileSync(join(SHOTS, file)).toString('base64')}`;

/** Snímek 1440×900 má kolem hry krémový okraj; ořízne se na samotnou hru. */
const CROP = { x: 80, y: 90, width: 1280, height: 720 };

const sceneTile = (id) => `
  <figure>
    <div class="shot" style="background-image:url('${url(`${id}-desktop-1play.jpg`)}')"></div>
    <figcaption>“${sentence(id)}”</figcaption>
  </figure>`;

const page = (body, width) => `<!doctype html><html><head><style>
  body { margin: 0; background: ${CREAM}; font-family: Roboto, 'Segoe UI', Arial, sans-serif; color: ${INK}; }
  main { width: ${width}px; padding: 24px; box-sizing: border-box; display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  figure { margin: 0; }
  .shot { aspect-ratio: ${CROP.width} / ${CROP.height}; border: 2.5px solid ${INK}; border-radius: 14px;
          background-size: ${(1440 / CROP.width) * 100}% auto;
          background-position: ${(CROP.x / (1440 - CROP.width)) * 100}% ${(CROP.y / (900 - CROP.height)) * 100}%; }
  figcaption { font-size: 17px; font-weight: 600; line-height: 1.3; margin-top: 8px; }
</style></head><body>${body}</body></html>`;

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
    await tab.setContent(page(`<main>${SCENES.map(sceneTile).join('')}</main>`, 1500), { waitUntil: 'load' });
    await tab.locator('main').screenshot({ path: join(OUT, 'scenes.jpg'), type: 'jpeg', quality: 82 });

    // Karta na telefonu: jen karta, bez lišty a bez spodních tlačítek.
    await tab.setViewportSize({ width: 390, height: 844 });
    await tab.setContent(`<!doctype html><html><body style="margin:0"><img src="${url('s6-phone-0start.jpg')}"></body></html>`, { waitUntil: 'load' });
    await tab.screenshot({ path: join(OUT, 'start-card.jpg'), type: 'jpeg', quality: 85, clip: { x: 14, y: 226, width: 362, height: 334 } });
  } finally {
    await browser.close();
  }
  console.log(`readme-assets: ${join(OUT, 'scenes.jpg')}, ${join(OUT, 'start-card.jpg')}`);
}

await main();
