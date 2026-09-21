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

const ID = '0123456789abcdef';
const temporary: string[] = [];

async function render(): Promise<{ props: Record<string, unknown> }> {
  return (await PlayGamePage({ params: Promise.resolve({ id: ID }) })) as { props: Record<string, unknown> };
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
