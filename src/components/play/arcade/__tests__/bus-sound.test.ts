/**
 * Každá událost sběrnice efektů zní (P37B T5). Hra, ve které je zánik nebo
 * dopad jen vidět, na snímku vypadá v pořádku – že mlčí, z obrázku nepoznáš
 * (T1: 16 z 22 her tři sekundy bez zvuku). Pin hlídá úplnost tabulky,
 * že konec běhu přehluší zbytek tiku a že zvuk činnosti má každé sloveso.
 */

import { describe, expect, it } from 'vitest';

import { ROLE } from '@/play/arcade/contract';
import { HERO_ACTION_SFX, SFX_PRESETS } from '@/play/audio';
import { HERO_ACTIONS } from '@/play/spec';

import { VISUAL_EVENT_KINDS, type VisualEvent, type VisualEventKind } from '../effects/bus';
import { busEventOf, busPresets } from '../effects/sound';

const event = (kind: VisualEventKind, role: number = ROLE.player): VisualEvent => ({ kind, body: 1, role, x: 0, y: 0, z: 0, tick: 10 });

describe('bus sounds', () => {
  it.each(VISUAL_EVENT_KINDS)('a %s event plays a sound the synth knows', (kind) => {
    for (const role of [ROLE.player, ROLE.enemy]) {
      const presets = busPresets([event(kind, role)]);
      expect(presets, `${kind} role ${role}`).toHaveLength(1);
      expect(SFX_PRESETS[presets[0]!], presets[0]).toBeDefined();
    }
  });

  it('a hit on another body strikes, a hit on the player hurts', () => {
    expect(busPresets([event('hit', ROLE.enemy)])).toEqual(['strike']);
    expect(busPresets([event('hit', ROLE.player)])).toEqual(['hit']);
  });

  it('the end of the run drowns the rest of the tick, the loss beats the win', () => {
    expect(busPresets([event('pickup', ROLE.collectible), event('win')])).toEqual(['win']);
    expect(busPresets([event('win'), event('lose')])).toEqual(['lose']);
  });

  it('each sound of the tick sounds from the event that made it (P67 T8, used in VR only)', () => {
    const enemy = { ...event('hit', ROLE.enemy), body: 4, x: 3 };
    const player = { ...event('hit', ROLE.player), body: 1, x: -2 };
    const tick = [enemy, player];
    expect(busPresets(tick).map((preset) => busEventOf(tick, preset))).toEqual([enemy, player]);
    const end = [{ ...event('pickup', ROLE.collectible), x: 5 }, { ...event('lose'), x: 7 }];
    expect(busPresets(end).map((preset) => busEventOf(end, preset)?.x)).toEqual([7]);
  });

  it('plays each sound once per tick', () => {
    expect(busPresets([event('spawn', ROLE.enemy), event('spawn', ROLE.enemy), event('death', ROLE.enemy)])).toEqual(['spawn', 'pop']);
  });

  it('every hero action has its own sound', () => {
    for (const action of HERO_ACTIONS) {
      if (action === 'none') continue;
      expect(HERO_ACTION_SFX[action], action).toBeDefined();
    }
    const distinct = new Set(Object.values(HERO_ACTION_SFX).map((params) => params.join(',')));
    expect(distinct.size).toBe(HERO_ACTIONS.length - 1);
  });
});
