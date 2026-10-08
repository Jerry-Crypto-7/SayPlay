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
 * (`gamePreviewPng` níže, od P34 T7 karta výzvy kitu Sayplay) a paletový
 * obrázek přijde, když ten render selže.
 *
 * Žádná fialová: `__tests__/og.test.ts` měří odstín každé barvy v paletách.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ImageResponse } from 'next/og';
import { createElement as h } from 'react';

import catalog from '@/assets/catalog.json';
import { color } from '@/brand/tokens';
import { CAN_YOU_BEAT_IT, DARE_BADGE, daresYou } from '@/components/play/starters';
import { clockText } from '@/components/play/ui/GameHud';
import { canonicalHash } from '@/ir/worlddoc';
import { ARCADE_HZ } from '@/play/arcade/contract';
import { sceneLook } from '@/play/arcade/look';
import { heroModel } from '@/play/arcade/models';
import { arenaWinOf, type GameSpecV1 } from '@/play/spec';
import type { DareRecord } from '@/play/version';

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
      const pixel = dx * dx + dy * dy < 90 * 90 ? accent : band;
      const at = (y * OG_WIDTH + x) * 3;
      rgb[at] = pixel[0];
      rgb[at + 1] = pixel[1];
      rgb[at + 2] = pixel[2];
    }
  }
  return rgb;
}

const RENDERED = new Map<string, Uint8Array<ArrayBuffer>>();

// ---------------------------------------------------------------------------
// Karta výzvy (P34 T7, kit `docs/brand/docs/13-assets.md`, Dare card; dřív
// titulní obrázek P27B T6), kreslená přes `next/og` (satori + resvg ve WASM):
// krémová plocha, vlevo barva scény (obloha a zem sady prostředí arkády) s
// hrdinou v rámu s inkoustovým obrysem, vpravo název hry, slunečný odznak
// s časem, „Can you beat it?“ a logo vpravo dole. Snímek scény to není – na
// serveru GPU není. Písmo je Roboto v2.138 z `public/fonts/roboto` (TTF,
// satori WOFF2 nečte). Rozměry kitu jsou pro telefon 390 px; karta 1200 px je
// kreslí dvojnásobně (obrys 6, poloměr xl 48, tvrdé stíny 10 a 14).
// ---------------------------------------------------------------------------

/** Barvy karty: jen tokeny kitu (`src/brand/tokens.ts`); `og.test.ts` je měří na fialovou spolu s paletami. */
export const OG_INK: readonly [string, string, string, string] = [color.cream, color.ink, color.sun, color.paper];

/** Poměr stran loga `public/brand/logo/logo-lockup.svg` (viewBox 4773 × 1340). */
const LOGO_RATIO = 4773 / 1340;

/** Řezy Roboto, které karta kreslí: název a čas Black 900, slovo odznaku Bold 700. */
const FONT_FILES = [
  { weight: 900, file: 'Roboto-Black.ttf' },
  { weight: 700, file: 'Roboto-Bold.ttf' },
] as const;

/** Odznak karty: čas, který hra opravdu měří, a jedno slovo; `time: null` = hra čas neměří. */
export interface DareBadge {
  readonly time: string | null;
  readonly word: string;
  /** Výzva s autorem (P44B T7): „Ada dares you“ nad odznakem. */
  readonly lead?: string;
}

/**
 * Čas na slunečném odznaku obyčejného odkazu: ten nese jen hru, ne něčí běh,
 * takže karta ukáže limit, který hra sama měří – přežití (`survive`
 * s `seconds`, aréna na přežití, časovač končící výhrou) je „Survive!“,
 * časovač končící prohrou je závod s časem „Hurry!“. Hra bez měřeného času
 * dostane jen slovo – vymyšlené číslo by lhalo. Výsledek kamaráda nese odkaz
 * výzvy (`dareScoreBadge`).
 */
