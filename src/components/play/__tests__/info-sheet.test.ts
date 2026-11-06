/**
 * Jeden info prvek ve hře (P33 T7). Nad hrou dřív ležely tři proužky pod
 * sebou – „Instant draft from the keywords in…“, „How this game works“ a
 * rodokmen – a na telefonu braly třetinu obrazovky. Pod `InfoSheetProvider`
 * (shell) je vidět jen řádek „About this game“; zbytek je v listu za ním.
 * Bez poskytovatele (feed) kreslí rodokmen sám sebe jako dřív.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HowItWorks } from '../HowItWorks';
import type { LabFacts, ReadFacts } from '../lab';
import { Lineage } from '../Lineage';
import { AboutButton, ReadSection, SentenceRead } from '../SentenceRead';
import { InfoSheetProvider } from '../ui/InfoContext';

const READ: ReadFacts = {
  authorship: 'draft',
  readBy: 'keywords',
  sentence: 'A fox steals eggs',
  game: 'Collect',
  world: 'a farm',
  place: 'a farm',
  you: 'fox',
  against: ['dog'],
};

const LAB: LabFacts = { goal: 'Collect 5 eggs', lose: 'Get caught by the dog.', controls: 'Arrows to move', how: ['Picking up an egg adds one.'] };

function shell(read: ReadFacts = READ): string {
  return renderToStaticMarkup(
    createElement(
      InfoSheetProvider,
      null,
      createElement(Lineage, { lineage: [], remixes: 2 }),
      createElement(SentenceRead, { read, open: false, onClose: () => {} }),
      createElement(HowItWorks, { facts: LAB }),
    ),
  );
}

describe('the about-this-game sheet', () => {
  // Od P34 T5 je tlačítko listu na kartě pauzy (`AboutButton`), ne nad hrou: zavřený list nad hrou nekreslí nic.
  it('draws nothing over the game until the pause card opens it', () => {
    const html = shell();
    expect(html).not.toContain('data-testid="play-info"');
    for (const strip of ['play-lab-toggle', 'play-lineage', 'play-read-toggle', '<details']) expect(html).not.toContain(strip);
  });

  it('the pause card has exactly one way into it', () => {
    const html = renderToStaticMarkup(createElement(AboutButton, { onOpen: () => {} }));
    expect(html.match(/data-testid="play-info"/g)).toHaveLength(1);
    expect(html).toContain('About this game');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  // P70C T3: „How to play“ říká hráči cíl, prohru, ovládání a jak hra běží – žádný tik ani id verze.
  it('how to play shows win, lose, controls and the plain sentences', () => {
    const html = renderToStaticMarkup(createElement(HowItWorks, { facts: LAB }));
    for (const text of ['<dt>Win</dt><dd>Collect 5 eggs</dd>', '<dt>Lose</dt><dd>Get caught by the dog.</dd>', '<dt>Controls</dt><dd>Arrows to move</dd>', '<li>Picking up an egg adds one.</li>']) {
      expect(html).toContain(text);
    }
    expect(renderToStaticMarkup(createElement(HowItWorks, { facts: { ...LAB, lose: null } }))).not.toContain('Lose');
  });

  it('outside a shell (the feed) the lineage still draws itself', () => {
    const html = renderToStaticMarkup(createElement(Lineage, { lineage: [], remixes: 2 }));
    expect(html).toContain('data-testid="play-lineage"');
  });

  it('says who made the game without jargon', () => {
    // Řádek autorství, ne celý oddíl – poznámka pod ním smí říct, že AI návrh přepíše.
    const say = (read: ReadFacts) => /data-testid="play-read-by">(.*?)<\/p>/.exec(renderToStaticMarkup(createElement(ReadSection, { read })))?.[1] ?? '';
    expect(say(READ)).toContain('Quick version from your idea');
    expect(say(READ)).not.toMatch(/keywords|Instant draft|AI/);
    expect(say({ ...READ, readBy: 'model' })).toContain('Quick version read by AI');
    expect(say({ ...READ, authorship: 'ai' })).toContain('Full-detail version of your idea');
    expect(say({ ...READ, authorship: 'ai' })).not.toContain('Designed by AI');
  });
});
