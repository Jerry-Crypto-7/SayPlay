/**
 * P73B T2: karta startu řekne, jak hra větu přečetla, a když něco nahradila, co přeškrtla a čím.
 * Pin: řádek, který vypadá správně, ale vynechá soupeře nebo nahradí špatné slovo, oko nepozná.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FirstPrompt } from '../FirstPrompt';
import type { ReadFacts } from '../lab';
import { readLineOf, StartRead, swapOf } from '../StartRead';

const READ: ReadFacts = {
  authorship: 'draft',
  readBy: 'keywords',
  sentence: 'A cat delivering pizzas across rooftops while avoiding seagulls',
  game: 'Runner',
  world: 'city · sunny',
  place: 'city',
  you: 'cat',
  against: ['seagulls'],
};

describe('how I read it on the start card', () => {
  it('names you, who you are against, the place and what it plays as', () => {
    expect(readLineOf(READ)).toBe('You: cat · Against: seagulls · Place: city · Played as: runner');
  });

  it('leaves out the parts the sentence did not give', () => {
    expect(readLineOf({ ...READ, you: null, against: [] })).toBe('Place: city · Played as: runner');
    expect(readLineOf({ ...READ, against: ['dog', 'owl'] })).toBe('You: cat · Against: dog, owl · Place: city · Played as: runner');
  });

  it('strikes through what the game replaced and says with what', () => {
    expect(swapOf("Rooftops isn't here yet – it's city.")).toEqual({ said: 'Rooftops', instead: 'city' });
    expect(swapOf("The library isn't here yet – it's a spooky forest.")).toEqual({ said: 'The library', instead: 'a spooky forest' });
    expect(swapOf("Running and delivery aren't here yet – here's a shop building game.")).toEqual({ said: 'Running and delivery', instead: 'a shop building game' });
    expect(swapOf('Stab plays as a fight.')).toEqual({ said: 'Stab', instead: 'a fight' });
  });

  it('a reason of another shape is shown whole, never half-struck', () => {
    expect(swapOf('Open worlds, crafting and multiplayer are bigger than one short game.')).toBeNull();
    expect(swapOf('Stab plays as a fight, flip as a tap.')).toBeNull();
    const html = renderToStaticMarkup(<StartRead read={READ} honesty={{ kind: 'sandbox', reason: 'Open worlds are bigger than one short game.', closest: 'a chase game' }} />);
    expect(html).toContain('Open worlds are bigger than one short game.');
    expect(html).not.toContain('<s>');
  });

  it('the swap sits in the same block, struck through', () => {
    const html = renderToStaticMarkup(<StartRead read={READ} honesty={{ kind: 'actions', reason: "Rooftops isn't here yet – it's city.", closest: 'city' }} />);
    expect(html).toMatch(/data-testid="play-start-read".*How I read it.*play-start-read-line.*play-start-read-swap"><s>Rooftops<\/s> city</s);
  });

  it('no swap line without a substitution', () => {
    expect(renderToStaticMarkup(<StartRead read={READ} />)).not.toContain('play-start-read-swap');
  });

  it('sits on top of the start card and keeps the start call', () => {
    const html = renderToStaticMarkup(<FirstPrompt read={<StartRead read={READ} />} controlsHint="Tap to jump." goal="Deliver 5 pizzas." />);
    expect(html.indexOf('play-start-read')).toBeGreaterThan(-1);
    expect(html.indexOf('play-start-read')).toBeLessThan(html.indexOf('play-first-prompt-goal'));
    expect(html).toContain('data-testid="play-first-prompt-start"');
  });
});
