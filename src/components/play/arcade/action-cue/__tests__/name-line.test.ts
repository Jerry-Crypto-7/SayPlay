/**
 * Popisek jména (P58A T5): hrdina a nejbližší protivník/věc dostanou při prvním
 * objevení na 1,5 s své jméno – slovo z věty, ne jméno modelu. Krokodýl,
 * kterého hra kreslí robotem, se musí jmenovat „Crocodile“, jinak popisek
 * vypadá správně a lže. Jméno těla jde ze slotu, kterým ho scéna kreslí
 * (`userData.item`), ať štítek nad psem neříká „Fish“.
 */

import { describe, expect, it } from 'vitest';

import { heroChoice } from '@/play/arcade/models';
import type { GameSpecV1 } from '@/play/spec';

import { NAME_LINE_SECONDS, nameLines, nameSlotAt } from '../name-line';
import { VERB_LINE_SECONDS, verbLineShown } from '../verb-line';

type Role = { id: string; kind: string; label: string };
const spec = (control: string, objective: { kind: string; role?: string }, roles: Role[], generator?: string) =>
  ({ control, addons: [], objective: { description: 'x', ...objective }, roles, ...(generator === undefined ? {} : { controlParams: { generator } }) }) as unknown as GameSpecV1;

const hz = 60;

/** Souvislé úseky, kdy popisek něco ukazuje: slot → [první tik, počet tiků]. */
function runs(verb: boolean, playerRun = true): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  for (let tick = 0; tick < 20 * hz; tick++) {
    const slot = nameSlotAt(tick, hz, playerRun, verb);
    const last = out.at(-1);
    if (slot === null) continue;
    if (last !== undefined && last[0] === slot && last[1] + last[2] === tick) last[2]++;
    else out.push([slot, tick, 1]);
  }
  return out;
}

describe('nameLines', () => {
  it('names the hero and each body slot by the role that slot draws', () => {
    const shooter = nameLines(spec('shooter', { kind: 'defeat_targets', role: 'enemy' }, [
      { id: 'player', kind: 'player', label: 'pirate' },
      { id: 'enemy', kind: 'hazard', label: 'goblin' },
    ]));
    expect(shooter.hero).toBe('Pirate');
    expect(shooter.bodies.enemy).toBe('Goblin');
    const arena = nameLines(spec('move_free', { kind: 'collect', role: 'item' }, [
      { id: 'player', kind: 'player', label: 'cat' },
      { id: 'item', kind: 'collectible', label: 'fish' },
      { id: 'dogs', kind: 'chaser', label: 'dog' },
    ], 'arena_collect'));
    expect(arena.bodies.coin).toBe('Fish');
    expect(arena.bodies.chaser).toBe('Dog');
    expect(arena.bodies.foe).toBe('Dog');
  });

  it('carries the sentence word when the model is only a fallback', () => {
    const word = 'zorgblat';
    expect(heroChoice(word, undefined, 'shooter', 'enemy').level).toBe('fallback');
    const named = nameLines(spec('shooter', { kind: 'defeat_targets', role: 'enemy' }, [
      { id: 'player', kind: 'player', label: 'knight' },
      { id: 'enemy', kind: 'hazard', label: word },
    ]));
    expect(named.bodies.enemy).toBe('Zorgblat');
    expect(Object.values(named.bodies).join(' ')).not.toMatch(/robot/i);
  });

  it('gives no name to what the sentence does not name', () => {
    const runner = nameLines(spec('runner', { kind: 'reach', role: 'finish' }, [
      { id: 'player', kind: 'player', label: 'cat' },
      { id: 'finish', kind: 'exit', label: 'finish line' },
    ]));
    expect(runner.bodies).toEqual({});
    expect(nameLines(spec('runner', { kind: 'reach' }, [])).hero).toBeNull();
  });
});

describe('nameSlotAt', () => {
  const span = NAME_LINE_SECONDS * hz;

  it('shows the hero, then the foe, each once for 1.5 s', () => {
    expect(runs(true)).toEqual([
      ['hero', VERB_LINE_SECONDS * hz, span],
      ['foe', VERB_LINE_SECONDS * hz + span, span],
    ]);
  });

  it('never shares a tick with the verb line', () => {
    for (let tick = 0; tick < 20 * hz; tick++) if (verbLineShown(tick, hz, true)) expect(nameSlotAt(tick, hz, true, true)).toBeNull();
  });

  it('starts after the first move when the game has no verb line', () => {
    expect(runs(false)[0]).toEqual(['hero', 1, span]);
  });

  it('stays hidden while the robot demo plays', () => {
    expect(runs(true, false)).toEqual([]);
  });
});