export function dareBadge(spec: GameSpecV1): DareBadge {
  const timer = spec.mechanics.find((mechanic) => mechanic.id === 'timer')?.params as { readonly seconds?: unknown; readonly onEnd?: unknown } | undefined;
  const timerSeconds = typeof timer?.seconds === 'number' ? timer.seconds : undefined;
  const arena = spec.control === 'move_free' ? arenaWinOf(spec) : null;
  const survive =
    spec.objective.kind === 'survive' && spec.objective.seconds !== undefined
      ? spec.objective.seconds
      : arena !== null && 'goal' in arena && arena.goal === 'survive' && arena.seconds !== undefined
        ? arena.seconds
        : timer?.onEnd === 'win'
          ? timerSeconds
          : undefined;
  if (survive !== undefined) return { time: `${survive}s`, word: DARE_BADGE.survive };
  if (timerSeconds !== undefined) return { time: `${timerSeconds}s`, word: DARE_BADGE.hurry };
  return { time: null, word: DARE_BADGE.none };
}

/**
 * Odznak odkazu výzvy (P36B T8): výsledek kamaráda, který server ověřil
 * přehráním (`DareRecord`) – body („2,450 to beat“), bez bodů jeho čas
 * („31.0s to beat“), stejně jako cíl výzvy v HUD. Výhra hry na přežití trvá
 * vždy celý limit, takže bez bodů zůstane její odznak „Survive!“. `by` = přezdívka
 * autora, která už prošla `shownNickname` (P44B T7) – jiný text z úložiště na kartu nejde.
 */
export function dareScoreBadge(spec: GameSpecV1, dare: Pick<DareRecord, 'score' | 'ticks'>, by?: string): DareBadge {
  const lead = by === undefined ? {} : { lead: daresYou(by) };
  if (dare.score > 0) return { time: dare.score.toLocaleString('en-US'), word: DARE_BADGE.dare, ...lead };
  const own = dareBadge(spec);
  return own.word === DARE_BADGE.survive ? { ...own, ...lead } : { time: clockText(dare.ticks / ARCADE_HZ), word: DARE_BADGE.dare, ...lead };
}

/**
 * Soubor z `public/` (náhled modelu, písmo, logo). Nejdřív z disku, kde ho má
 * lokální server i test; kde funkce soubory `public/` nenese (Vercel je
 * servíruje z CDN), přes HTTP z důvěryhodného původu. **Nikdy z hlaviček
 * požadavku** – viz `assetOriginFrom`. `valid` odmítne cizí odpověď (chybovou
 * stránku za CDN). Nic z toho → `null`.
 */
async function publicFile(path: string, origin: string | null, valid: (bytes: Uint8Array, type: string | null) => boolean): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(join(process.cwd(), 'public', path)));
  } catch {
    // Soubor u funkce není – zkusí se HTTP.
  }
  if (origin === null) return null;
  try {
    const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return valid(bytes, response.headers.get('content-type')) ? bytes : null;
  } catch {
    // Síť nejde.
    return null;
  }
}

/** TrueType začíná verzí 1.0 (`00 01 00 00`); HTML chybové stránky ne. */
const isTrueType = (bytes: Uint8Array): boolean => bytes.length > 4 && bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0;

type OgFont = { readonly name: string; readonly data: ArrayBuffer; readonly weight: 700 | 900; readonly style: 'normal' };

/** Načtené řezy a logo se nemění – drží se na proces; selhání se nezapamatuje. */
let FONTS: readonly OgFont[] | null = null;
let LOGO: string | null = null;

async function dareFonts(origin: string | null): Promise<readonly OgFont[] | null> {
  if (FONTS !== null) return FONTS;
  const loaded = await Promise.all(
    FONT_FILES.map(async ({ weight, file }): Promise<OgFont | null> => {
      const bytes = await publicFile(`/fonts/roboto/${file}`, origin, isTrueType);
      return bytes === null ? null : { name: 'Roboto', data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, weight, style: 'normal' };
    }),
  );
  if (loaded.some((font) => font === null)) return null;
  FONTS = loaded as OgFont[];
  return FONTS;
}

