/**
 * P73B T1: kontrakt „AI facts“ pro P73C. Verze s `provenance` ukáže v „About this game“ jeden řádek
 * „Made by …“; verze bez něj nic nového nekreslí a `readFacts` pole vůbec nepřidá.
 */

import { readFileSync } from 'node:fs';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { readGameSpec } from '@/play/spec';

import { readFacts, type ReadFacts } from '../lab';
import { aiLineOf, ReadSection } from '../SentenceRead';

const DEMO_SPEC = (() => {
  const read = readGameSpec(JSON.parse(readFileSync('src/play/__fixtures__/collect_exit.json', 'utf8')));
  if (!read.ok) throw new Error(read.reason);
  return read.value;
})();

const READ: ReadFacts = { authorship: 'ai', readBy: 'keywords', sentence: 'A fox steals eggs', game: 'Arena', world: 'farm · sunny', you: 'fox', against: ['dog'] };

describe('AI provenance on the game info', () => {
  it('says model, seconds and fresh or cached', () => {
    expect(aiLineOf({ model: 'gpt-oss-120b', ms: 12345, cached: false, revised: 0 })).toBe('Made by gpt-oss-120b in 12.3 s · fresh');
    expect(aiLineOf({ model: 'gpt-oss-120b', ms: 800, cached: true, revised: 0 })).toBe('Made by gpt-oss-120b in 0.8 s · from cache');
  });

  it('counts revisions only when there were some', () => {
    expect(aiLineOf({ model: 'm', ms: 1000, cached: false, revised: 1 })).toBe('Made by m in 1.0 s · fresh · revised once');
    expect(aiLineOf({ model: 'm', ms: 1000, cached: false, revised: 3 })).toBe('Made by m in 1.0 s · fresh · revised 3 times');
  });

  it('the info sheet shows the line only when the version carries it', () => {
    const without = renderToStaticMarkup(<ReadSection read={READ} />);
    expect(without).not.toContain('play-read-ai');
    expect(without).not.toContain('Made by');
    const withAi = renderToStaticMarkup(<ReadSection read={{ ...READ, ai: { model: 'gpt-oss-120b', ms: 4200, cached: false, revised: 2 } }} />);
    expect(withAi).toContain('data-testid="play-read-ai"');
    expect(withAi).toContain('Made by gpt-oss-120b in 4.2 s · fresh · revised 2 times');
  });

  it('readFacts passes provenance through and adds no key without it', () => {
    const ai = { model: 'gpt-oss-120b', ms: 4200, cached: true, revised: 0 };
    expect(readFacts(DEMO_SPEC, 'ai', null, 'keywords', ai).ai).toEqual(ai);
    expect('ai' in readFacts(DEMO_SPEC, 'ai', null)).toBe(false);
  });
});
