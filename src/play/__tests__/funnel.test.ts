/**
 * Trychtýř smyčky (P44B T12): která událost klienta a která nová hra je který stupeň.
 * Autorská verze od AI není `say` ani `remix` – jinak by jedna věta napočítala dvě hry.
 */

import { describe, expect, it } from 'vitest';

import { FUNNEL_STAGES, funnelDayOf, funnelStageOf, publishStageOf } from '../funnel';
import { LOOP_EVENTS } from '../loop-events';

describe('funnel stages (P44B T12)', () => {
  it('stupně v pořadí smyčky', () => {
    expect(FUNNEL_STAGES).toEqual(['say', 'play', 'finish', 'share', 'open', 'beat', 'remix']);
  });

  it('události klienta: first_input → play, win|lose → finish, share → share, shared_open → open, jiné nic', () => {
    expect(Object.fromEntries(LOOP_EVENTS.map((name) => [name, funnelStageOf(name)]))).toEqual({
      impression: null,
      first_input: 'play',
      win: 'finish',
      lose: 'finish',
      restart: null,
      next_game: null,
      share: 'share',
      shared_open: 'open',
      bounce: null,
    });
  });

  it('nová hra: bez rodiče say, s rodičem remix, upgrade nic', () => {
    expect(publishStageOf({ parentId: null })).toBe('say');
    expect(publishStageOf({ parentId: 'a'.repeat(32) })).toBe('remix');
    expect(publishStageOf({ parentId: 'a'.repeat(32), relation: 'upgrade' })).toBeNull();
  });

  it('den v UTC', () => {
    expect(funnelDayOf(Date.parse('2026-10-08T23:59:59Z'))).toBe('2026-10-08');
    expect(funnelDayOf(Date.parse('2026-10-09T00:00:00Z'))).toBe('2026-10-09');
  });
});
