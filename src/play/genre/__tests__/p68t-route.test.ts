/**
 * P68T T2: druhé kolo směrování na zapojené hry. Zapečetěná sada P68R (T6) poslala do vlastní hry jen `railfps` 8,
 * `buildshift` 10, `drawsave` 11 a `minigolf` 13 z 15: střelbu z jeepu, balónu nebo obléhací věže brala plavba nebo
 * střelba, obchod bez slov „serve“ a „customers“ úkol, běh nebo Aréna, čáry, které blokují, Aréna nebo hod. Pin drží
 * věty z té sady (dnes otevřené) a hranici: vozidlo, které hráč řídí, střelba v místnosti, obchod jako místo a čekání,
 * na které nic nepadá, zůstávají, kde byly.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

import { classifyGenre } from '../classify';

const top = (sentence: string): string => {
  const best = classifyGenre(sentence, null).ranked[0]!;
  return `${best.genre}.${best.mode}`;
};

describe('P68T routing of railfps, buildshift, drawsave and minigolf', () => {
  // Otevřená sada P68R (p68r-0xx); po T6 šly do hry v závorce.
  it.each([
    ['railfps.default', 'Zombies lurch out of the cornfield while my tractor trailer rolls down the farm road and I have to turn and blast them'], // throw
    ['railfps.default', 'Make me a game where a grandma on a mobility scooter fires a water pistol at angry garden gnomes'], // shooter
    ['railfps.default', 'A knight on a moving siege tower shoots crossbow bolts at goblins climbing the walls'], // platformer
    ['railfps.default', 'Shoot the alien bugs from the back of a desert jeep as it speeds along'], // voyage
    ['railfps.default', "Make a game where I'm a kid on a school bus throwing water balloons at vampire teachers who jump out of the hallways"], // platformer
    ['railfps.default', 'Gun turret on a hover train, aim left and right at space pirates'], // voyage
    ['railfps.default', 'My hot air balloon drifts over the canyon and harpies swoop at me from every side so I have to turn and shoot them down'], // voyage
    ['buildshift.default', 'make me a game where I place ice cream machines on a beach boardwalk and serve sweaty tourists until sunset'], // quest
    ['buildshift.default', 'a game where I run a gas station for aliens and have to buy more pumps as saucers line up'], // runner
    ['buildshift.default', 'fairies flutter into my candy shop and I keep adding sugar spinners so nobody leaves empty handed'], // flap
    ['buildshift.default', 'make a burger joint tycoon thing but just one busy night'], // quest
    ['buildshift.default', 'I place juice presses in a jungle hut and monkeys grab mangoes before they get bored'], // arena
    ['buildshift.default', 'serve 20 knights their pancakes'], // klasifikátor quest, skladatel už buildshift
    ['drawsave.default', 'A hamster sits in the middle of the kitchen while eggs drop from the shelf and I have to draw something to stop them'], // arena
    ['drawsave.default', 'Can you make a drawing game where my lines block arrows shot at a knight'], // arena
    ['drawsave.default', 'Bowling balls roll down a hill toward a tiny gnome and my lines have to stop them'], // throw
    ['drawsave.default', 'A penguin waits on the ice while icicles crack and drop from above'], // arena
    ['minigolf.default', 'Flick a gumball down a twisty kitchen counter, bank it off the toaster and sink it in the sink drain before running out of shots.'], // runner
    ['minigolf.default', "Aim carefully and pick how hard to hit so the soccer ball curves around the locker room benches into the drain, with the janitor's mop sweeping by."], // throw
    // p55 h67 (otevřený holdout P55): dřív stanoviště úkolu.
    ['buildshift.default', 'Manage a pizza shop and sell slices to a crowd of hungry customers before closing time'],
  ])('plays %s: %s', (mode, sentence) => {
    expect(top(sentence)).toBe(mode);
  });

  // Hranice: hráč řídí, střílí v místnosti, obchod je jen místo, nic nepadá, tah není kreslení.
  it.each([
    ['shooter.default', 'drive a car down the highway and shoot the zombies'],
    ['shooter.default', 'an archer on a watchtower shoots goblins'],
    ['shooter.default', 'A submarine mechanic aims a harpoon gun around an underwater workshop, firing at robot eels as they swim in from every side.'],
    ['voyage.race', 'ride the bus to school'],
    ['throw.default', 'throw newspapers from your bike onto porches'],
    ['quest.station', 'a chef cooks burgers at one grill'],
    ['quest.station', 'build a time machine and travel to the dinosaurs'],
    ['arena.fight', 'the soldiers line up for battle'],
    ['arena.fight', 'draw your sword and fight the dragon'],
    ['catch.default', 'a boy stands under the apple tree while apples fall and catches them in a basket'],
  ])('keeps %s: %s', (mode, sentence) => {
    expect(top(sentence)).toBe(mode);
  });

  it('a sentence about a shop that wants no game, or a sitter nothing falls on, gets no new game', () => {
    for (const sentence of ['rising prices at my local grocery store', 'a cat sits on the fence while autumn leaves fall']) {
      expect(['buildshift', 'drawsave'], sentence).not.toContain(classifyGenre(sentence, null).ranked[0]!.genre);
    }
  });

  it('the quick game builds the same new game the classifier picked', () => {
    for (const [game, sentence] of [
      ['railfps', 'Shoot the alien bugs from the back of a desert jeep as it speeds along'],
      ['buildshift', 'a game where I run a gas station for aliens and have to buy more pumps as saucers line up'],
      ['drawsave', 'Bowling balls roll down a hill toward a tiny gnome and my lines have to stop them'],
      ['minigolf', "Aim carefully and pick how hard to hit so the soccer ball curves around the locker room benches into the drain, with the janitor's mop sweeping by."],
    ] as const) {
      expect(draftGameSpecWithMeta(sentence, 1).genre?.genre, sentence).toBe(game);
    }
  });
});
