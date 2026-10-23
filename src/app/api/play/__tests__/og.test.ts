/**
 * Náhled hry pro sdílený odkaz (P23-C T7). Stránka bez OG vypadá v prohlížeči
 * stejně – tenhle test drží, že obrázek je PNG 1200×630, liší se podle nálady,
 * nemá fialovou a neznámá hra dostane tutéž 404 jako čtení. Od P58C T2 kartu
 * kreslí vlastní rastr bez `next/og` (MPL-2.0) – test čte pixely dekódovaného PNG.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { color } from '@/brand/tokens';
import type { GameSpecV1 } from '@/play/spec';
import { __resetProcessVersionStore, type DareRecord, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import runnerFixture from '@/play/arcade/__fixtures__/runner.json';

import { decodePng, hexToRgb } from '../../og/png';
import { hasGlyph } from '../../og/raster';
import { OG_INK, OG_PALETTES, assetOriginFrom, dareBadge, dareScoreBadge, fontCovers, ogPngFor, paletteForMood } from '../_og';
import { POST as createGame } from '../games/route';
import { GET as ogImage } from '../games/[id]/og/route';

const CALLER = { 'x-forwarded-for': '203.0.113.7' };

// Selhání renderu na požádání: text karty hodí dřív, než se nakreslí.
const failRender = vi.hoisted(() => ({ value: false }));
vi.mock('../../og/raster', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../og/raster')>();
  return {
    ...real,
    drawText: (...args: Parameters<typeof real.drawText>) => {
      if (failRender.value) throw new Error('render failed on purpose');
      real.drawText(...args);
    },
  };
});

/** Dekódovaná karta a kolik pixelů obdélníku má (do tolerance) danou barvu. */
async function cardOf(response: Response): Promise<{ width: number; count: (hex: string, x0: number, y0: number, x1: number, y1: number) => number }> {
  const { width, height, rgba } = decodePng(new Uint8Array(await response.arrayBuffer()));
  expect([width, height]).toEqual([1200, 630]);
  return {
    width,
    count(hex, x0, y0, x1, y1) {
      const want = hexToRgb(hex);
      let hits = 0;
      for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) if (want.every((v, c) => Math.abs(rgba[(y * width + x) * 4 + c] - v) <= 8)) hits += 1;
      return hits;
    },
  };
}

// Soubor náhledu hrdiny chybí na požádání – jako funkce na Vercelu, která `public/` nenese.
const noPublicFiles = vi.hoisted(() => ({ value: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (...args: Parameters<typeof real.readFile>) => {
    if (noPublicFiles.value && String(args[0]).includes(`${join('public', 'assets')}`)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return real.readFile(...args);
  }) as typeof real.readFile;
  return { ...real, default: { ...real, readFile }, readFile };
});

async function publishSpec(title: string): Promise<string> {
  const created = await createGame(
    new Request('http://play.test/api/play/games', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...CALLER },
      body: JSON.stringify({ spec: { ...runnerFixture, title } }),
    }),
  );
  expect(created.status, await created.clone().text()).toBeLessThan(300);
  return ((await created.json()) as { versionId: string }).versionId;
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function og(id: string): Promise<Response> {
  return ogImage(new Request(`http://play.test/api/play/games/${id}/og`, { headers: CALLER }), params(id));
}

function hueOf(hex: string): number | null {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const span = max - Math.min(r, g, b);
  if (span === 0) return null;
  const hue = max === r ? ((g - b) / span) % 6 : max === g ? (b - r) / span + 2 : (r - g) / span + 4;
  return (((hue * 60) % 360) + 360) % 360;
}

