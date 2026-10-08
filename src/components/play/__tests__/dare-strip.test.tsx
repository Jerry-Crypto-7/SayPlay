/**
 * Proužek výzvy nad hrou (P44B T8): kdo vyzývá a co porazit. Cíl jde přes `dareGoal` – týž, ze
 * kterého HUD v `ArcadePlay` kreslí cíl výzvy; jiné číslo v proužku než v HUD by vypadalo
 * správně a lhalo. Žádné tlačítko: rajčatová akce obrazovky patří hře.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ARCADE_HZ, type ArcadeWorld } from '@/play/arcade/contract';

import { type Dare, dareGoal } from '../best';

vi.mock('../arcade/ArcadePlay', () => ({ ArcadePlay: () => createElement('div', { 'data-testid': 'arcade' }) }));
vi.mock('../arcade/look/play-env', () => ({ WithPlayEnv: ({ children }: { children: unknown }) => children }));

const { DareStrip } = await import('../DareStrip');
const { PlayShell } = await import('../PlayShell');

const world = (survive: boolean): ArcadeWorld => ({ rules: survive ? [{ id: 'survive_time' }] : [] }) as unknown as ArcadeWorld;
const text = (html: string): string => html.replace(/<[^>]+>/g, '');
const strip = (challenge: Dare, survive = false): string => renderToStaticMarkup(createElement(DareStrip, { challenge, arcade: world(survive) }));

describe('DareStrip', () => {
  it('names who dares you and what to beat, from the same dareGoal as the HUD', () => {
    const scored: Dare = { score: 2450, ticks: 1860, liveChanges: 0, by: 'Ada' };
    const timed: Dare = { score: 0, ticks: 1860, liveChanges: 0 };
    expect(text(strip(scored))).toBe('Ada dares you: beat 2,450');
    expect(text(strip(timed))).toBe('A friend dares you: beat 31.0s');
    expect(text(strip({ ...timed, ticks: 5400 }, true))).toBe('A friend dares you: survive 90.0s');
    for (const [dare, survive] of [[scored, false], [timed, false], [{ ...timed, ticks: 5400 }, true]] as const) {
      const goal = dareGoal(dare, ARCADE_HZ, survive).text;
      expect(text(strip(dare, survive)).endsWith(`: ${goal.charAt(0).toLowerCase()}${goal.slice(1)}`)).toBe(true);
    }
  });

  it('is a status strip of kit tokens with no button', () => {
    const html = strip({ score: 2450, ticks: 1860, liveChanges: 0, by: 'Ada' });
    expect(html).toContain('data-testid="play-dare-strip"');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});

describe('PlayShell with a dare', () => {
  const props = { versionId: 'v', spec: { theme: {} }, lineage: [], remixes: 0, lab: {}, read: {}, upgrade: null, blueprint: null, arcade: world(false) } as never;

  it('shows the strip above the game only when a dare opened it', () => {
    const challenged = renderToStaticMarkup(createElement(PlayShell, { ...(props as object), challenge: { score: 2450, ticks: 1860, liveChanges: 0, by: 'Ada' } } as never));
    expect(challenged.indexOf('play-dare-strip')).toBeGreaterThan(-1);
    expect(challenged.indexOf('play-dare-strip')).toBeLessThan(challenged.indexOf('data-testid="arcade"'));
    expect(renderToStaticMarkup(createElement(PlayShell, { ...(props as object), challenge: null } as never))).not.toContain('play-dare-strip');
    expect(renderToStaticMarkup(createElement(PlayShell, props))).not.toContain('play-dare-strip');
  });
});
