/**
 * List „About this game“ na telefonu říká v Controls totéž co karta před startem (R2 P70C): plošinovka „Hold left
 * to run, tap right to jump.“ ze zón dotyku, ne jen „Tap to jump.“ z nápovědy hry. Dotyk se tu vynutí – server
 * jinak hlásí myš (`useCoarsePointer` vrací `false`).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ZONE_HINTS } from '../arcade/touch-zones';
import { HowItWorks } from '../HowItWorks';
import type { LabFacts } from '../lab';

vi.mock('../FirstPrompt', async (load) => ({ ...(await load<typeof import('../FirstPrompt')>()), useCoarsePointer: () => true }));

const PLATFORMER: LabFacts = { goal: 'Reach the flag.', lose: 'Lose all 3 lives.', controls: 'Arrows or A/D to move, Space or tap to jump.', how: [] };

describe('About sheet Controls on a phone (R2 P70C)', () => {
  it('uses the touch-zone hint the start card shows', () => {
    const html = renderToStaticMarkup(createElement(HowItWorks, { facts: PLATFORMER, touch: ZONE_HINTS.platform }));
    expect(html).toContain('Hold left to run, tap right to jump.');
  });

  it('without zones it strips the keys from the game hint', () => {
    const html = renderToStaticMarkup(createElement(HowItWorks, { facts: PLATFORMER }));
    expect(html).not.toMatch(/\b(?:arrows|space|a\/d)\b/i);
  });
});
