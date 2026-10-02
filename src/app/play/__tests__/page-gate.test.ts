/**
 * Stránka `/play/[id]` čte úložiště přímo, ne přes dveře, a proto nese jejich
 * brány sama (nález revize fáze 4, 21. 9. 2026). Tenhle test drží, že vypínač
 * i strop frekvence odmítnou **dřív**, než se sáhne na úložiště – jinak smyčka
 * nad `/play/<hex>` točí placená čtení a vypínač ji nezastaví.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore, versionStoreFromEnv } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.21' }) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/play/PlayShell', () => ({ PlayShell: () => null }));

const { default: PlayGamePage } = await import('../[id]/page');
const { POST: createGame } = await import('@/app/api/play/games/route');
const { STARTERS } = await import('@/components/play/starters');

const ID = '0123456789abcdef';
const temporary: string[] = [];

async function render(id = ID, search: Record<string, string> = {}): Promise<{ props: Record<string, unknown> }> {
  return (await PlayGamePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) })) as { props: Record<string, unknown> };
}

function busy(element: { props: Record<string, unknown> }): boolean {
  const child = element.props.children as { props?: Record<string, unknown> } | undefined;
  return child?.props?.['data-testid'] === 'play-busy';
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.WORLDSMITH_CONTROL_FILE;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('/play/[id] page gate', () => {
  it('kill switch → play-busy and no store read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'play-page-kill-'));
    temporary.push(dir);
    const file = join(dir, 'control.json');
    writeFileSync(file, JSON.stringify({ off: ['all'] }));
    process.env.WORLDSMITH_CONTROL_FILE = file;

    const get = vi.spyOn(versionStoreFromEnv(process.env), 'get');
    expect(busy(await render())).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('rate limit: 51st request in the window → play-busy and no store read', async () => {
    const get = vi.spyOn(versionStoreFromEnv(process.env), 'get');
    for (let i = 0; i < 50; i += 1) await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(get).toHaveBeenCalledTimes(50);
    get.mockClear();
    expect(busy(await render())).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});

/** Výzva z odkazu (P36B T7): stránka dá hře jen výzvu téže hry; cizí, neplatná nebo neznámá = hra bez výzvy. */
describe('/play/[id]?dare= – the friend’s verified result', () => {
  async function arcadeId(): Promise<string> {
    for (const { sentence } of STARTERS) {
      const created = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.22' }, body: JSON.stringify({ sentence }) }));
      const { url } = (await created.json()) as { url: string };
      const id = url.split('/').at(-1)!;
      if ((await versionStoreFromEnv(process.env).get(id))?.arcade !== undefined) return id;
    }
    throw new Error('no arcade starter');
  }

  const challengeOf = (element: { props: Record<string, unknown> }): unknown =>
    (element.props.children as { props: Record<string, unknown> }[]).find((child) => 'challenge' in child.props)?.props.challenge;

  it('a dare of this game reaches the game; another game’s, a malformed or an unknown one does not', async () => {
    const id = await arcadeId();
    const versions = versionStoreFromEnv(process.env);
    const dare = (dareId: string, versionId: string) => ({ dareId, versionId, score: 2450, ticks: 1860, hash: '0', liveChanges: 1, createdAt: '2026-10-02T00:00:00.000Z' });
    await versions.putDare(dare('a'.repeat(32), id));
    await versions.putDare(dare('b'.repeat(32), 'fedcba9876543210'));

    expect(challengeOf(await render(id, { dare: 'a'.repeat(32) }))).toEqual({ score: 2450, ticks: 1860, liveChanges: 1 });
    expect(challengeOf(await render(id, { dare: 'b'.repeat(32) }))).toBeNull();
    expect(challengeOf(await render(id, { dare: 'A'.repeat(32) }))).toBeNull();
    expect(challengeOf(await render(id, { dare: 'c'.repeat(32) }))).toBeNull();
    expect(challengeOf(await render(id))).toBeNull();
  });
});
