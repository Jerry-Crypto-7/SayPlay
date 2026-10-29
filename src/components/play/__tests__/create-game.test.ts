import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGame } from '../create-game';
import { CreateGame } from '../CreateGame';
import { BUILD_FAILED, BUILD_STEPS, IDEAS, NOT_SENT } from '../starters';
import { BuildSteps } from '../ui';

/**
 * Po odeslání věty (P33 T9) vidí hráč celou cestu – všechny čtyři kroky
 * `BUILD_STEPS`, hotové, aktivní a čekající. Jeden tichý řádek vypadá na
 * snímku stejně dobře a přitom neřekne, kolik ještě zbývá.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

// P34 T4: před textem kroku stojí kolečko kitu (`.sp-steps__mark`, u hotového s fajfkou).
const states = (active: number) =>
  [...renderToStaticMarkup(createElement(BuildSteps, { active })).matchAll(/<li[^>]*data-state="(\w+)"[^>]*><span class="sp-steps__mark">.*?<\/span>([^<]*)</g)].map(([, state, text]) => [text, state]);

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
    expect(renderToStaticMarkup(createElement(BuildSteps, { active: 1 }))).toMatch(/aria-current="step"><span class="sp-steps__mark"><\/span>Building the world</);
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

  // P54A T12: vedle lišty telefonu nese tytéž dvě položky navigace levého sloupce od `lg`, tam je hlavní obsah feed.
  it('offers only Make and Play in the tab bar, Make active on arrival, and the same two in the desktop side nav with Play active', () => {
    const tabs = (nav: string) =>
      [...(markup.match(new RegExp(`<nav class="${nav}"[^>]*>(.*?)</nav>`))?.[1] ?? '').matchAll(/class="sp-tabbar__item( is-active)?"[^>]*>.*?<\/svg>(\w+)</g)].map(
        ([, active, label]) => `${label}${active ? '*' : ''}`,
      );
    expect(markup.match(/<nav /g)).toHaveLength(2);
    expect(tabs('sp-tabbar play-tabbar')).toEqual(['Make*', 'Play']);
    expect(tabs('play-side-nav')).toEqual(['Make', 'Play*']);
  });
});

/**
 * `createGame` (P67 T2) je jediná cesta věta → hra pro formulář i VR lobby. Formulář na `offline` větu podrží
 * a pošle sám; lobby ve VR ukáže `error`. Kdyby se příznaky prohodily, obojí by na pohled fungovalo.
 */
describe('createGame', () => {
  const answer = (status: number, body: unknown) => vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })));
  afterEach(() => vi.unstubAllGlobals());

  it('posts the sentence and returns the game address', async () => {
    const fetch = answer(201, { url: '/play/abc' });
    vi.stubGlobal('fetch', fetch);
    expect(await createGame('A cat steals fish')).toEqual({ url: '/play/abc' });
    expect(fetch).toHaveBeenCalledWith('/api/play/games', expect.objectContaining({ method: 'POST', body: JSON.stringify({ sentence: 'A cat steals fish' }) }));
  });

  it('says Build failed for an unplayable sentence and passes a blocked-content line through', async () => {
    vi.stubGlobal('fetch', answer(422, { error: { code: 'NOT_PLAYABLE', message: 'spec failed validation' } }));
    expect(await createGame('x')).toEqual({ error: BUILD_FAILED, offline: false });
    vi.stubGlobal('fetch', answer(422, { error: { code: 'SENTENCE_REJECTED', message: "We can't make that one. Try a different idea." } }));
    expect(await createGame('x')).toEqual({ error: "We can't make that one. Try a different idea.", offline: false });
    vi.stubGlobal('fetch', answer(429, { error: { code: 'RATE_LIMITED', message: 'slow down a little' } }));
    expect(await createGame('x')).toEqual({ error: 'Slow down a little', offline: false });
  });

  it('marks a failed request offline only when the browser says it is offline', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))));
    vi.stubGlobal('navigator', { onLine: true });
    expect(await createGame('x')).toEqual({ error: NOT_SENT, offline: false });
    vi.stubGlobal('navigator', { onLine: false });
    expect(await createGame('x')).toEqual({ error: NOT_SENT, offline: true });
  });
});
