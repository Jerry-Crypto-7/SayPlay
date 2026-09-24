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
 * Od P27B T6 je to jen **záloha**: odkaz nese náhled z obsahu hry
 * (`gamePreviewPng` níže) a paletový obrázek přijde, když ten render selže.
 *
 * Žádná fialová: `__tests__/og.test.ts` měří odstín každé barvy v paletách.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';
import { createElement as h } from 'react';

import catalog from '@/assets/catalog.json';
import { canonicalHash } from '@/ir/worlddoc';
import { heroModel } from '@/play/arcade/models';
import type { GameSpecV1 } from '@/play/spec';

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

// ---------------------------------------------------------------------------
// Náhled z obsahu hry (P27B T6): titul, hrdina, prostředí a jedna řádka
// ovládání, kreslené přes `next/og` (satori + resvg ve WASM). Není to snímek
// scény – na serveru GPU není – a nikde se tak nejmenuje. Paletový PNG výše
// zůstává jako záloha, když render selže.
// ---------------------------------------------------------------------------

/** Barvy písma a panelu náhledu; `og.test.ts` je měří na fialovou spolu s paletami. */
export const OG_INK: readonly [string, string, string, string] = ['#f8fafc', '#cbd5e1', '#0f172a', '#1e293b'];

/** Jedna řádka ovládání podle arkádového ovládání; mřížková hra vezme první větu nápovědy. */
const CONTROL_LINE: Readonly<Record<string, string>> = {
  runner: 'Tap to jump, swipe to switch lanes',
  platform: 'Tap to jump, hold to run',
  flap: 'Tap to flap',
  steer: 'Swipe to steer',
  move_free: 'Drag to move',
  shooter: 'Tap to shoot',
  throw: 'Hold, aim and release to throw',
  timing: 'Tap at the right moment',
  rhythm: 'Tap to the beat',
  duel: 'Tap to strike',
};

export function controlLineOf(spec: GameSpecV1): string {
  const line = spec.control === undefined ? undefined : CONTROL_LINE[spec.control];
  if (line !== undefined) return line;
  const first = spec.tutorial.controlsHint.split(/(?<=[.!?])\s/)[0] ?? '';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

/** Nálada rozhoduje, bez shody klíčové slovo prostředí, jinak hash nálady jako dosud. */
export function paletteForTheme(theme: { readonly mood: string; readonly setting: string }): OgPalette {
  const words = `${theme.mood} ${theme.setting}`.toLowerCase();
  const byMood = OG_PALETTES.find((palette) => palette.keywords.some((keyword) => theme.mood.toLowerCase().includes(keyword)));
  const bySetting = OG_PALETTES.find((palette) => palette.keywords.some((keyword) => words.includes(keyword)));
  return byMood ?? bySetting ?? paletteForMood(theme.mood);
}

const THUMBNAILS: ReadonlyMap<string, string> = new Map(catalog.assets.map((asset) => [asset.assetId, asset.thumbnail]));

/**
 * Odkud smí server stáhnout náhled modelu: `SITE_URL`, jinak adresa nasazení,
 * kterou nastavuje Vercel. **Nikdy z hlaviček požadavku** – `Host` si pošle
 * kdokoli, stažený obrázek by se zapamatoval k verzi a otrávený náhled by pak
 * dostal každý (táž třída jako `embed/[layoutId]/site-url.ts`). Bez obojího
 * `null`: jen soubor z `public/`, jinak ikona.
 */
export function assetOriginFrom(env: Record<string, string | undefined>): string | null {
  if (env.SITE_URL !== undefined && env.SITE_URL !== '') return env.SITE_URL.replace(/\/+$/, '');
  if (env.VERCEL_URL !== undefined && env.VERCEL_URL !== '') return `https://${env.VERCEL_URL}`;
  return null;
}

/**
 * PNG náhled modelu hrdiny z katalogu jako data URL. Nejdřív ze souboru v
 * `public/`, kde ho má lokální server i test; kde funkce soubory `public/`
 * nenese (Vercel je servíruje z CDN), přes HTTP z důvěryhodného původu. Nic
 * z toho → `null` a náhled nakreslí ikonu ovládání.
 */
async function heroImage(modelId: string, origin: string | null): Promise<string | null> {
  const thumbnail = THUMBNAILS.get(modelId);
  if (thumbnail === undefined) return null;
  const encode = (bytes: Uint8Array): string => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  try {
    return encode(await readFile(join(process.cwd(), 'public', thumbnail)));
  } catch {
    // Soubor u funkce není – zkusí se HTTP.
  }
  if (origin === null) return null;
  try {
    const response = await fetch(new URL(thumbnail, origin), { signal: AbortSignal.timeout(2000) });
    if (response.ok && response.headers.get('content-type') === 'image/png') return encode(new Uint8Array(await response.arrayBuffer()));
  } catch {
    // Síť nejde – ikona ovládání.
  }
  return null;
}

type Node = ReturnType<typeof h>;

function controlIcon(accent: string): Node {
  // Terč ze tří kruhů: ovládání bez modelu hrdiny, bez písma, které by v Geist chybělo.
  return h(
    'div',
    { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 300, height: 300, borderRadius: 150, background: accent } },
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 200, height: 200, borderRadius: 100, background: OG_INK[2] } }, h('div', { style: { width: 90, height: 90, borderRadius: 45, background: accent } })),
  );
}

