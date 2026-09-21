/**
 * Náhledový obrázek hry pro sdílený odkaz (P23-C T7).
 *
 * Kreslí se z **nálady hry** (`spec.theme.mood`), ne ze snímku scény – na
 * serveru není GPU a náhled musí být PNG, protože SVG sociální sítě do
 * `og:image` neberou. Nálada je volný text do 40 znaků, proto se nejdřív
 * hledá klíčové slovo a teprve bez shody rozhoduje hash: táž nálada dá vždy
 * tentýž obrázek a obrázků je jen tolik, kolik je palet – vykreslený PNG se
 * drží v paměti a veřejný požadavek zaplatí 25 ms nejvýš jednou na paletu.
 *
 * Žádná fialová: `__tests__/og.test.ts` měří odstín každé barvy v paletách.
 */

import { canonicalHash } from '@/ir/worlddoc';

import { encodePng, hexToRgb } from '../og/png';

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

export interface OgPalette {
  readonly id: string;
  readonly keywords: readonly string[];
  /** Obloha → země, čtyři vodorovné vrstvy shora dolů. */
  readonly bands: readonly [string, string, string, string];
  readonly accent: string;
}

export const OG_PALETTES: readonly OgPalette[] = [
  { id: 'calm', keywords: ['calm', 'peace', 'serene', 'cozy', 'quiet', 'gentle'], bands: ['#ccfbf1', '#5eead4', '#0f766e', '#134e4a'], accent: '#f59e0b' },
  { id: 'frantic', keywords: ['frantic', 'chaos', 'panic', 'wild', 'hectic'], bands: ['#fed7aa', '#fb923c', '#c2410c', '#431407'], accent: '#facc15' },
  { id: 'tense', keywords: ['tense', 'eerie', 'dark', 'creepy', 'ominous', 'spooky'], bands: ['#cbd5e1', '#64748b', '#334155', '#0f172a'], accent: '#dc2626' },
  { id: 'fast', keywords: ['fast', 'speed', 'rush', 'race', 'neon'], bands: ['#fef3c7', '#fcd34d', '#d97706', '#1e293b'], accent: '#06b6d4' },
  { id: 'cartoon', keywords: ['cartoon', 'cheerful', 'fun', 'silly', 'happy', 'playful'], bands: ['#dcfce7', '#86efac', '#16a34a', '#14532d'], accent: '#f97316' },
  { id: 'careful', keywords: ['careful', 'fragile', 'delicate', 'steady'], bands: ['#dbeafe', '#93c5fd', '#2563eb', '#1e3a8a'], accent: '#fbbf24' },
  { id: 'dangerous', keywords: ['danger', 'lava', 'fire', 'deadly', 'hot'], bands: ['#fee2e2', '#f87171', '#b91c1c', '#450a0a'], accent: '#fde047' },
  { id: 'puzzling', keywords: ['puzzl', 'myster', 'curious', 'clever', 'riddle'], bands: ['#cffafe', '#67e8f9', '#0e7490', '#164e63'], accent: '#fb7185' },
];

export function paletteForMood(mood: string): OgPalette {
  const words = mood.toLowerCase();
  const hit = OG_PALETTES.find((palette) => palette.keywords.some((keyword) => words.includes(keyword)));
  if (hit !== undefined) return hit;
  return OG_PALETTES[Number.parseInt(canonicalHash(words).slice(0, 8), 16) % OG_PALETTES.length];
}

function render(palette: OgPalette): Uint8Array {
  const rgb = new Uint8Array(OG_WIDTH * OG_HEIGHT * 3);
  const bands = palette.bands.map(hexToRgb);
  const accent = hexToRgb(palette.accent);
  for (let y = 0; y < OG_HEIGHT; y += 1) {
    const band = bands[Math.min(bands.length - 1, Math.floor((y / OG_HEIGHT) * bands.length))];
    for (let x = 0; x < OG_WIDTH; x += 1) {
      // Kruh v pravé třetině – „cíl“; jediné, co obrázek odlišuje od vlajky.
      const dx = x - OG_WIDTH * 0.7;
      const dy = y - OG_HEIGHT * 0.45;
      const color = dx * dx + dy * dy < 90 * 90 ? accent : band;
      const at = (y * OG_WIDTH + x) * 3;
      rgb[at] = color[0];
      rgb[at + 1] = color[1];
      rgb[at + 2] = color[2];
    }
  }
  return rgb;
}

const RENDERED = new Map<string, Uint8Array<ArrayBuffer>>();

export function ogPngFor(mood: string): Uint8Array<ArrayBuffer> {
  const palette = paletteForMood(mood);
  const ready = RENDERED.get(palette.id);
  if (ready !== undefined) return ready;
  const png = encodePng(OG_WIDTH, OG_HEIGHT, render(palette));
  RENDERED.set(palette.id, png);
  return png;
}
