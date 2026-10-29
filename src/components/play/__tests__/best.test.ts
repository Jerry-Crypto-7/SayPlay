import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { cheerView, NO_HOOKS } from '../arcade/hooks/HooksLayer';
import { BEST_PREFIX, type BestCheer, type BestOutcome, bestGoal, cheerOf, type Dare, dareGoal, dareStart, dareVerdict, readBest, settleBest } from '../best';
import { PostRun, type RunFacts, runResult } from '../PostRun';
import type { RemixJob } from '../RemixBox';
import { DARE_BACK, NEW_BEST, YOU_BEAT_IT } from '../starters';
import { GameHud, type HudCounter } from '../ui/GameHud';

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

  it('samotný čas řádek statistik nemá – říká ho věta shrnutí; s dalším číslem řádek zůstává', () => {
    expect(render(arcadeFacts({ extra: [] }), null)).not.toContain('aria-label="Your run"');
    expect(render(arcadeFacts(), null)).toContain('aria-label="Your run"');
  });

  it('hra bez skóre a bez hvězd (mřížka) je ukáže jako dřív – jen statistiky', () => {
    const grid = runResult({ won: true, tick: 246, hz: 20, survive: false, goal: null, extra: [] }, null);
    expect(grid.stars).toBeNull();
    expect(grid.score).toBeNull();
    expect(grid.best).toBeNull();
  });
});

describe('bestGoal – cíl k překonání v HUD (P36B T4)', () => {
  it('hráč bez rekordu cíl nevidí', () => {
    expect(bestGoal(null, 60, false)).toBeNull();
  });

  it('rekord s body je cíl v bodech – ty se dají přebít už za běhu', () => {
    expect(bestGoal({ score: 2450, ticks: 1860, stars: 2 }, 60, false)).toEqual({ text: 'Best 2,450', score: 2450 });
    expect(bestGoal({ score: 12, ticks: 5400, stars: 3 }, 60, true)).toEqual({ text: 'Best 12', score: 12 });
  });

  it('rekord bez bodů je cíl v čase; hra na přežití bez bodů cíl nemá', () => {
    expect(bestGoal({ score: 0, ticks: 1860, stars: 2 }, 60, false)).toEqual({ text: 'Best 31.0s', score: null });
    expect(bestGoal({ score: 0, ticks: 5400, stars: 3 }, 60, true)).toBeNull();
  });

  it('HUD ukáže cíl jako položku pilulky postupu; přebitý rekord vyskočí', () => {
    const hud = (counter: HudCounter) =>
      renderToStaticMarkup(createElement(GameHud, { title: 'T', goalLine: 'Go', counters: [counter], clock: { seconds: 3, countdown: false }, objective: false }));
    expect(hud({ label: 'best', count: 2450, text: 'Best 2,450' })).toMatch(/class="play-hud-count" data-testid="hud-counter-best"[^>]*>.*Best 2,450/);
    expect(hud({ label: 'best', count: 2451, text: NEW_BEST, fresh: true })).toMatch(/class="play-hud-count is-new" data-testid="hud-counter-best"[^>]*>.*New best!/);
  });
});

/**
 * P66 T11: soukromé okno, kde už sáhnout na `localStorage` vyhodí, hraje bez pilulky rekordu a bez pádu;
 * přebitý cíl ohlásí hláška jednou za běh, i když body kolem cíle kolíší.
 */
describe('rekord bez úložiště a hláška přebitého cíle (P66 T11)', () => {
  it('bez úložiště (přístup k localStorage hází) pilulka rekordu není a konec běhu nespadne', () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(readBest('v1')).toBeNull();
      expect(bestGoal(readBest('v1'), 60, false)).toBeNull();
      expect(settleBest('v1', win(200, 900, 2))).toEqual({ previous: null, isNew: false });
      expect(cheerOf(bestGoal(readBest('v1'), 60, false), false, 99_999)).toBeNull();
    } finally {
      if (before === undefined) Reflect.deleteProperty(globalThis, 'localStorage');
      else Object.defineProperty(globalThis, 'localStorage', before);
    }
  });

  /** Body běhu tik po tiku → hlášky, které by vrstva háčků ukázala (`cheerOf` v `ArcadePlay`, `cheerView` ve vrstvě). */
  function cheers(goal: ReturnType<typeof bestGoal>, dare: boolean, scores: readonly number[], restartAt = -1): BestCheer[] {
    const shown: BestCheer[] = [];
    let view = NO_HOOKS;
    scores.forEach((score, tick) => {
      if (tick === restartAt) view = NO_HOOKS;
      const cheer = cheerOf(goal, dare, score);
      if (cheer === null) return;
      const next = cheerView(view, cheer, tick, tick);
      if (next !== view) shown.push(next.callout!.id as BestCheer);
      view = next;
    });
    return shown;
  }

  it('přebitý rekord ohlásí „New best!“ jednou za běh, i když body klesnou a znovu stoupnou', () => {
    const goal = bestGoal({ score: 1240, ticks: 1860, stars: 2 }, 60, false);
    expect(cheers(goal, false, [0, 800, 1240, 1241, 1300, 1200, 1500])).toEqual(['new_best']);
    // Shoda s rekordem ho nepřebije.
    expect(cheers(goal, false, [0, 1240, 1240])).toEqual([]);
    // Restart (tik zpět) vrátí vrstvu do `NO_HOOKS`: nový běh ohlásí znovu.
    expect(cheers(goal, false, [0, 1300, 0, 1300], 2)).toEqual(['new_best', 'new_best']);
  });

  it('výzva kamaráda hlásí `beat_it`; cíl v čase ani žádný cíl za běhu nehlásí', () => {
    const scored: Dare = { score: 1240, ticks: 1860, liveChanges: 0 };
    expect(cheers(dareGoal(scored, 60, false), true, [0, 1241, 1500])).toEqual(['beat_it']);
    expect(cheers(dareGoal({ ...scored, score: 0 }, 60, false), true, [0, 50, 5000])).toEqual([]);
    expect(cheers(bestGoal({ score: 0, ticks: 1860, stars: 1 }, 60, false), false, [0, 5000])).toEqual([]);
    expect(cheers(null, false, [0, 5000])).toEqual([]);
  });
});

