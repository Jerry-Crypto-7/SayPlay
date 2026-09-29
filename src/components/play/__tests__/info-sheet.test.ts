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
import { ReadSection, SentenceRead } from '../SentenceRead';
import { InfoSheetProvider } from '../ui/InfoContext';

const READ: ReadFacts = {
  authorship: 'draft',
  readBy: 'keywords',
  sentence: 'A fox steals eggs',
  game: 'Collect',
  world: 'a farm',
  you: 'fox',
  against: ['dog'],
  goal: 'Collect 5 eggs',
  rules: ['Collect'],
};

const LAB: LabFacts = { mechanics: [], rulesChecked: 'Rules checked', winnable: 'Winnable', replay: 'Replay: ok' };

function shell(read: ReadFacts = READ): string {
  return renderToStaticMarkup(
    createElement(
      InfoSheetProvider,
      null,
      createElement(Lineage, { lineage: [], remixes: 2 }),
      createElement(SentenceRead, { read }),
      createElement(HowItWorks, { facts: LAB, versionId: 'abc', lineage: [] }),
    ),
  );
}

describe('the about-this-game sheet', () => {
  it('shows exactly one info element over the game', () => {
    const html = shell();
    expect(html.match(/data-testid="play-info"/g)).toHaveLength(1);
    expect(html).toContain('About this game');
    for (const strip of ['play-lab-toggle', 'play-lineage', 'play-read-toggle', '<details']) expect(html).not.toContain(strip);
  });

  it('outside a shell (the feed) the lineage still draws itself', () => {
    const html = renderToStaticMarkup(createElement(Lineage, { lineage: [], remixes: 2 }));
    expect(html).toContain('data-testid="play-lineage"');
  });

  it('says who made the game without jargon', () => {
    // Řádek autorství, ne celý oddíl – poznámka pod ním smí říct, že AI návrh přepíše.
    const say = (read: ReadFacts) => /data-testid="play-read-by">(.*?)<\/p>/.exec(renderToStaticMarkup(createElement(ReadSection, { read })))?.[1] ?? '';
    expect(say(READ)).toContain('Quick version from your sentence');
    expect(say(READ)).not.toMatch(/keywords|Instant draft|AI/);
    expect(say({ ...READ, readBy: 'model' })).toContain('Quick version read by a local AI model');
    expect(say({ ...READ, authorship: 'ai' })).toContain('AI version of your sentence');
    expect(say({ ...READ, authorship: 'ai' })).not.toContain('Designed by AI');
  });
});
