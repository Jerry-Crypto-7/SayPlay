/**
 * `GET /api/og?layout=<id>` — náhledový obrázek světa pro odkaz.
 *
 * Kreslí se z **palety toho layoutu**, ne z obecné šablony: náhled dvou různých
 * světů se musí lišit, jinak je to jen logo a nemá smysl ho generovat. Obraz je
 * plně určený layoutem, takže je při každém volání bajt po bajtu stejný a dá se
 * na něj ptát v testu.
 *
 * Snímek scény by byl hezčí a stál by hlavu bez GPU na serveru. Tohle je
 * poctivá varianta, která funguje všude, kde poběží demo.
 */

import { LAYOUTS, layoutById, PALETTES } from '../../../kit';

import { encodePng, hexToRgb } from './png';

export const runtime = 'nodejs';

/** Poměr 1,91:1, jak ho žádá Open Graph. */
const WIDTH = 1200;
const HEIGHT = 630;

/** Slot palety, který drží kterou vodorovnou vrstvu. Odspodu nahoru. */
const BANDS = ['deep', 'moss', 'shell', 'sand'] as const;

function render(palette: Record<string, string>): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  const bands = BANDS.map((slot) => hexToRgb(palette[slot]));
  const accent = hexToRgb(palette.accent);
  const warm = hexToRgb(palette.warm);

  for (let y = 0; y < HEIGHT; y += 1) {
    // Vrstvy odspodu: `deep` je nejnižší a nejtlustší, obloha nahoře nejsvětlejší.
    const band = bands[Math.min(bands.length - 1, Math.floor(((HEIGHT - 1 - y) / HEIGHT) * bands.length))];
    for (let x = 0; x < WIDTH; x += 1) {
      // Dva pruhy ve zlatém řezu — jediné, co obrázek odlišuje od plochy.
      const stripe = x > WIDTH * 0.6 && x < WIDTH * 0.66 ? accent : x > WIDTH * 0.7 && x < WIDTH * 0.73 ? warm : null;
      const color = stripe ?? band;
      const at = (y * WIDTH + x) * 3;
      rgb[at] = color[0];
      rgb[at + 1] = color[1];
      rgb[at + 2] = color[2];
    }
  }

  return rgb;
}

/**
 * Hotové obrázky, jeden na layout.
 *
 * Vykreslení je 756 tisíc iterací plus synchronní `deflateSync`, naměřeně
 * 23–29 ms — a je to **čistá funkce layoutu**, kterých je šest. Bez téhle mapy
 * platí ta cena každý veřejný požadavek a stačí pár desítek za sekundu, aby
 * jediná smyčka událostí neměla čas na `/api/emit` ani na vykreslení stránky.
 * Hlavička `immutable` pomůže až za CDN, kterou nasazení mít nemusí.
 */
const RENDERED = new Map<string, Uint8Array<ArrayBuffer>>();

export function pngFor(layoutId: string, palette: Record<string, string>): Uint8Array<ArrayBuffer> {
  const ready = RENDERED.get(layoutId);
  if (ready !== undefined) return ready;

  const png = encodePng(WIDTH, HEIGHT, render(palette));
  RENDERED.set(layoutId, png);
  return png;
}

export function GET(request: Request): Response {
  const requested = new URL(request.url).searchParams.get('layout');
  const layout = requested === null ? LAYOUTS[0] : layoutById(requested);

  if (layout === undefined)
    return Response.json({ error: { code: 'UNKNOWN_LAYOUT', message: `no layout named ${requested}` } }, { status: 404 });

  const png = pngFor(layout.id, PALETTES[layout.palette]);

  return new Response(png, {
    headers: {
      'content-type': 'image/png',
      'content-length': String(png.length),
      // Obraz je čistá funkce layoutu, takže se smí ukládat natrvalo.
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