/**
 * Výzva kamaráda (P36B T7): cíl na kartě startu a v HUD, na konci výsledek
 * proti kamarádovi. Body rozhodují první, při shodě čas.
 */
describe('dare – hra proti výsledku kamaráda (P36B T7)', () => {
  const scored: Dare = { score: 2450, ticks: 1860, liveChanges: 0 };
  const timed: Dare = { score: 0, ticks: 1860, liveChanges: 0 };

  it('karta startu a HUD řeknou, co porazit: body a čas, u hry bez bodů jen čas', () => {
    expect(dareStart(scored, 60, false)).toBe('Beat 2,450 in 31.0s');
    expect(dareStart(timed, 60, false)).toBe('Beat 31.0s');
    expect(dareStart({ ...timed, ticks: 5400 }, 60, true)).toBe('Survive 90.0s');
    expect(dareGoal(scored, 60, false)).toEqual({ text: 'Beat 2,450', score: 2450 });
    expect(dareGoal(timed, 60, false)).toEqual({ text: 'Beat 31.0s', score: null });
  });

  it('výhra s víc body kamaráda porazí, s méně ne – i když byla rychlejší', () => {
    expect(dareVerdict({ won: true, score: 2800, ticks: 2400 }, scored, 60, false)).toEqual({ beat: true, text: "350 more than your friend's 2,450" });
    expect(dareVerdict({ won: true, score: 2100, ticks: 900 }, scored, 60, false)).toEqual({ beat: false, text: "350 short of your friend's 2,450" });
  });

  it('při shodě bodů rozhodne čas; přesná shoda kamaráda neporazí', () => {
    expect(dareVerdict({ won: true, score: 0, ticks: 1800 }, timed, 60, false)).toEqual({ beat: true, text: '1.0s faster than your friend' });
    expect(dareVerdict({ won: true, score: 0, ticks: 1920 }, timed, 60, false)).toEqual({ beat: false, text: '1.0s slower than your friend' });
    expect(dareVerdict({ won: true, score: 0, ticks: 1860 }, timed, 60, false).beat).toBe(false);
    // Přežití bez bodů trvá každé výhře stejně: vydržet jako kamarád je výzvu splnit.
    expect(dareVerdict({ won: true, score: 0, ticks: 5400 }, { ...timed, ticks: 5400 }, 60, true).beat).toBe(true);
  });

  it('prohra kamaráda nikdy neporazí, ani s víc body', () => {
    expect(dareVerdict({ won: false, score: 900, ticks: 600 }, scored, 60, false)).toEqual({ beat: false, text: "1,550 short of your friend's 2,450" });
    expect(dareVerdict({ won: false, score: 3000, ticks: 600 }, scored, 60, false).beat).toBe(false);
    expect(dareVerdict({ won: false, score: 0, ticks: 1680 }, { ...timed, ticks: 1800 }, 60, true)).toEqual({ beat: false, text: '2 s short of your friend' });
    expect(dareVerdict({ won: false, score: 0, ticks: 600 }, timed, 60, false)).toEqual({ beat: false, text: 'Your friend did it in 31.0s.' });
  });

  const renderDare = (facts: RunFacts, challenge: Dare) =>
    renderToStaticMarkup(createElement(PostRun, { versionId: 'v1', remix: job, facts, record: { previous: { score: 1, ticks: 1, stars: 1 }, isNew: true }, challenge, onReplay: () => undefined }));

  it('výsledek: „You beat it!“ a rozdíl místo rekordu, hlavní akce „Dare back“', () => {
    const markup = renderDare(arcadeFacts({ score: { value: 2800, unit: 'coins' } }), scored);
    expect(markup).toContain(`>${YOU_BEAT_IT}<`);
    expect(markup).toMatch(/data-testid="play-dare-result" data-beat="true">350 more than your friend&#x27;s 2,450</);
    expect(markup).not.toContain('data-testid="play-best"');
    expect(markup).toMatch(new RegExp(`data-variant="primary"[^>]*>(<[^>]+>)*${DARE_BACK}<`));
  });

  it('prohraná výzva: „So close.“, kolik chybělo, hlavní akce zůstává „Try again“', () => {
    const markup = renderDare(arcadeFacts({ won: false, score: { value: 900, unit: 'coins' }, stars: 0 }), scored);
    expect(markup).toContain('>So close.<');
    expect(markup).toMatch(/data-testid="play-dare-result" data-beat="false">1,550 short of your friend&#x27;s 2,450</);
    expect(markup).not.toContain(DARE_BACK);
  });

  it('bez výzvy výsledek zůstává jako dřív', () => {
    const result = runResult(arcadeFacts(), null);
    expect(result.headline).toBe('You did it!');
    expect(result.dare).toBeNull();
  });
});
