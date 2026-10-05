/**
 * Sdílení po živých změnách (P29D T10, R3): kdy se publikuje nová verze a kdy
 * hráč uslyší, že část změn zůstala jen v běhu. Obě chyby vypadají jako
 * funkční sdílení – kopie rodiče pod novým id i odkaz, který mlčky ztratil
 * životy.
 */

import { describe, expect, it } from 'vitest';

import runner from '@/play/arcade/__fixtures__/runner.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import type { LivePatch } from '@/play/arcade/live';
import { readGameSpec } from '@/play/spec';

import { publishLive } from '../live-share';

const read = readGameSpec(runner);
if (!read.ok) throw new Error(read.issues.join('; '));
const spec = read.value;
const built = arcadeWorldOf(spec, 1);
if (!built.ok) throw new Error(built.issues.join('; '));
const world = built.world;

function poster(status = 201) {
  const calls: unknown[] = [];
  const post = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify(status < 300 ? { url: '/play/child-1' } : { error: 'no' }), { status });
  }) as typeof fetch;
  return { calls, post };
}

const RAIN: LivePatch = { kind: 'visual', weather: 'rain' };
const LIVES: LivePatch = { kind: 'count', counter: 'health', amount: 2 };

describe('sharing a run with live changes', () => {
  it('no live change shares nothing new', async () => {
    const { calls, post } = poster();
    expect(await publishLive('parent', spec, world, [], post)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('changes that all stay in the run share the played version, never a copy of the parent', async () => {
    const { calls, post } = poster();
    expect(await publishLive('parent', spec, world, [LIVES], post)).toEqual({ versionId: 'parent', partial: true });
    expect(calls).toHaveLength(0);
  });

  it('a change that fits the link publishes a child and says nothing is lost', async () => {
    const { calls, post } = poster();
    expect(await publishLive('parent', spec, world, [RAIN], post)).toEqual({ versionId: 'child-1', partial: false });
    expect(calls).toHaveLength(1);
  });

  it('a mix publishes the child and tells the player the rest stays in the run', async () => {
    const { calls, post } = poster();
    expect(await publishLive('parent', spec, world, [RAIN, LIVES], post)).toEqual({ versionId: 'child-1', partial: true });
    expect(calls).toHaveLength(1);
  });

  it('a refused publish is an error, not a silent share of the parent', async () => {
    const { post } = poster(500);
    await expect(publishLive('parent', spec, world, [RAIN], post)).rejects.toThrow('live version not published');
  });
});
