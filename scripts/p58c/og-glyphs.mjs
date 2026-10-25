#!/usr/bin/env node
/**
 * Atlas glyfů pro náhled sdíleného odkazu (P58C T2): `src/app/api/og/glyphs.json`.
 *
 * Kartu výzvy dřív kreslil `next/og` (satori + resvg, MPL-2.0). Teď ji kreslí
 * `src/app/api/og/raster.ts` do vlastního bufferu a text bere odsud: masky
 * glyfů Roboto Black 900 (celá podmnožina latinky z P34 T1) a Bold 700 (ASCII,
 * jen slovo odznaku) v referenční velikosti `SIZE`, plus logo
 * `public/brand/logo/logo-lockup.svg` v rozměru karty jako RGBA. Rasterizuje
 * Chromium z Playwrightu (vývojová závislost), za běhu se nic z toho nevolá.
 *
 * Spouští se ručně po změně písma, loga nebo znakové sady:
 *   node scripts/p58c/og-glyphs.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { chromium } from '@playwright/test';

const ROOT = process.cwd();
const OUT = join(ROOT, 'src/app/api/og/glyphs.json');

/** Referenční velikost masek v px; karta kreslí 24–72 px, takže se jen zmenšuje. */
const SIZE = 80;
/** Logo na kartě 1200 px: výška 60, šířka podle viewBoxu 4773 × 1340. */
const LOGO = { width: Math.round((60 * 4773) / 1340), height: 60 };

/**
 * Znaky, které oba řezy Roboto v `public/fonts/roboto` opravdu mají (podmnožina
 * latinky z P34 T1). `og.test.ts` to měří proti cmap obou souborů.
 */
const RANGES = [
  [0x20, 0x7e], [0xa0, 0xff], [0x131, 0x131], [0x152, 0x153], [0x2bb, 0x2bc], [0x2c6, 0x2c6], [0x2da, 0x2da], [0x2dc, 0x2dc],
  [0x2000, 0x2027], [0x202f, 0x205f], [0x2074, 0x2074], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193], [0x2212, 0x2212],
];
const codePoints = (ranges) => ranges.flatMap(([from, to]) => Array.from({ length: to - from + 1 }, (_, i) => from + i));
const BLACK = codePoints(RANGES).map((c) => String.fromCodePoint(c));
const BOLD = codePoints([[0x20, 0x7e]]).map((c) => String.fromCodePoint(c));

const font = (file) => readFileSync(join(ROOT, 'public/fonts/roboto', file)).toString('base64');
const logoSvg = readFileSync(join(ROOT, 'public/brand/logo/logo-lockup.svg')).toString('base64');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const result = await page.evaluate(
    async ({ size, logo, cuts, svg }) => {
      const canvas = document.createElement('canvas');
      canvas.width = size * 3;
      canvas.height = size * 3;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const fonts = {};
      for (const cut of cuts) {
        const face = new FontFace('Roboto', Uint8Array.from(atob(cut.data), (c) => c.charCodeAt(0)), { weight: String(cut.weight) });
        document.fonts.add(await face.load());
        ctx.font = `${cut.weight} ${size}px Roboto`;
        const metrics = ctx.measureText('H');
        const glyphs = {};
        for (const ch of cut.chars) {
          // Počátek v (size, 2·size): místo vlevo pro záporný přesah, nahoře pro akcenty.
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#000';
          ctx.fillText(ch, size, size * 2);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          let [x0, y0, x1, y1] = [canvas.width, canvas.height, -1, -1];
          for (let y = 0; y < canvas.height; y += 1) {
            for (let x = 0; x < canvas.width; x += 1) {
              if (data[(y * canvas.width + x) * 4 + 3] === 0) continue;
              x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            }
          }
          const advance = ctx.measureText(ch).width;
          if (x1 < 0) {
            glyphs[ch] = { advance, x: 0, y: 0, w: 0, h: 0, alpha: [] };
            continue;
          }
          const [w, h] = [x1 - x0 + 1, y1 - y0 + 1];
          const alpha = new Array(w * h);
          for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) alpha[y * w + x] = data[((y0 + y) * canvas.width + x0 + x) * 4 + 3];
          glyphs[ch] = { advance, x: x0 - size, y: y0 - size * 2, w, h, alpha };
        }
        fonts[cut.weight] = { ascent: metrics.fontBoundingBoxAscent, descent: metrics.fontBoundingBoxDescent, glyphs };
      }
      const image = new Image();
      image.src = `data:image/svg+xml;base64,${svg}`;
      await image.decode();
      const plate = document.createElement('canvas');
      plate.width = logo.width;
      plate.height = logo.height;
      const pctx = plate.getContext('2d');
      pctx.drawImage(image, 0, 0, logo.width, logo.height);
      return { fonts, logo: Array.from(pctx.getImageData(0, 0, logo.width, logo.height).data) };
    },
    {
      size: SIZE,
      logo: LOGO,
      svg: logoSvg,
      cuts: [
        { weight: 900, data: font('Roboto-Black.ttf'), chars: BLACK },
        { weight: 700, data: font('Roboto-Bold.ttf'), chars: BOLD },
      ],
    },
  );

  const masks = [];
  let offset = 0;
  const fonts = {};
  for (const [weight, cut] of Object.entries(result.fonts)) {
    const glyphs = {};
    for (const [ch, glyph] of Object.entries(cut.glyphs)) {
      glyphs[ch] = [Math.round(glyph.advance * 100) / 100, glyph.x, glyph.y, glyph.w, glyph.h, offset];
      masks.push(Uint8Array.from(glyph.alpha));
      offset += glyph.alpha.length;
    }
    fonts[weight] = { ascent: cut.ascent, descent: cut.descent, glyphs };
  }
  const alpha = deflateSync(Buffer.concat(masks), { level: 9 }).toString('base64');
  const logo = deflateSync(Uint8Array.from(result.logo), { level: 9 }).toString('base64');
  writeFileSync(
    OUT,
    `${JSON.stringify({
      $comment: 'Generováno scripts/p58c/og-glyphs.mjs: masky glyfů Roboto (Apache-2.0, public/fonts/roboto) a logo Sayplay pro náhled sdíleného odkazu. Glyf = [advance, x, y, w, h, offset] v px při velikosti size, y od účaří; alpha a logo.rgba jsou deflate + base64.',
      size: SIZE,
      fonts,
      alpha,
      logo: { ...LOGO, rgba: logo },
    })}\n`,
  );
  console.log(`og-glyphs: ${BLACK.length} + ${BOLD.length} glyphs, ${offset} mask bytes → ${(alpha.length / 1024).toFixed(0)} KB, logo ${(logo.length / 1024).toFixed(0)} KB`);
} finally {
  await browser.close();
}
