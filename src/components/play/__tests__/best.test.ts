import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BEST_PREFIX, type BestOutcome, readBest, settleBest } from '../best';
import { PostRun, type RunFacts, runResult } from '../PostRun';
import type { RemixJob } from '../RemixBox';

/**
 * Osobní rekord (P36B T2): `localStorage` je jen pomůcka – první výhra rekord
 * zapíše, horší pokus ho nezmění a „New best!“ neukáže, lepší ano; úložiště,
 * které hází, výsledek nerozbije.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

function memoryStore(): Pick<Storage, 'getItem' | 'setItem'> & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

const throwing: Pick<Storage, 'getItem' | 'setItem'> = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

const win = (score: number, ticks: number, stars: number) => ({ won: true, score, ticks, stars });

describe('settleBest – rekord v prohlížeči', () => {
  it('první výhra rekord zapíše, ale „New best!“ neukáže – nemá co překonat', () => {
    const store = memoryStore();
    expect(settleBest('v1', win(200, 900, 2), store)).toEqual({ previous: null, isNew: false });
    expect(readBest('v1', store)).toEqual({ score: 200, ticks: 900, stars: 2 });
    expect(store.data.has(`${BEST_PREFIX}v1`)).toBe(true);
  });

  it('horší pokus rekord nemění a není nový', () => {
    const store = memoryStore();
    settleBest('v1', win(200, 900, 2), store);
    expect(settleBest('v1', win(150, 800, 2), store)).toEqual({ previous: { score: 200, ticks: 900, stars: 2 }, isNew: false });
    expect(settleBest('v1', win(500, 500, 1), store).isNew).toBe(false);
    expect(readBest('v1', store)).toEqual({ score: 200, ticks: 900, stars: 2 });
  });

  it('lepší pokus je nový rekord: víc hvězd, při shodě víc bodů, při shodě rychleji', () => {
    const store = memoryStore();
    settleBest('v1', win(200, 900, 2), store);
    expect(settleBest('v1', win(100, 1500, 3), store).isNew).toBe(true);
    expect(settleBest('v1', win(101, 1500, 3), store).isNew).toBe(true);
    expect(settleBest('v1', win(101, 1400, 3), store)).toEqual({ previous: { score: 101, ticks: 1500, stars: 3 }, isNew: true });
    expect(readBest('v1', store)).toEqual({ score: 101, ticks: 1400, stars: 3 });
  });

  it('prohra rekord jen přečte, nikdy nezapíše', () => {
    const store = memoryStore();
    expect(settleBest('v1', { won: false, score: 999, ticks: 10, stars: 0 }, store)).toEqual({ previous: null, isNew: false });
    expect(store.data.size).toBe(0);
  });

  it('úložiště, které hází, dá „bez rekordu“ a nespadne', () => {
    expect(settleBest('v1', win(200, 900, 2), throwing)).toEqual({ previous: null, isNew: false });
    expect(readBest('v1', throwing)).toBeNull();
    expect(settleBest('v1', win(200, 900, 2), null)).toEqual({ previous: null, isNew: false });
  });

  it('nečitelný záznam je jako žádný', () => {
    const store = memoryStore();
    store.data.set(`${BEST_PREFIX}v1`, '{"score":"lots"}');
    expect(readBest('v1', store)).toBeNull();
    store.data.set(`${BEST_PREFIX}v1`, 'not json');
    expect(readBest('v1', store)).toBeNull();
  });
});

const job: RemixJob = { view: { kind: 'idle' }, sent: '', submit: () => undefined };

const arcadeFacts = (over: Partial<RunFacts> = {}): RunFacts => ({
  won: true,
  tick: 1860,
  hz: 60,
  survive: false,
  goal: null,
  extra: [{ value: '100%', label: 'of the way' }],
  score: { value: 2450, unit: 'coins' },
  stars: 2,
  ...over,
});

const render = (facts: RunFacts, record: BestOutcome | null) =>
  renderToStaticMarkup(createElement(PostRun, { versionId: 'v1', remix: job, facts, record, onReplay: () => undefined }));

describe('PostRun – skóre, hvězdy a rekord (P36B T2)', () => {
  it('po výhře ukáže velké skóre a hvězdy proti paru', () => {
    const markup = render(arcadeFacts(), null);
    expect(markup).toMatch(/data-testid="play-score"[^>]*>.*2,450.*coins/);
    expect(markup).toContain('data-stars="2"');
    expect(markup).toContain('aria-label="2 of 3 stars"');
    expect(markup.match(/class="play-star is-earned"/g)).toHaveLength(2);
    expect(markup.match(/class="play-star"/g)).toHaveLength(1);
  });

  it('překonaný rekord = „New best!“; horší pokus ukáže rekord k překonání', () => {
    const better = render(arcadeFacts(), { previous: { score: 2000, ticks: 2000, stars: 2 }, isNew: true });
    expect(better).toMatch(/data-testid="play-best" data-new="true">New best!</);
    const worse = render(arcadeFacts(), { previous: { score: 3000, ticks: 1860, stars: 3 }, isNew: false });
    expect(worse).not.toContain('New best!');
    expect(worse).toMatch(/data-testid="play-best" data-new="false">Your best: 3,000 · 31.0s</);
  });

  it('první výhra a výsledek bez úložiště nemají řádek rekordu', () => {
    expect(render(arcadeFacts(), { previous: null, isNew: false })).not.toContain('data-testid="play-best"');
    expect(render(arcadeFacts(), null)).not.toContain('data-testid="play-best"');
    expect(render(arcadeFacts(), null)).toContain('>You did it!<');
  });

  it('prohra: žádné hvězdy, „So close.“ a jak daleko od rekordu', () => {
    const lost = arcadeFacts({ won: false, tick: 1680, survive: true, stars: 0 });
    const markup = render(lost, { previous: { score: 0, ticks: 1800, stars: 3 }, isNew: false });
    expect(markup).toContain('>So close.<');
    expect(markup).not.toContain('data-testid="play-stars"');
    expect(markup).toContain('>2 s off your best<');
  });

  it('hra bez skóre a bez hvězd (mřížka) je ukáže jako dřív – jen statistiky', () => {
    const grid = runResult({ won: true, tick: 246, hz: 20, survive: false, goal: null, extra: [] }, null);
    expect(grid.stars).toBeNull();
    expect(grid.score).toBeNull();
    expect(grid.best).toBeNull();
  });
});
