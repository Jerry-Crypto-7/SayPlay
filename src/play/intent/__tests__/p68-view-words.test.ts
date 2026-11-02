/**
 * P68 T10: slova o pohledu („first-person“, „through your own eyes“, „top-down“) nejsou postava ani věc. Čtení záměru
 * je dál zahazuje (`NOT_AN_ACTOR` v `extract.ts`) u každé hry – kdyby „first-person“ propadlo do herců, změnila by se
 * věrnost všech her. Pohled slyší jen klasifikátor ze surové věty, a to jen spolu se střelbou (znak `railshoot`).
 */

import { describe, expect, it } from 'vitest';

import { classifyGenre } from '@/play/genre/classify';

import { extractIntent } from '../extract';

const VIEW = /^(?:first|person|first-person|third-person|top-down|side-scrolling|twin-stick)$/;

const SENTENCES = [
  // railfps (dev d17, d23)
  'a first-person ride in a mine cart on rails, turning to shoot the bats that swoop at you in the dark tunnels',
  'a first person rail shooter on a space station monorail, blasting drones before they reach you',
  // jiné hry se slovem pohledu
  'walk through a first-person maze and find the golden key',
  'sneak past the guards in first person and steal the diamond',
  'a first-person race through the city streets in a sports car',
  'a top-down shooter where you blast robots in a factory',
  'a third-person platformer where a fox jumps over spikes',
  'a twin-stick game where a robot dodges lasers',
];

describe('view words are no actor or thing in any game (P68 T10)', () => {
  it.each(SENTENCES)('no view word in hero, actors or objects: %s', (sentence) => {
    const intent = extractIntent(sentence);
    const names = [intent.hero, ...intent.items.flatMap((item) => [item.actor, item.object])].filter((name): name is string => name !== null);
    expect(names.filter((name) => VIEW.test(name))).toEqual([]);
  });

  it('the classifier hears first person only together with a shot', () => {
    expect(classifyGenre(SENTENCES[0]!, null).ranked[0]!.genre).toBe('railfps');
    expect(classifyGenre(SENTENCES[1]!, null).ranked[0]!.genre).toBe('railfps');
    for (const sentence of SENTENCES.slice(2)) expect(classifyGenre(sentence, null).ranked[0]!.genre, sentence).not.toBe('railfps');
  });
});
