/**
 * Náhled hry pro sdílený odkaz (P23-C T7). Stránka bez OG vypadá v prohlížeči
 * stejně – tenhle test drží, že obrázek je PNG 1200×630, liší se podle nálady,
 * nemá fialovou a neznámá hra dostane tutéž 404 jako čtení.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

import { OG_PALETTES, ogPngFor, paletteForMood } from '../_og';
import { POST as createGame } from '../games/route';
import { GET as ogImage } from '../games/[id]/og/route';

const CALLER = { 'x-forwarded-for': '203.0.113.7' };

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

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
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
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
  });

  it('404 NOT_FOUND JSON for an unknown and for a malformed id', async () => {
    for (const id of ['deadbeef', '../etc']) {
      const response = await og(id);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    }
  });
});

describe('mood palette', () => {
  it('keywords pick their palette, other moods land deterministically, different moods differ', () => {
    expect(paletteForMood('Calm').id).toBe('calm');
    expect(paletteForMood('very tense').id).toBe('tense');
    expect(paletteForMood('melancholic').id).toBe(paletteForMood('melancholic').id);
    expect(ogPngFor('calm')).not.toEqual(ogPngFor('tense'));
  });

  it('no purple in any palette (hue 250–320°)', () => {
    for (const palette of OG_PALETTES) {
      for (const hex of [...palette.bands, palette.accent]) {
        const hue = hueOf(hex);
        expect(hue === null || hue < 250 || hue > 320, `${palette.id} ${hex} ${String(hue)}`).toBe(true);
      }
    }
  });
});