async function logoLockup(origin: string | null): Promise<string | null> {
  if (LOGO !== null) return LOGO;
  const bytes = await publicFile('/brand/logo/logo-lockup.svg', origin, (_, type) => type?.startsWith('image/svg+xml') === true);
  if (bytes === null) return null;
  LOGO = `data:image/svg+xml;base64,${Buffer.from(bytes).toString('base64')}`;
  return LOGO;
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

/** PNG náhled modelu hrdiny z katalogu jako data URL; bez něj (`null`) nakreslí karta terč. */
async function heroImage(modelId: string, origin: string | null): Promise<string | null> {
  const thumbnail = THUMBNAILS.get(modelId);
  if (thumbnail === undefined) return null;
  const bytes = await publicFile(thumbnail, origin, (_, type) => type === 'image/png');
  return bytes === null ? null : `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

type Node = ReturnType<typeof h>;

/** Terč ze tří kruhů místo hrdiny, který katalog nemá: bez písma, jen barvy kitu. */
function target(): Node {
  const ring = (size: number, fill: string, child?: Node): Node =>
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, borderRadius: size / 2, background: fill, border: `6px solid ${color.ink}` } }, child);
  return ring(260, color.sun, ring(170, color.paper, ring(80, color.tomato)));
}

/** Slunečný odznak výhry (kit `.sp-badge`: kruh, obrys, stín, náklon −6°) s časem a slovem. */
function badge({ time, word }: DareBadge): Node {
  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: 196,
        height: 196,
        borderRadius: 98,
        background: color.sun,
        border: `6px solid ${color.ink}`,
        boxShadow: `10px 10px 0 0 ${color.ink}`,
        transform: 'rotate(-6deg)',
      },
    },
    // Body výzvy bývají delší než čas („12,450“): nad pět znaků menší písmo, ať se vejdou do kruhu.
    time === null ? null : h('div', { style: { fontSize: time.length > 5 ? 44 : 60, fontWeight: 900, lineHeight: 1, letterSpacing: time.length > 5 ? -1.3 : -1.8 } }, time),
    h('div', { style: { marginTop: time === null ? 0 : 6, fontSize: time === null ? 34 : 24, fontWeight: time === null ? 900 : 700, lineHeight: 1.1, textAlign: 'center' } }, word),
  );
}

function dareCard(spec: GameSpecV1, hero: string | null, logo: string | null, sun: DareBadge): Node {
  const look = sceneLook(spec.theme);
  const long = spec.title.length > 24;
  return h(
    'div',
    { style: { display: 'flex', width: '100%', height: '100%', padding: 56, gap: 56, background: color.cream, color: color.ink, fontFamily: 'Roboto' } },
    // Vlevo „zamrzlá scéna“: obloha a zem sady prostředí, hrdina na horizontu, rám kitu.
    h(
      'div',
      {
        style: {
          display: 'flex',
          position: 'relative',
          flexShrink: 0,
          width: 500,
          height: 504,
          borderRadius: 48,
          border: `6px solid ${color.ink}`,
          boxShadow: `14px 14px 0 0 ${color.ink}`,
          background: look.sky,
          overflow: 'hidden',
        },
      },
      h('div', { style: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 170, background: look.ground } }),
      h(
        'div',
        { style: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        // Náhled modelu má vlastní šedé pozadí: na scéně stojí jako karta hrdiny s rámem a stínem kitu.
        hero === null
          ? target()
          : h(
              'div',
              { style: { display: 'flex', width: 330, height: 330, borderRadius: 32, border: `6px solid ${color.ink}`, boxShadow: `10px 10px 0 0 ${color.ink}`, overflow: 'hidden' } },
              h('img', { src: hero, width: 318, height: 318, style: { objectFit: 'cover' } }),
            ),
      ),
    ),
    // Vpravo název (display-m), odznak s „Can you beat it?“ a logo vpravo dole.
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', justifyContent: 'space-between', flex: 1, minWidth: 0, paddingTop: 8 } },
      h('div', { style: { fontSize: long ? 56 : 72, fontWeight: 900, lineHeight: 1.05, letterSpacing: long ? -1.7 : -2.2 } }, spec.title),
      h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 20 } },
        // Kdo vyzývá (P44B T7) stojí nad odznakem s jeho výsledkem.
        sun.lead === undefined ? null : h('div', { style: { fontSize: 40, fontWeight: 900, lineHeight: 1.05, letterSpacing: -1.2 } }, sun.lead),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 36 } },
          badge(sun),
          // Šířka láme otázku na „Can you / beat it?“, ne „Can you beat / it?“.
          h('div', { style: { width: 240, fontSize: 54, fontWeight: 900, lineHeight: 1.02, letterSpacing: -1.6 } }, CAN_YOU_BEAT_IT),
        ),
      ),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end' } }, logo === null ? null : h('img', { src: logo, width: Math.round(60 * LOGO_RATIO), height: 60 })),
    ),
  );
}

/**
 * Znaky, které nakreslí Roboto z `public/fonts/roboto` (podmnožina latinky
 * z P34 T1, oba řezy karty mají tutéž). Pro jiné znaky si satori písmo
 * stahuje z Google Fonts a když to nevyjde, **nehodí**: nakreslí prázdná
 * místa a render „projde“ (nález revize T6-1). `og.test.ts` rozsah měří na
 * souborech písma.
 */
const ROBOTO_TEXT = /^[ -~ -ÿıŒœʻʼˆ˚˜ -‧ - ⁴€™↑↓−]*$/u;

export function fontCovers(text: string): boolean {
  return ROBOTO_TEXT.test(text);
}

/** Kolik náhledů her se drží v paměti; nejstarší vypadne první. */
const PREVIEW_CAP = 256;
const PREVIEWS = new Map<string, Uint8Array<ArrayBuffer>>();

export interface GamePreview {
  readonly png: Uint8Array<ArrayBuffer>;
  /**
   * `false`: obrázek hrdiny (ač ho katalog má), písmo nebo logo se nepodařilo
   * získat, nebo název potřebuje stažené písmo. Takový náhled se neukládá a
   * nesmí být `immutable` – přechodná chyba by se jinak stala trvalým obrázkem verze.
   */
  readonly complete: boolean;
}

/**
 * PNG náhled konkrétní verze, s výzvou (P36B T8) její výsledek na odznaku.
 * Verze ani výzva se nemění, takže klíč `versionId` (s výzvou
 * `versionId:dareId`, s autorem i jeho přezdívka `by` – ta se měnit smí) stačí a úplný
 * render se platí jednou na kartu a proces.
 * Selhání vrátí `null` a nezapamatuje se – další požadavek zkusí kreslit znovu.
 */
export async function gamePreviewPng(versionId: string, spec: GameSpecV1, origin: string | null, dare: DareRecord | null = null, by?: string): Promise<GamePreview | null> {
  const key = dare === null ? versionId : `${versionId}:${dare.dareId}${by === undefined ? '' : `:${by}`}`;
  const ready = PREVIEWS.get(key);
  if (ready !== undefined) return { png: ready, complete: true };
  try {
    const model = heroModel(spec);
    const [hero, fonts, logo] = await Promise.all([heroImage(model, origin), dareFonts(origin), logoLockup(origin)]);
    // Bez Roboto kreslí `next/og` svým výchozím písmem – náhled je pak jen dočasný (`complete: false`).
    const sun = dare === null ? dareBadge(spec) : dareScoreBadge(spec, dare, by);
    const complete = (hero !== null || !THUMBNAILS.has(model)) && fonts !== null && logo !== null && fontCovers(spec.title) && fontCovers(sun.lead ?? '');
    const response = new ImageResponse(dareCard(spec, hero, logo, sun), { width: OG_WIDTH, height: OG_HEIGHT, ...(fonts === null ? {} : { fonts: [...fonts] }) });
    const png = new Uint8Array(await response.arrayBuffer());
    if (complete) {
      if (PREVIEWS.size >= PREVIEW_CAP) PREVIEWS.delete(PREVIEWS.keys().next().value as string);
      PREVIEWS.set(key, png);
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
