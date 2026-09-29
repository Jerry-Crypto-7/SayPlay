import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BuildSteps, CreateGame } from '../CreateGame';
import { BUILD_STEPS } from '../starters';

/**
 * Po odeslání věty (P33 T9) vidí hráč celou cestu – všechny čtyři kroky
 * `BUILD_STEPS`, hotové, aktivní a čekající. Jeden tichý řádek vypadá na
 * snímku stejně dobře a přitom neřekne, kolik ještě zbývá.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const states = (active: number) => [...renderToStaticMarkup(createElement(BuildSteps, { active })).matchAll(/<li[^>]*data-state="(\w+)"[^>]*>([^<]*)</g)].map(([, state, text]) => [text, state]);

describe('BuildSteps', () => {
  it('renders all four steps with only the first active right after sending', () => {
    expect(states(0)).toEqual([
      [BUILD_STEPS[0], 'active'],
      [BUILD_STEPS[1], 'todo'],
      [BUILD_STEPS[2], 'todo'],
      [BUILD_STEPS[3], 'todo'],
    ]);
  });

  it('ticks off the first step once the game exists', () => {
    expect(states(1).map(([, state]) => state)).toEqual(['done', 'active', 'todo', 'todo']);
    expect(renderToStaticMarkup(createElement(BuildSteps, { active: 1 }))).toMatch(/aria-current="step"[^>]*>Building a playable version</);
  });
});

describe('CreateGame', () => {
  it('keeps the counter and the build steps out of the idle form', () => {
    const markup = renderToStaticMarkup(createElement(CreateGame));
    expect(markup).not.toContain('play-counter');
    expect(markup).not.toContain('data-testid="play-status"');
  });

  it('shows starter cards as an icon and one sentence, with no shouted label', () => {
    const markup = renderToStaticMarkup(createElement(CreateGame));
    expect(markup).not.toContain('play-starter-label');
    expect(markup.match(/class="play-starter"[^>]*>\s*<svg/g)).toHaveLength(8);
  });
});
