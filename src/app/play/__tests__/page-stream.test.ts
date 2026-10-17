/**
 * Stránka sdílené hry pošle hru dřív, než se změří poctivá hláška (P50 T4).
 * `honestyOf` hraje svědecké běhy hry (fyzika, sondy); na serveru, který hru
 * ještě neviděl, stál první bajt 117–1111 ms (lokálně, 10 her, 17. 10.). Pin:
 * stránka, která na hlášku zase počká, vypadá správně – jen se načítá pomaleji.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Honesty } from '@/play/draft/unsupported';
import { __resetProcessVersionStore } from '@/play/version';
import { resetRateWindows } from '@/server/rate-limit';

const honesty = vi.hoisted(() => ({ pending: null as Promise<Honesty | null> | null, calls: 0 }));

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.31' }) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/play/PlayShell', () => ({ PlayShell: () => null }));
vi.mock('@/play/draft/unsupported', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/play/draft/unsupported')>()),
  honestyOf: () => {
    honesty.calls += 1;
    return honesty.pending!;
  },
}));

const { default: PlayGamePage } = await import('../[id]/page');
const { POST: createGame } = await import('@/app/api/play/games/route');
const { STARTERS } = await import('@/components/play/starters');

async function gameId(): Promise<string> {
  const created = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.32' }, body: JSON.stringify({ sentence: STARTERS[0]!.sentence }) }));
  const { url } = (await created.json()) as { url: string };
  honesty.calls = 0;
  return url.split('/').at(-1)!;
}

/** Props `PlayShell` ze stránky (fragment: Rapier, shell). */
async function shellProps(id: string): Promise<Record<string, unknown>> {
  const page = (await PlayGamePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })) as { props: { children: { props: Record<string, unknown> }[] } };
  return page.props.children.find((child) => 'honesty' in child.props)!.props;
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
  // Hru zakládá route, která hlášku měří taky – ta dostane hotovou `null`.
  honesty.pending = Promise.resolve(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/play/[id] streams the honesty line', () => {
  it('returns the game while the honesty measurement is still running', async () => {
    const id = await gameId();
    honesty.pending = new Promise(() => undefined);
    const props = await Promise.race([shellProps(id), new Promise<'blocked'>((done) => setTimeout(() => done('blocked'), 2000))]);

    expect(props).not.toBe('blocked');
    expect((props as Record<string, unknown>).versionId).toBe(id);
    expect(honesty.calls).toBe(1);
  });

  it('hands the shell the measurement of this game, which settles later', async () => {
    const id = await gameId();
    let settle!: (value: Honesty | null) => void;
    honesty.pending = new Promise((done) => (settle = done));
    const props = await shellProps(id);
    const line: Honesty = { kind: 'played_as', closest: 'collect', reason: 'Jumps plays as hop.' } as unknown as Honesty;

    expect(props.honesty).toBeInstanceOf(Promise);
    settle(line);
    await expect(props.honesty).resolves.toBe(line);
  });
});
