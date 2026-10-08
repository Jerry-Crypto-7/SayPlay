/**
 * Jméno vyzyvatele (P44B T7): `/play/[id]?dare=` dá hře k výzvě přezdívku jejího autora
 * (`DareRecord.by` → `getPlayer` → `shownNickname`), nikoho jiného. Cizí jméno u výzvy vypadá
 * jako správná výzva, proto test drží, čí jméno to je, a že id hráče do props nejde.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetProcessVersionStore, type DareRecord, versionStoreFromEnv } from '@/play/version';
import { defaultNickname } from '@/play/player/nickname';
import { resetRateWindows } from '@/server/rate-limit';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.41' }) }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('@/components/play/PlayShell', () => ({ PlayShell: () => null }));

const { default: PlayGamePage } = await import('@/app/play/[id]/page');
const { POST: createGame } = await import('@/app/api/play/games/route');
const { STARTERS } = await import('@/components/play/starters');

const ADA = 'A'.repeat(22);
const BO = 'B'.repeat(22);
const RUDE = 'C'.repeat(22);

async function arcadeId(): Promise<string> {
  for (const { sentence } of STARTERS) {
    const created = await createGame(new Request('http://play.test/api/play/games', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.42' }, body: JSON.stringify({ sentence }) }));
    const { url } = (await created.json()) as { url: string };
    const id = url.split('/').at(-1)!;
    if ((await versionStoreFromEnv(process.env).get(id))?.arcade !== undefined) return id;
  }
  throw new Error('no arcade starter');
}

async function challengeOf(id: string, dare: string): Promise<unknown> {
  const element = (await PlayGamePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ dare }) })) as { props: Record<string, unknown> };
  return (element.props.children as { props: Record<string, unknown> }[]).find((child) => 'challenge' in child.props)?.props.challenge;
}

beforeEach(() => {
  __resetProcessVersionStore();
  resetRateWindows();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/play/[id]?dare= names the challenger', () => {
  it("carries the dare author's nickname – not another player's, never the player id", async () => {
    const id = await arcadeId();
    const versions = versionStoreFromEnv(process.env);
    await versions.putPlayer(ADA, { nickname: 'Ada' });
    await versions.putPlayer(BO, { nickname: 'Bo' });
    const dare = (dareId: string, by?: string): DareRecord => ({ dareId, versionId: id, score: 2450, ticks: 1860, hash: '0', liveChanges: 0, createdAt: '2026-10-08T00:00:00.000Z', ...(by === undefined ? {} : { by }) });
    await versions.putDare(dare('a'.repeat(32), ADA));
    await versions.putDare(dare('b'.repeat(32), BO));
    await versions.putDare(dare('c'.repeat(32)));

    expect(await challengeOf(id, 'a'.repeat(32))).toEqual({ score: 2450, ticks: 1860, liveChanges: 0, by: 'Ada' });
    expect(await challengeOf(id, 'b'.repeat(32))).toEqual({ score: 2450, ticks: 1860, liveChanges: 0, by: 'Bo' });
    // Výzva bez identity: žádné `by`, proužek a náhled mají dnešní text.
    expect(await challengeOf(id, 'c'.repeat(32))).toEqual({ score: 2450, ticks: 1860, liveChanges: 0 });
    expect(JSON.stringify(await challengeOf(id, 'a'.repeat(32)))).not.toContain(ADA);
  });

  it('shows the default name for an author without a nickname or with one that no longer passes', async () => {
    const id = await arcadeId();
    const versions = versionStoreFromEnv(process.env);
    // Uloženo před T3a: dnes `readNickname` jméno odmítne a ukáže se výchozí.
    await versions.putPlayer(RUDE, { nickname: 'kurva' });
    const dare = (dareId: string, by: string): DareRecord => ({ dareId, versionId: id, score: 0, ticks: 1860, hash: '0', liveChanges: 0, createdAt: '2026-10-08T00:00:00.000Z', by });
    await versions.putDare(dare('d'.repeat(32), RUDE));
    await versions.putDare(dare('e'.repeat(32), BO));

    expect(await challengeOf(id, 'd'.repeat(32))).toMatchObject({ by: defaultNickname(RUDE) });
    expect(await challengeOf(id, 'e'.repeat(32))).toMatchObject({ by: defaultNickname(BO) });
  });
});
