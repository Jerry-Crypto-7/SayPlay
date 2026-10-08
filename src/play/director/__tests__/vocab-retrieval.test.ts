/**
 * Režisér čte tutéž tabulku sloves jako návrh (P44C T11). Bez ní by napsal jinou hru než návrh
 * a rozdíl by vypadal jako běžná variabilita AI – proto test pinuje zprávu, příklady i klíč cache.
 * Žádné volání sítě: větev si požadavek jen zapamatuje.
 */
import { readFileSync } from 'node:fs';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import type { GenerationBranch } from '@/server/pipeline';

import { direct } from '..';
import type { DirectorCache } from '../cache';
import { directorKey } from '../cache';
import { COMPACT_PROMPT_VERSION } from '../compact';
import { exampleSpec, nearestExamples } from '../retrieval';

beforeAll(async () => {
  await loadRapier();
});
afterEach(() => vi.unstubAllEnvs());

const STAB = 'a knight stabs goblins';
const manifest = JSON.parse(readFileSync('src/play/vocab/manifest.json', 'utf8')) as { outputs: { verbs: { sha256: string } } };

/** Větev bez modelu a cache, které si zapamatují požadavek a klíč. */
function recording() {
  const users: string[] = [];
  const models: string[] = [];
  const keys: string[] = [];
  const branch: GenerationBranch = {
    id: 'live',
    pricing: { usdPerMTokIn: 0, usdPerMTokOut: 0 },
    worstCaseUsd: () => 0,
    generate: async (call) => {
      users.push(call.request.user);
      models.push(call.request.model);
      return { ok: false, reason: 'UPSTREAM_UNAVAILABLE', detail: 'recorded', usage: null };
    },
  };
  const cache: DirectorCache = {
    id: 'memory',
    read: async (key) => {
      keys.push(key);
      return null;
    },
    write: async () => {},
  };
  return { users, models, keys, run: (sentence: string) => direct(sentence, { branch, cache, now: () => 0, compact: true }) };
}

const fullIntent = (user: string) => JSON.parse(user.split('\n\nFULL INTENT:\n')[1]!) as Record<string, unknown>;
const playsFight = (sentence: string) => nearestExamples(sentence, null).some((example) => exampleSpec(example).mode === 'fight');

describe('director and the vocab table', () => {
  it('names the approximation in FULL INTENT', async () => {
    const live = recording();
    await live.run(STAB);
    expect(fullIntent(live.users[0]!).approximations).toEqual([{ said: 'stabs', as: 'fight' }]);
  });

  it('leaves FULL INTENT without approximations when nothing was mapped', async () => {
    const live = recording();
    await live.run('a knight fights goblins');
    expect(Object.keys(fullIntent(live.users[0]!))).toEqual(['sentence', 'essential', 'negated']);
  });

  it('finds examples that play the mapped verb', () => {
    expect(playsFight(STAB)).toBe(true);
    vi.stubEnv('PLAY_VOCAB', 'off');
    expect(playsFight(STAB)).toBe(false);
  });

  it('keys the cache by the table it read', async () => {
    const live = recording();
    await live.run(STAB);
    const promptVersion = `${COMPACT_PROMPT_VERSION}+vocab:${manifest.outputs.verbs.sha256.slice(0, 12)}`;
    expect(live.keys[0]).toBe(directorKey({ sentence: STAB, promptVersion, model: live.models[0]!, endpoint: 'live' }));
  });

  it('keeps prompt and key as before P44C with PLAY_VOCAB=off', async () => {
    vi.stubEnv('PLAY_VOCAB', 'off');
    const off = recording();
    await off.run(STAB);
    expect(Object.keys(fullIntent(off.users[0]!))).toEqual(['sentence', 'essential', 'negated']);
    expect(off.keys[0]).toBe(directorKey({ sentence: STAB, promptVersion: COMPACT_PROMPT_VERSION, model: off.models[0]!, endpoint: 'live' }));
  });
});