const temporary: string[] = [];

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WORLDSMITH_CONTROL_FILE;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('GET /api/play/games/:id/og', () => {
  it('200 PNG 1200×630 with edge caching for a published game', async () => {
    const created = await createGame(
      new Request('http://play.test/api/play/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CALLER },
        body: JSON.stringify({ sentence: 'Collect five glowing mushrooms then open a portal.' }),
      }),
    );
    expect(created.status).toBe(201);
    const { versionId } = (await created.json()) as { versionId: string };

    const response = await og(versionId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-og-fallback')).toBeNull();
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  });

  it('draws each version from its own game: two titles, two images, and the first stays as it was (P27B T6)', async () => {
    const first = await publishSpec('Canyon Dash');
    const second = await publishSpec('Rooftop Sprint');
    const a = new Uint8Array(await (await og(first)).arrayBuffer());
    const b = new Uint8Array(await (await og(second)).arrayBuffer());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    // Paletový náhled je pro obě stejný (týž spec, táž nálada) – rozdíl dělá obsah hry.
    expect(Buffer.from(a).equals(Buffer.from(ogPngFor(runnerFixture.theme.mood)))).toBe(false);
    const again = new Uint8Array(await (await og(first)).arrayBuffer());
    expect(Buffer.from(again).equals(Buffer.from(a))).toBe(true);
  });

  it('a render failure falls back to the palette PNG, flagged and not cached for a year', async () => {
    const versionId = await publishSpec('Broken Render');
    failRender.value = true;
    try {
      const response = await og(versionId);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('x-og-fallback')).toBe('1');
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
      expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(ogPngFor(runnerFixture.theme.mood)))).toBe(true);
    } finally {
      failRender.value = false;
    }
    // Selhání se nezapamatovalo: další požadavek už kreslí hru.
    expect((await og(versionId)).headers.get('x-og-fallback')).toBeNull();
  });

  it('a preview without its hero is served for an hour, flagged partial, and drawn again next time (review T6-1)', async () => {
    const versionId = await publishSpec('Missing Hero');
    noPublicFiles.value = true;
    try {
      const response = await og(versionId);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-og-partial')).toBe('1');
      expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    } finally {
      noPublicFiles.value = false;
    }
    // Nezapamatoval se: soubor je zpátky a náhled je úplný.
    const healed = await og(versionId);
    expect(healed.headers.get('x-og-partial')).toBeNull();
    expect(healed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('text outside the bundled font is never cached as immutable, even when the render succeeds (review T6-1)', async () => {
    expect(fontCovers('Canyon Dash – “Go” café…')).toBe(true);
    expect(fontCovers('峡谷ダッシュ')).toBe(false);
    // Atlas znaky nemá: karta se nakreslí bez nich – právě ten případ.
    const versionId = await publishSpec('峡谷ダッシュ');
    const response = await og(versionId);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-og-partial')).toBe('1');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
  });

  // P58C T2: kartu kreslí vlastní rastr. Prázdný nebo rozbitý obrázek by prošel kontrolou hlavičky – proto pixely.
  it('draws the dare card itself: scene, hero, title, sun badge and logo where the kit puts them (P58C T2)', async () => {
    const response = await og(await publishSpec('Canyon Dash'));
    expect(response.headers.get('x-og-partial')).toBeNull();
    const card = await cardOf(response);
    expect(card.count(color.cream, 0, 0, 50, 50)).toBe(2500);
    // Obloha scény vlevo nahoře uvnitř rámu, inkoustový rám a tvrdý stín vpravo dole.
    const { sky } = (await import('@/play/arcade/look')).sceneLook(runnerFixture.theme);
    expect(card.count(sky, 100, 80, 140, 120)).toBe(1600);
    expect(card.count(color.ink, 56, 300, 62, 310)).toBe(60);
    expect(card.count(color.ink, 560, 300, 570, 310)).toBe(100);
    // Hrdina v rámu: náhled modelu není barva scény.
    expect(card.count(sky, 160, 160, 450, 450)).toBeLessThan(1000);
    // Název: jeden řádek 72 px nahoře v pravém sloupci; pod ním nic do odznaku.
    expect(card.count(color.ink, 612, 64, 1144, 140)).toBeGreaterThan(3000);
    expect(card.count(color.cream, 612, 150, 1144, 220)).toBe(532 * 70);
    // Slunečný odznak (kruh 196, mezi názvem a logem) a otázka vedle něj.
    expect(card.count(color.sun, 612, 200, 812, 460)).toBeGreaterThan(15_000);
    expect(card.count(color.ink, 844, 250, 1144, 410)).toBeGreaterThan(3000);
    // Logo vpravo dole: rajčatová ikona a inkoustové písmo.
    expect(card.count(color.tomato, 930, 514, 1144, 574)).toBeGreaterThan(300);
    expect(card.count(color.ink, 930, 514, 1144, 574)).toBeGreaterThan(300);
  });

  it('draws a target instead of a hero the catalog cannot serve (P58C T2)', async () => {
    const versionId = await publishSpec('No Hero');
    noPublicFiles.value = true;
    try {
      const card = await cardOf(await og(versionId));
      // Terč se středem uprostřed scény: rajčatový střed, bílý kruh, slunečný okraj.
      expect(card.count(color.tomato, 296, 298, 316, 318)).toBe(400);
      expect(card.count(color.paper, 306 + 50, 303, 306 + 60, 313)).toBe(100);
      expect(card.count(color.sun, 306 + 100, 303, 306 + 110, 313)).toBe(100);
    } finally {
      noPublicFiles.value = false;
    }
  });

  it('nothing in src/ imports next/og, satori or resvg – MPL-2.0 stays out of the product (P58C T2)', () => {
    const banned = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:next\/og|@vercel\/og|satori|@resvg\/[\w-]+)['"]|\bImageResponse\b/;
    // Soubory v gitu i nové necommitnuté – ne celý strom, ten má i vygenerovaná data.
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { encoding: 'utf8' }).split('\n');
    const code = files.filter((path) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(path) && !path.endsWith('__tests__/og.test.ts'));
    expect(code.length).toBeGreaterThan(500);
    expect(code.filter((path) => banned.test(readFileSync(path, 'utf8')))).toEqual([]);
  });

  // P34 T7: karta kreslí Roboto z `public/fonts/roboto` (Black a Bold), od P58C T2 z atlasu glyfů.
  it('accepts only characters both bundled Roboto cuts really have (review T6-2)', async () => {
    const { readFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    // cmap formát 4 (Windows, Unicode BMP): kódy, které mají glyf.
    const coveredBy = (file: string): Set<number> => {
      const font = readFileSync(join(process.cwd(), 'public/fonts/roboto', file));
      let cmap = -1;
      for (let i = 0; i < font.readUInt16BE(4); i += 1) if (font.toString('latin1', 12 + i * 16, 16 + i * 16) === 'cmap') cmap = font.readUInt32BE(12 + i * 16 + 8);
      const covered = new Set<number>();
      for (let i = 0; i < font.readUInt16BE(cmap + 2); i += 1) {
        const sub = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
        if (font.readUInt16BE(sub) !== 4) continue;
        const segs = font.readUInt16BE(sub + 6) / 2;
        const [ends, starts] = [sub + 14, sub + 16 + segs * 2];
        const [deltas, offsets] = [starts + segs * 2, starts + segs * 4];
        for (let s = 0; s < segs; s += 1) {
          const [start, end, delta, ro] = [font.readUInt16BE(starts + s * 2), font.readUInt16BE(ends + s * 2), font.readInt16BE(deltas + s * 2), font.readUInt16BE(offsets + s * 2)];
          for (let c = start; c <= end && c !== 0xffff; c += 1) {
            const raw = ro === 0 ? c : font.readUInt16BE(offsets + s * 2 + ro + (c - start) * 2);
            if (raw !== 0 && ((raw + delta) & 0xffff) !== 0) covered.add(c);
          }
        }
      }
      return covered;
    };
    const [black, bold] = [coveredBy('Roboto-Black.ttf'), coveredBy('Roboto-Bold.ttf')];
    const accepted: number[] = [];
    for (let c = 0; c <= 0x10ffff; c += c === 0xd7ff ? 0x801 : 1) if (fontCovers(String.fromCodePoint(c))) accepted.push(c);
    expect(accepted.length).toBeGreaterThan(250);
    expect(accepted.filter((c) => !black.has(c) || !bold.has(c)).map((c) => c.toString(16))).toEqual([]);
    // P58C T2: karta kreslí z atlasu – každý přijatý znak v něm má glyf Black, slovo odznaku (ASCII) i Bold.
    expect(accepted.filter((c) => !hasGlyph(String.fromCodePoint(c))).map((c) => c.toString(16))).toEqual([]);
    expect(Array.from({ length: 0x7f - 0x20 }, (_, i) => String.fromCodePoint(0x20 + i)).filter((ch) => !hasGlyph(ch, 700))).toEqual([]);
    expect(fontCovers('Sky-High Run – “Go”')).toBe(true);
    // Podmnožina je latinka 1: česká diakritika v ní není a jde přes stažené písmo (dočasný náhled).
    expect(fontCovers('Běžec')).toBe(false);
  });

  // Obyčejný odkaz nenese něčí běh: karta ukáže čas jen tam, kde ho hra sama měří (P34 T6).
  it('puts on the dare badge only a time the game itself measures (P34 T7)', () => {
    const spec = runnerFixture as unknown as GameSpecV1;
    expect(dareBadge(spec)).toEqual({ time: null, word: 'Your turn!' });
    expect(dareBadge({ ...spec, objective: { kind: 'survive', description: 'Last it.', seconds: 60 } })).toEqual({ time: '60s', word: 'Survive!' });
    const timer = (onEnd: 'win' | 'lose'): GameSpecV1 => ({ ...spec, mechanics: [{ id: 'timer', params: { id: 'clock', seconds: 45, onEnd } }] });
    expect(dareBadge(timer('lose'))).toEqual({ time: '45s', word: 'Hurry!' });
    expect(dareBadge(timer('win'))).toEqual({ time: '45s', word: 'Survive!' });
  });

  // P36B T8: odkaz výzvy nese výsledek kamaráda – body, bez bodů jeho čas; přežití bez bodů zůstává „Survive!“.
  it("puts the friend's verified score on a dare link's badge", () => {
    const spec = runnerFixture as unknown as GameSpecV1;
    expect(dareScoreBadge(spec, { score: 2450, ticks: 1860 })).toEqual({ time: '2,450', word: 'to beat' });
    expect(dareScoreBadge(spec, { score: 0, ticks: 1860 })).toEqual({ time: '31.0s', word: 'to beat' });
    const survive: GameSpecV1 = { ...spec, objective: { kind: 'survive', description: 'Last it.', seconds: 60 } };
    expect(dareScoreBadge(survive, { score: 0, ticks: 3600 })).toEqual({ time: '60s', word: 'Survive!' });
    expect(dareScoreBadge(survive, { score: 12450, ticks: 3600 })).toEqual({ time: '12,450', word: 'to beat' });
    // P44B T7: s autorem nese odznak nad skóre jeho jméno; bez autora dnešní text.
    expect(dareScoreBadge(spec, { score: 2450, ticks: 1860 }, 'Ada')).toEqual({ time: '2,450', word: 'to beat', lead: 'Ada dares you' });
    expect(dareScoreBadge(survive, { score: 0, ticks: 3600 }, 'Bo')).toEqual({ time: '60s', word: 'Survive!', lead: 'Bo dares you' });
  });

  it("draws a dare link's card from its dare; a foreign, unknown or malformed dare gets the plain card for an hour (P36B T8)", async () => {
    const game = await publishSpec('Canyon Dash');
    const other = await publishSpec('Rooftop Sprint');
    const versions = versionStoreFromEnv(process.env);
    const dare = (dareId: string, versionId: string): DareRecord => ({ dareId, versionId, score: 2450, ticks: 1860, hash: 'f'.repeat(8), liveChanges: 0, createdAt: new Date().toISOString() });
    const mine = 'a'.repeat(32);
    const foreign = 'b'.repeat(32);
    expect(await versions.putDare(dare(mine, game))).toBe('stored');
    expect(await versions.putDare(dare(foreign, other))).toBe('stored');
    const withDare = (id: string, value: string): Promise<Response> =>
      ogImage(new Request(`http://play.test/api/play/games/${id}/og?dare=${encodeURIComponent(value)}`, { headers: CALLER }), params(id));

    const plain = Buffer.from(await (await og(game)).arrayBuffer());
    const challenged = await withDare(game, mine);
    expect(challenged.status).toBe(200);
    expect(challenged.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await challenged.arrayBuffer()).equals(plain)).toBe(false);

    for (const value of [foreign, 'c'.repeat(32), 'not-a-dare']) {
      const response = await withDare(game, value);
      expect(response.status, value).toBe(200);
      expect(response.headers.get('cache-control'), value).toBe('public, max-age=0, s-maxage=3600');
      expect(Buffer.from(await response.arrayBuffer()).equals(plain), value).toBe(true);
    }
  });

  it("draws the dare author's own validated name, for an hour – never another player's (P44B T7)", async () => {
    const game = await publishSpec('Canyon Dash');
    const versions = versionStoreFromEnv(process.env);
    const [ada, bo, rude] = ['A', 'B', 'C'].map((letter) => letter.repeat(22)) as [string, string, string];
    await versions.putPlayer(ada, { nickname: 'Ada' });
    await versions.putPlayer(bo, { nickname: 'Bo' });
    const dare =(dareId: string, by?: string): DareRecord => ({ dareId, versionId: game, score: 2450, ticks: 1860, hash: 'f'.repeat(8), liveChanges: 0, createdAt: new Date().toISOString(), ...(by === undefined ? {} : { by }) });
    const ids = { anon: '1'.repeat(32), ada: '2'.repeat(32), ada2: '3'.repeat(32), bo: '4'.repeat(32), rude: '5'.repeat(32), rude2: '6'.repeat(32) };
    await versions.putDare(dare(ids.anon));
    await versions.putDare(dare(ids.ada, ada));
    await versions.putDare(dare(ids.ada2, ada));
    await versions.putDare(dare(ids.bo, bo));
    await versions.putDare(dare(ids.rude, rude));
    await versions.putDare(dare(ids.rude2, rude));
    const card =async (dareId: string): Promise<{ cache: string | null; png: Buffer }> => {
      const response = await ogImage(new Request(`http://play.test/api/play/games/${game}/og?dare=${dareId}`, { headers: CALLER }), params(game));
      expect(response.status).toBe(200);
      return { cache: response.headers.get('cache-control'), png: Buffer.from(await response.arrayBuffer()) };
    };

    const anon = await card(ids.anon);
    const byAda = await card(ids.ada);
    expect(anon.cache).toBe('public, max-age=31536000, immutable');
    // Jméno se smí změnit: karta se jménem žije hodinu, ne rok.
    expect(byAda.cache).toBe('public, max-age=0, s-maxage=3600');
    expect(byAda.png.equals(anon.png)).toBe(false);
    expect((await card(ids.ada2)).png.equals(byAda.png)).toBe(true);
    expect((await card(ids.bo)).png.equals(byAda.png)).toBe(false);
    // Uložené jméno, které dnes neprojde, se nekreslí: karta je táž jako s výchozím jménem téhož hráče.
    const rudeDefault = await card(ids.rude2);
    await versions.putPlayer(rude, { nickname: 'kurva' });
    expect((await card(ids.rude)).png.equals(rudeDefault.png)).toBe(true);
    expect(rudeDefault.png.equals(byAda.png)).toBe(false);
  });

  it('fetches a hero thumbnail only from a configured origin, never from the request host', () => {
    expect(assetOriginFrom({})).toBeNull();
    expect(assetOriginFrom({ VERCEL_URL: 'play-abc.vercel.app' })).toBe('https://play-abc.vercel.app');
    expect(assetOriginFrom({ SITE_URL: 'https://play.example/', VERCEL_URL: 'play-abc.vercel.app' })).toBe('https://play.example');
  });

  it('404 NOT_FOUND JSON for an unknown and for a malformed id', async () => {
    for (const id of ['deadbeef', '../etc']) {
      const response = await og(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    }
  });

  it('same gates as the read door: 51st request → 429 with retry-after, kill switch → 503 DISABLED', async () => {
    // Okno stropu je 10 s wall-clocku; pod zátěží by se smyčka přehoupla přes hranici.
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
    for (let i = 0; i < 50; i += 1) expect((await og('deadbeef')).status).toBe(404);
    const limited = await og('deadbeef');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);

    const dir = mkdtempSync(join(tmpdir(), 'play-og-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off: ['all'] }));
    process.env.WORLDSMITH_CONTROL_FILE = file;
    resetRateWindows();
    const disabled = await og('deadbeef');
    expect(disabled.status).toBe(503);
    expect((await disabled.json()).error.code).toBe('DISABLED');
  });
});

describe('mood palette', () => {
  it('keywords pick their palette, other moods land deterministically, different moods differ', () => {
    expect(paletteForMood('Calm').id).toBe('calm');
    expect(paletteForMood('very tense').id).toBe('tense');
    expect(paletteForMood('melancholic').id).toBe('cartoon');
    expect(ogPngFor('calm')).not.toEqual(ogPngFor('tense'));
  });

  it('no purple in any palette or in the ink of the game preview (hue 250–320°)', () => {
    for (const palette of [...OG_PALETTES, { id: 'ink', bands: OG_INK, accent: OG_INK[0] }]) {
      for (const hex of [...palette.bands, palette.accent]) {
        const hue = hueOf(hex);
        expect(hue === null || hue < 250 || hue > 320, `${palette.id} ${hex} ${String(hue)}`).toBe(true);
      }
    }
  });
});
