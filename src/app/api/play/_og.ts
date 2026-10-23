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

import { decodePng, encodePng, hexToRgb } from '../og/png';
import { baselineOf, drawImage, drawText, logoImage, measureText, paint, raster, type Raster, type Rgb, type RgbaImage, roundRect, type Shape, type TextStyle, type Turn, wrapText } from '../og/raster';

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
// titulní obrázek P27B T6), od P58C T2 kreslená vlastním rastrem
// (`../og/raster.ts`) místo `next/og`, jehož satori a resvg jsou MPL-2.0:
// krémová plocha, vlevo barva scény (obloha a zem sady prostředí arkády) s
// hrdinou v rámu s inkoustovým obrysem, vpravo název hry, slunečný odznak
// s časem, „Can you beat it?“ a logo vpravo dole. Snímek scény to není – na
// serveru GPU není. Písmo je atlas glyfů Roboto v2.138 z `public/fonts/roboto`
// (`../og/glyphs.json`). Rozměry kitu jsou pro telefon 390 px; karta 1200 px je
// kreslí dvojnásobně (obrys 6, poloměr xl 48, tvrdé stíny 10 a 14).
// ---------------------------------------------------------------------------

/** Barvy karty: jen tokeny kitu (`src/brand/tokens.ts`); `og.test.ts` je měří na fialovou spolu s paletami. */
export const OG_INK: readonly [string, string, string, string] = [color.cream, color.ink, color.sun, color.paper];

const INK = hexToRgb(color.ink);

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
 * Soubor z `public/` (náhled modelu). Nejdřív z disku, kde ho má
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

/** Dekódovaný PNG náhled modelu hrdiny z katalogu; bez něj (`null`) nakreslí karta terč. */
async function heroImage(modelId: string, origin: string | null): Promise<RgbaImage | null> {
  const thumbnail = THUMBNAILS.get(modelId);
  if (thumbnail === undefined) return null;
  const bytes = await publicFile(thumbnail, origin, (_, type) => type === 'image/png');
  if (bytes === null) return null;
  try {
    return decodePng(bytes);
  } catch {
    // Formát, který dekodér nečte: karta bez hrdiny, dočasná (`complete: false`).
    return null;
  }
}

/**
 * Rámeček kitu: tvrdý stín (posunutý o `shadow`, s `turn` otočený s prvkem),
 * inkoustový obrys `border` a výplň uvnitř. Vrací vnitřní tvar pro ořez obsahu.
 */
function framed(card: Raster, x: number, y: number, w: number, h: number, r: number, fill: Rgb | null, border: number, shadow: number, turn?: Turn): Shape {
  if (shadow > 0) {
    const [cos, sin] = turn === undefined ? [1, 0] : [Math.cos(turn.angle), Math.sin(turn.angle)];
    paint(card, roundRect(x + shadow * cos - shadow * sin, y + shadow * sin + shadow * cos, w, h, r), INK);
  }
  paint(card, roundRect(x, y, w, h, r), INK);
  const inner = roundRect(x + border, y + border, w - 2 * border, h - 2 * border, r - border);
  // Bez výplně (rám hrdiny) prosvítá scéna, jako u CSS rámečku bez pozadí.
  if (fill !== null) paint(card, inner, fill);
  return inner;
}

/** Terč ze tří kruhů se středem `(cx, cy)` místo hrdiny, kterého katalog nemá: bez písma, jen barvy kitu. */
function target(card: Raster, cx: number, cy: number): void {
  for (const [size, fill] of [[260, color.sun], [170, color.paper], [80, color.tomato]] as const) framed(card, cx - size / 2, cy - size / 2, size, size, size / 2, hexToRgb(fill), 6, 0);
}

/** Řádky textu shora od `top`; `align` vodorovně v `[x, x + width]` jako CSS `text-align`. */
function textBlock(card: Raster, lines: readonly string[], x: number, top: number, width: number, style: TextStyle, lineHeight: number, align: 'left' | 'center', turn?: Turn): void {
  lines.forEach((line, i) => {
    const left = align === 'center' ? x + (width - measureText(line, style)) / 2 : x;
    drawText(card, line, left, baselineOf(top + i * lineHeight, lineHeight, style), style, INK, turn);
  });
}