function previewElement(spec: GameSpecV1, hero: string | null): Node {
  const palette = paletteForTheme(spec.theme);
  const [sky, high, low, ground] = palette.bands;
  return h(
    'div',
    {
      style: {
        display: 'flex',
        width: '100%',
        height: '100%',
        alignItems: 'center',
        padding: 56,
        gap: 48,
        background: `linear-gradient(180deg, ${sky} 0%, ${high} 38%, ${low} 72%, ${ground} 100%)`,
        fontFamily: 'Geist',
      },
    },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', flex: 1, gap: 20, padding: 44, borderRadius: 32, background: 'rgba(15, 23, 42, 0.82)', color: OG_INK[0] } },
      h('div', { style: { fontSize: 26, color: palette.accent, letterSpacing: 3 } }, 'WORLDSTREAM PLAY'),
      h('div', { style: { fontSize: spec.title.length > 28 ? 56 : 72, lineHeight: 1.05 } }, spec.title),
      h('div', { style: { fontSize: 28, color: OG_INK[1] } }, spec.theme.setting),
      h('div', { style: { display: 'flex', alignSelf: 'flex-start', marginTop: 12, padding: '12px 24px', borderRadius: 999, background: palette.accent, color: OG_INK[2], fontSize: 30 } }, controlLineOf(spec)),
    ),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 420, height: 420, borderRadius: 32, background: OG_INK[3] } },
      hero === null ? controlIcon(palette.accent) : h('img', { src: hero, width: 380, height: 380, style: { objectFit: 'contain' } }),
    ),
  );
}

/**
 * Znaky, které nakreslí Geist – jediné písmo, které `next/og` nese. Pro jiné
 * znaky si satori písmo stahuje z Google Fonts a když to nevyjde, **nehodí**:
 * nakreslí prázdná místa a render „projde“ (nález revize T6-1). Rozsah je
 * latinka s diakritikou a běžná interpunkce **zúžená na cmap písma** – Geist
 * nemá třeba U+2011 ani U+00AD (revize T6-2); `og.test.ts` to měří na souboru písma.
 */
const GEIST_TEXT =
  /^[ -~ -¬®-ēĖ-īĮ-ķĹ-ľŁ-ňŊ-ōŐ-ž–—‘-‚“-„†-•…‰′″‹›€]*$/u;

export function fontCovers(text: string): boolean {
  return GEIST_TEXT.test(text);
}

/** Kolik náhledů her se drží v paměti; nejstarší vypadne první. */
const PREVIEW_CAP = 256;
const PREVIEWS = new Map<string, Uint8Array<ArrayBuffer>>();

export interface GamePreview {
  readonly png: Uint8Array<ArrayBuffer>;
  /**
   * `false`: obrázek hrdiny se nepodařilo získat, ač ho katalog má, nebo text
   * potřebuje stažené písmo. Takový náhled se neukládá a nesmí být `immutable`
   * – přechodná chyba by se jinak stala trvalým obrázkem verze.
   */
  readonly complete: boolean;
}

/**
 * PNG náhled konkrétní verze. Verze se nemění, takže klíč `versionId` stačí a
 * úplný render se platí jednou na verzi a proces. Selhání vrátí `null` a
 * nezapamatuje se – další požadavek zkusí kreslit znovu.
 */
export async function gamePreviewPng(versionId: string, spec: GameSpecV1, origin: string | null): Promise<GamePreview | null> {
  const ready = PREVIEWS.get(versionId);
  if (ready !== undefined) return { png: ready, complete: true };
  try {
    const model = heroModel(spec);
    const hero = await heroImage(model, origin);
    const complete = (hero !== null || !THUMBNAILS.has(model)) && [spec.title, spec.theme.setting, controlLineOf(spec)].every(fontCovers);
    const response = new ImageResponse(previewElement(spec, hero), { width: OG_WIDTH, height: OG_HEIGHT });
    const png = new Uint8Array(await response.arrayBuffer());
    if (complete) {
      if (PREVIEWS.size >= PREVIEW_CAP) PREVIEWS.delete(PREVIEWS.keys().next().value as string);
      PREVIEWS.set(versionId, png);
    }
    return { png, complete };
  } catch (error) {
    console.warn(`[play og] preview for ${versionId} failed, serving the palette image:`, error instanceof Error ? error.message : error);
    return null;
  }
}

export function ogPngFor(mood: string): Uint8Array<ArrayBuffer> {
  const palette = paletteForMood(mood);
  const ready = RENDERED.get(palette.id);
  if (ready !== undefined) return ready;
  const png = encodePng(OG_WIDTH, OG_HEIGHT, render(palette));
  RENDERED.set(palette.id, png);
  return png;
}
