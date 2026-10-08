import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { CreateGame } from '../CreateGame';
import { FIRST_VISIT_KEY, FirstVisitHint, isFirstVisit, markVisited } from '../FirstVisitHint';
import { JUDGE_PICKS, NOT_NOW, TRY_YOUR_OWN } from '../starters';

/**
 * Nápověda první návštěvy (P44D T12) se ukáže jednou a pak už ne – a bez
 * úložiště (soukromé okno, zakázané cookies) se ukáže pokaždé, ale stránku
 * nesmí shodit. Oba případy vypadají v prohlížeči vývojáře stejně dobře.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values };
}

describe('první návštěva', () => {
  it('platí, dokud ji hra nebo „Not now“ nezapíše', () => {
    const storage = memoryStorage();
    expect(isFirstVisit(() => storage)).toBe(true);
    markVisited(() => storage);
    expect(storage.values.has(FIRST_VISIT_KEY)).toBe(true);
    expect(isFirstVisit(() => storage)).toBe(false);
  });

  it('bez úložiště se nápověda ukáže a nic nehodí', () => {
    const denied = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    expect(isFirstVisit(denied)).toBe(true);
    expect(() => markVisited(denied)).not.toThrow();

    const failing = () => ({
      getItem: (): never => {
        throw new Error('storage disabled');
      },
      setItem: (): never => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    });
    expect(isFirstVisit(failing)).toBe(true);
    expect(() => markVisited(failing)).not.toThrow();
  });
});

describe('FirstVisitHint', () => {
  const markup = renderToStaticMarkup(createElement(FirstVisitHint, { disabled: false, onPick: () => undefined, onTryOwn: () => undefined, onClose: () => undefined }));

  it('nabízí pět vět, „Try your own“ a „Not now“', () => {
    expect(markup.match(/data-testid="play-pick-/g)).toHaveLength(5);
    for (const pick of JUDGE_PICKS) expect(markup).toContain(`>${pick.sentence}</button>`);
    expect(markup).toMatch(new RegExp(`data-testid="play-try-own"[^>]*>${TRY_YOUR_OWN}</button>`));
    expect(markup).toMatch(new RegExp(`data-testid="play-first-visit-close"[^>]*>${NOT_NOW}</button>`));
  });

  // Server úložiště nezná: kdyby nápovědu vykreslil, vracející se hráč by ji viděl problesknout a hydratace by nesouhlasila.
  it('stránka ze serveru ji nevykreslí, ukáže se až v prohlížeči', () => {
    expect(renderToStaticMarkup(createElement(CreateGame))).not.toContain('play-first-visit');
  });
});
