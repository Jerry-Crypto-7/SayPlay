import type { RootState } from '@react-three/fiber';
import { describe, expect, it } from 'vitest';

import thumbs from '../feed-thumbs.json';
import { type FrameStore, captureFrame, cardImage, createSnapshotCache, indexedFrames, keepFrame } from '../snapshot-cache';

/** `objectURL` jako počitadlo: kolik se vytvořilo a které se uvolnily. */
function urls() {
  let made = 0;
  const revoked: string[] = [];
  return { revoked, create: () => `blob:shot-${String((made += 1))}`, revoke: (href: string) => void revoked.push(href) };
}

const blob = new Blob(['x']);

/** IndexedDB prohlížeče jako mapa, která přežije „reload“ (novou cache nad týmž úložištěm). */
function memoryStore(): FrameStore & { readonly saved: Map<string, Blob> } {
  const saved = new Map<string, Blob>();
  return {
    saved,
    save: async (versionId, frame) => {
      saved.delete(versionId);
      saved.set(versionId, frame);
    },
    load: async () => [...saved.entries()],
  };
}

/** Úložiště, které selže při čtení i zápisu (Safari v anonymním okně, plný disk). */
const brokenStore: FrameStore = {
  save: () => Promise.reject(new Error('QuotaExceededError')),
  load: () => Promise.reject(new Error('InvalidStateError')),
};

describe('snapshot-cache', () => {
  it('drží nejvýš limit snímků a vyřadí ten, ze kterého hráč odešel nejdřív', () => {
    const fake = urls();
    const cache = createSnapshotCache(3, fake);
    for (const id of ['a', 'b', 'c', 'd']) cache.put(id, blob);
    expect(cache.size).toBe(3);
    expect(cache.get('a')).toBeUndefined();
    expect(['b', 'c', 'd'].map((id) => cache.get(id))).toEqual(['blob:shot-2', 'blob:shot-3', 'blob:shot-4']);
    expect(fake.revoked).toEqual(['blob:shot-1']);
  });

  it('nový snímek téže hry uvolní starý a posune hru na konec fronty', () => {
    const fake = urls();
    const cache = createSnapshotCache(3, fake);
    for (const id of ['a', 'b', 'c']) cache.put(id, blob);
    expect(cache.put('a', blob)).toBe('blob:shot-4');
    expect(fake.revoked).toEqual(['blob:shot-1']);
    cache.put('d', blob);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('blob:shot-4');
    expect(fake.revoked).toEqual(['blob:shot-1', 'blob:shot-2']);
  });

  it('po 50 odchodech přes 25 her drží 20 živých URL a každé vyřazené uvolní právě jednou', () => {
    const fake = urls();
    const cache = createSnapshotCache(undefined, fake);
    for (let i = 0; i < 50; i += 1) cache.put(`g${String(i % 25)}`, blob);
    expect(cache.size).toBe(20);
    expect(fake.revoked).toHaveLength(30);
    expect(new Set(fake.revoked).size).toBe(30);
  });
});

describe('snapshot-cache: snímek vlastní hry přežije reload (P56B T12)', () => {
  it('hra, kterou návštěvník hrál nebo vytvořil, má po reloadu snímek; /og jen cizí nenavštívená hra mimo kurátorskou sadu', async () => {
    const store = memoryStore();
    // Vytvořená hra: snímek po prvních snímcích na její stránce. Hraná ve feedu: snímek při odchodu z karty.
    await keepFrame('created', blob, store);
    createSnapshotCache(20, urls(), store).put('played', blob);
    await Promise.resolve();
    const reloaded = createSnapshotCache(20, urls(), store);
    expect(await reloaded.restore()).toBe(2);
    expect(reloaded.get('created')).toMatch(/^blob:/);
    expect(reloaded.get('played')).toMatch(/^blob:/);
    expect(reloaded.get('foreign')).toBeUndefined();
    expect(cardImage('foreign')).toEqual({ portrait: '/api/play/games/foreign/og', landscape: '/api/play/games/foreign/og' });
    const curated = thumbs[0]!;
    expect(cardImage(curated).portrait).toBe(`/feed-thumbs/${curated}-p.webp`);
  });

  it('obnova nepřepíše snímek z této návštěvy a drží pořadí odchodů', async () => {
    const store = memoryStore();
    for (const id of ['a', 'b']) await keepFrame(id, blob, store);
    const cache = createSnapshotCache(2, urls(), store);
    const fresh = cache.put('a', blob);
    await cache.restore();
    expect(cache.get('a')).toBe(fresh);
    // Strop 2: `b` z úložiště je starší než dnešní odchod z `a` a vypadne první.
    cache.put('c', blob);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(fresh);
  });

  it('selhané úložiště nic nerozbije: snímek zůstane v paměti, obnova vrátí nulu', async () => {
    const cache = createSnapshotCache(20, urls(), brokenStore);
    expect(cache.put('a', blob)).toBe('blob:shot-1');
    await expect(keepFrame('b', blob, brokenStore)).resolves.toBeUndefined();
    await expect(cache.restore()).resolves.toBe(0);
    expect(cache.get('a')).toBe('blob:shot-1');
  });

  it('bez IndexedDB (server, starý prohlížeč) úložiště nic neuloží ani nevyhodí', async () => {
    const store = indexedFrames();
    await expect(store.save('a', blob)).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual([]);
  });
});

/** Kořen R3F jen s tím, co `captureFrame` čte: snímek navíc a kopie plátna se zapisují do `calls`. */
function root(presenting: boolean) {
  const calls: string[] = [];
  const state = {
    advance: () => void calls.push('advance'),
    gl: {
      xr: { isPresenting: presenting },
      domElement: {
        toBlob: (done: BlobCallback) => {
          calls.push('toBlob');
          done(blob);
        },
      },
    },
  } as unknown as Pick<RootState, 'advance' | 'gl'>;
  return { state, calls };
}

describe('captureFrame (P67 T14)', () => {
  it('mimo VR nakreslí snímek navíc a vrátí obrázek plátna', async () => {
    const { state, calls } = root(false);
    await expect(captureFrame(state)).resolves.toBe(blob);
    expect(calls).toEqual(['advance', 'toBlob']);
  });

  it('ve VR snímek navíc nekreslí: bez snímku relace by ovladače ztratily pózu a paprsek tlačítko', async () => {
    const { state, calls } = root(true);
    await expect(captureFrame(state)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});
