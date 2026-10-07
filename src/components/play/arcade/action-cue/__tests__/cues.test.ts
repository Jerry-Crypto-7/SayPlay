/**
 * Podněty akce (P43 T4): sloveso z věty dostane podnět jen tehdy, když hra
 * vydala odpovídající událost – nikdy z názvu slovesa samotného.
 */

import { describe, expect, it } from 'vitest';

import { ROLE } from '@/play/arcade/contract';
import { ACTIONS, OBJECTIVES } from '@/play/intent/contract';
import type { GameSpecV1 } from '@/play/spec';

import type { VisualEvent, VisualEventKind } from '../../effects/bus';
import { CUE_EVENTS, cuesOf, verbsOfSpec } from '../cues';

const PLAYER = 0;
const event = (kind: VisualEventKind, body: number, tick = 10): VisualEvent => ({ kind, body, role: body === PLAYER ? ROLE.player : ROLE.enemy, x: 1, y: 0, z: 2, tick });

describe('cuesOf', () => {
  it('knows every action and objective verb, mapped or explicitly silent', () => {
    expect(Object.keys(CUE_EVENTS).sort()).toEqual([...new Set([...ACTIONS, ...OBJECTIVES])].sort());
  });

  it('gives a played verb a cue at the event tick, aimed at the body it touched', () => {
    expect(cuesOf(['shoot'], [event('hit', 3, 42)], PLAYER)).toEqual([{ verb: 'shoot', at: 42, target: 3, x: 1, y: 0, z: 2 }]);
    expect(cuesOf(['collect'], [event('pickup', 5)], PLAYER)).toEqual([{ verb: 'collect', at: 10, target: 5, x: 1, y: 0, z: 2 }]);
    expect(cuesOf(['deliver'], [event('stateChange', 6)], PLAYER).map((cue) => cue.verb)).toEqual(['deliver']);
    expect(cuesOf(['reach'], [event('win', PLAYER)], PLAYER)).toEqual([{ verb: 'reach', at: 10, x: 1, y: 0, z: 2 }]);
  });

  it('gives no cue to a verb whose event never happened', () => {
    expect(cuesOf(['shoot', 'collect'], [], PLAYER)).toEqual([]);
    expect(cuesOf(['shoot'], [event('pickup', 5)], PLAYER)).toEqual([]);
    // Verb with no visible event of its own (keeping time) stays silent whatever happens.
    expect(cuesOf(['time'], [event('hit', 3), event('pickup', 4), event('win', PLAYER)], PLAYER)).toEqual([]);
  });

  it('does not credit the hero with what was done to the hero', () => {
    expect(cuesOf(['shoot', 'fight'], [event('hit', PLAYER)], PLAYER)).toEqual([]);
  });
});

describe('verbsOfSpec', () => {
  const spec = (patch: Partial<GameSpecV1>) => ({ control: 'tap_go', addons: [], objective: { kind: 'reach', description: 'x' }, ...patch }) as unknown as GameSpecV1;

  it('reads the verbs the game plays from control, addons, objective and hero action', () => {
    expect(verbsOfSpec(spec({ control: 'shooter', objective: { kind: 'defeat_targets', description: 'x' } }))).toEqual(['shoot', 'defeat']);
    expect(verbsOfSpec(spec({ control: 'move_free', addons: ['collect'], objective: { kind: 'collect', description: 'x' } }))).toEqual(['collect']);
    expect(verbsOfSpec(spec({ heroAction: 'carry', objective: { kind: 'deliver', description: 'x' } }))).toEqual(['deliver']);
    expect(verbsOfSpec(spec({}))).toEqual(['reach']);
  });
});
