/**
 * Náhled hry pro sdílený odkaz (P23-C T7). Stránka bez OG vypadá v prohlížeči
 * stejně – tenhle test drží, že obrázek je PNG 1200×630, liší se podle nálady,
 * nemá fialovou a neznámá hra dostane tutéž 404 jako čtení.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import runnerFixture from '@/play/arcade/__fixtures__/runner.json';

import { OG_INK, OG_PALETTES, assetOriginFrom, ogPngFor, paletteForMood } from '../_og';
import { POST as createGame } from '../games/route';
import { GET as ogImage } from '../games/[id]/og/route';

const CALLER = { 'x-forwarded-for': '203.0.113.7' };

// Selhání renderu na požádání: `ImageResponse` hodí dřív, než začne kreslit.
const failRender = vi.hoisted(() => ({ value: false }));
vi.mock('next/og', async (importOriginal) => {
  const real = await importOriginal<typeof import('next/og')>();
  class FlakyImageResponse extends real.ImageResponse {
    constructor(...args: ConstructorParameters<typeof real.ImageResponse>) {
      if (failRender.value) throw new Error('render failed on purpose');
      super(...args);
    }
  }
  return { ...real, ImageResponse: FlakyImageResponse };
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
