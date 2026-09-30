import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BuildSteps, CreateGame } from '../CreateGame';
import { BUILD_STEPS, IDEAS } from '../starters';

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
  const markup = renderToStaticMarkup(createElement(CreateGame));

  it('keeps the build steps out of the idle form and shows the counter at 0/140', () => {
    expect(markup).not.toContain('data-testid="play-status"');
    expect(markup).toMatch(/data-testid="play-counter" data-warn="false"[^>]*>0\/140</);
  });

  it('labels the prompt bubble visibly and has exactly one primary action, Make it!', () => {
    expect(markup).toMatch(/<label class="sp-prompt__label" for="play-sentence">Say it in one sentence<\/label>/);
    // Aktivní i nad prázdným polem jako v referenci kitu; prázdné odeslání ukáže „Too vague“ (e2e play-create).
    expect(markup.match(/data-variant="primary"[^>]*>[^<]*</g)).toEqual(['data-variant="primary" data-testid="play-create">Make it!<']);
    expect(markup).not.toContain('sp-field-error');
  });

  it('shows four idea cards in kit colour order with alternating tilt and no icon', () => {
    const cards = [...markup.matchAll(/class="sp-idea ([^"]+)"[^>]*>([^<]*)</g)].map(([, look, text]) => [look, text]);
    expect(cards.map(([look]) => look)).toEqual(['sp-idea--mint sp-tilt-l', 'sp-idea--sun sp-tilt-r', 'sp-idea--sky sp-tilt-r', 'sp-idea--gum sp-tilt-l']);
    expect(cards.map(([, text]) => text)).toEqual(IDEAS.map((idea) => idea.sentence));
  });

  it('offers only Make and Play in the tab bar, Make active on arrival', () => {
    expect([...markup.matchAll(/class="sp-tabbar__item( is-active)?"[^>]*>.*?<\/svg>(\w+)</g)].map(([, active, label]) => `${label}${active ? '*' : ''}`)).toEqual(['Make*', 'Play']);
  });
});
