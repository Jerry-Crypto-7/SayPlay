/**
 * Řádek se slovesem (P43 T7): řekne jen sloveso, které hra opravdu hraje, a
 * jmenuje věc, se kterou ho hrdina dělá. Řádek se slovesem, které hra nehraje,
 * se čte dobře a lže – proto se skládá ze specu, ne z věty.
 */

import { describe, expect, it } from 'vitest';

import type { GameSpecV1 } from '@/play/spec';

import { VERB_LINE_MAX, verbLine } from '../verb-line';

type Role = { id: string; kind: string; label: string };
const spec = (control: string, objective: { kind: string; role?: string }, roles: Role[], addons: string[] = []) =>
  ({ control, addons, objective: { description: 'x', ...objective }, roles }) as unknown as GameSpecV1;

describe('verbLine', () => {
  it('names the played verb and the thing it is done to', () => {
    expect(verbLine(spec('shooter', { kind: 'defeat_targets', role: 'enemy' }, [{ id: 'enemy', kind: 'hazard', label: 'goblin' }]))).toBe('Shoot the goblins!');
    expect(verbLine(spec('move_free', { kind: 'collect', role: 'item' }, [{ id: 'item', kind: 'collectible', label: 'pearl' }]))).toBe('Grab the pearls!');
    expect(verbLine(spec('throw', { kind: 'defeat_targets', role: 'target' }, [{ id: 'target', kind: 'target', label: 'passing ship' }]))).toBe('Throw at the passing ships!');
    expect(verbLine(spec('duel', { kind: 'reach', role: 'finish' }, [{ id: 'rival', kind: 'hazard', label: 'frost giants' }]))).toBe('Beat the frost giants!');
  });

  it('says nothing for a game whose verbs have no visible event of their own', () => {
    expect(verbLine(spec('rhythm', { kind: 'reach', role: 'finish' }, [{ id: 'finish', kind: 'exit', label: 'last beat' }]))).toBeNull();
    expect(verbLine(spec('runner', { kind: 'reach', role: 'finish' }, [{ id: 'finish', kind: 'exit', label: 'finish line' }]))).toBeNull();
    // "Interact" says nothing about what the hero does (light, free, press): the goal line names it.
    expect(verbLine(spec('move_free', { kind: 'puzzle', role: 'target' }, [{ id: 'target', kind: 'target', label: 'lanterns' }]))).toBeNull();
  });

  it('stays an objective-length line in English sentence case', () => {
    const long = verbLine(spec('move_free', { kind: 'collect', role: 'item' }, [{ id: 'item', kind: 'collectible', label: 'very long winding description of a magical glowing gemstone' }]));
    expect(long).toBe('Grab them!');
    expect(VERB_LINE_MAX).toBe(50);
  });
});