/** Slunečný odznak výhry (kit `.sp-badge`: kruh 196, obrys, stín, náklon −6°) s časem a slovem; `(x, y)` = levý horní roh. */
function badge(card: Raster, x: number, y: number, { time, word }: DareBadge): void {
  const size = 196;
  const inner = size - 12;
  const turn: Turn = { cx: x + size / 2, cy: y + size / 2, angle: (-6 * Math.PI) / 180 };
  framed(card, x, y, size, size, size / 2, hexToRgb(color.sun), 6, 10, turn);
  // Body výzvy bývají delší než čas („12,450“): nad pět znaků menší písmo, ať se vejdou do kruhu.
  const clock: TextStyle = { weight: 900, size: time !== null && time.length > 5 ? 44 : 60, spacing: time !== null && time.length > 5 ? -1.3 : -1.8 };
  const label: TextStyle = time === null ? { weight: 900, size: 34, spacing: 0 } : { weight: 700, size: 24, spacing: 0 };
  const words = wrapText(word, label, inner);
  const above = time === null ? 0 : clock.size + 6;
  const top = turn.cy - (above + words.length * label.size * 1.1) / 2;
  if (time !== null) textBlock(card, [time], x + 6, top, inner, clock, clock.size, 'center', turn);
  textBlock(card, words, x + 6, top + above, inner, label, label.size * 1.1, 'center', turn);
}

/** Karta výzvy 1200×630 v rozměrech, které dřív kreslil `next/og`: okraj 56, mezera 56. */
function dareCard(spec: GameSpecV1, hero: RgbaImage | null, sun: DareBadge): Raster {
  const look = sceneLook(spec.theme);
  const card = raster(OG_WIDTH, OG_HEIGHT, hexToRgb(color.cream));

  // Vlevo „zamrzlá scéna“ 500×504: obloha a zem sady prostředí (spodních 170 px), hrdina na horizontu, rám kitu.
  const scene = framed(card, 56, 56, 500, 504, 48, hexToRgb(look.sky), 6, 14);
  paint(card, { ...scene, y0: scene.y1 - 170 }, hexToRgb(look.ground));
  const [cx, cy] = [56 + 250, 56 + 252];
  if (hero === null) {
    target(card, cx, cy);
  } else {
    // Náhled modelu má vlastní šedé pozadí: na scéně stojí jako karta hrdiny s rámem a stínem kitu.
    const frame = framed(card, cx - 165, cy - 165, 330, 330, 32, null, 6, 10);
    drawImage(card, hero, cx - 159, cy - 159, 318, 318, frame);
  }

  // Vpravo sloupec 532 px: název (display-m), odznak s „Can you beat it?“ a logo vpravo dole, rozestup jako CSS `space-between`.
  const [x, top, bottom, width] = [612, 64, 574, 532];
  const long = spec.title.length > 24;
  const titleStyle: TextStyle = { weight: 900, size: long ? 56 : 72, spacing: long ? -1.7 : -2.2 };
  const title = wrapText(spec.title, titleStyle, width);
  const titleHeight = title.length * titleStyle.size * 1.05;
  textBlock(card, title, x, top, width, titleStyle, titleStyle.size * 1.05, 'left');

  // Kdo vyzývá (P44B T7) stojí nad odznakem s jeho výsledkem.
  const leadStyle: TextStyle = { weight: 900, size: 40, spacing: -1.2 };
  const lead = sun.lead === undefined ? [] : wrapText(sun.lead, leadStyle, width);
  const leadHeight = lead.length === 0 ? 0 : lead.length * leadStyle.size * 1.05 + 20;
  const logo = logoImage();
  const y = top + titleHeight + Math.max(0, (bottom - top - titleHeight - leadHeight - 196 - logo.height) / 2);
  textBlock(card, lead, x, y, width, leadStyle, leadStyle.size * 1.05, 'left');
  badge(card, x, y + leadHeight, sun);
  // Šířka 240 láme otázku na „Can you / beat it?“, ne „Can you beat / it?“.
  const askStyle: TextStyle = { weight: 900, size: 54, spacing: -1.6 };
  const ask = wrapText(CAN_YOU_BEAT_IT, askStyle, 240);
  textBlock(card, ask, x + 196 + 36, y + leadHeight + (196 - ask.length * askStyle.size * 1.02) / 2, 240, askStyle, askStyle.size * 1.02, 'left');
  drawImage(card, logo, x + width - logo.width, bottom - logo.height, logo.width, logo.height);
  return card;
}

/**
 * Znaky, které má atlas glyfů karty (`../og/glyphs.json`: podmnožina latinky
 * z P34 T1, kterou mají oba řezy Roboto v `public/fonts/roboto`; generátor
 * atlasu bere tytéž rozsahy). Jiný znak karta nakreslí jen jako základní
 * písmeno, nebo vůbec – takový náhled nesmí být trvalý (nález revize T6-1).
 * `og.test.ts` rozsah měří na souborech písma i na atlasu.
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
   * `false`: obrázek hrdiny (ač ho katalog má) se nepodařilo získat, nebo
   * název či jméno autora má znak mimo atlas písma. Takový náhled se neukládá a
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
    const hero = await heroImage(model, origin);
    const sun = dare === null ? dareBadge(spec) : dareScoreBadge(spec, dare, by);
    const complete = (hero !== null || !THUMBNAILS.has(model)) && fontCovers(spec.title) && fontCovers(sun.lead ?? '');
    const png = encodePng(OG_WIDTH, OG_HEIGHT, dareCard(spec, hero, sun).rgb);
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
