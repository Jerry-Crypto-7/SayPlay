/**
 * P68R T2: rychlá hra posílá věty minigolfu, střelnice na kolejích a kreslení do jejich her. Holdout P68 (T15) jim dal
 * jen 10, 4 a 10 z 15: jízdu lanovkou, ziplinou nebo vláčkem se střelbou brala plavba, střelba nebo plošinovka, jamku
 * bez slova golf běh, střelba nebo plavba, nakreslený plot, cestu nebo tah Aréna. Pin drží věty, které dřív šly jinam,
 * a hranici: jízda bez výstřelu zůstává plavbou, hod do kelímku hodem, golf bez jamky tam, kde byl.
 */

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

import { classifyGenre } from '../classify';

const top = (sentence: string): string => {
  const best = classifyGenre(sentence, null).ranked[0]!;
  return `${best.genre}.${best.mode}`;
};

describe('P68R routing of the wired new games', () => {
  // Otevřený holdout P68 (p68-0xx) a dev P68 (d16, d36); na `main` šly do hry v závorce.
  it.each([
    ['railfps.default', 'ride a cable car up a snowy mountain and shoot the yetis climbing toward your cabin'], // platformer
    ['railfps.default', 'ride a zip line through a jungle canopy and fire at the parrots dive-bombing you on the way down'], // shooter
    ['railfps.default', 'a gondola lift ride over a haunted forest, aiming a crossbow at the bats that dive toward you'], // voyage
    ['railfps.default', 'you are a passenger on an old steam train crossing a prairie, turn your head and shoot the vultures swooping at the carriage'], // shooter
    ['railfps.default', 'a sleigh pulled along a fixed trail through a frozen forest while you fire snowballs at the ice wolves chasing you'], // arena
    ['minigolf.default', 'sink the ball on a jungle course where snakes slide across the green and block your shot'], // runner
    ['minigolf.default', 'get the marble into the hole in two strokes on a wooden board full of nails and little ramps'], // voyage
    ['minigolf.default', 'aim carefully and choose the power to roll the ball over a narrow bridge and into the cup'], // shooter
    ['minigolf.default', 'a putting challenge on a spaceship deck where the ball curves around magnets before dropping into the hole'], // voyage
    ['minigolf.default', 'a penguin taps a snowball across an icy course with a fish for a club, past igloos and over a frozen bridge into the hole'], // arena
    ['drawsave.default', 'a puzzle where you draw one stroke to shelter a kitten from bouncing tennis balls'], // platformer
    ['drawsave.default', 'seen from the side, a toy car rolls toward a gap in the shelf, draw a path under it before it tips over the edge'], // voyage
    ['drawsave.default', 'draw a fence to keep the lamb safe from the fox until the farmer arrives'], // arena
    ['drawsave.default', 'a melting snowman needs a drawn shield against the fireballs a dragon spits for half a minute'], // arena
    ['drawsave.default', 'draw a ramp so the rolling apple does not fall into the river'], // voyage
  ])('plays %s: %s', (mode, sentence) => {
    expect(top(sentence)).toBe(mode);
  });

  // Hranice: jízda, kterou nic neveze ke střelbě, a golf ani hod bez jamky hru nemění.
  it.each([
    ['voyage.race', 'ride a cable car up a snowy mountain to the summit'],
    ['voyage.race', 'a gondola glides over a misty valley to the castle on the hill'],
    ['voyage.race', 'a raft drifts down a jungle river past crocodiles to the waterfall'],
    ['voyage.race', 'a safari jeep drives through the savanna while you photograph the lions'],
    ['shooter.default', 'a cowboy rides a horse across the desert and shoots the bandits'],
    ['platformer.default', 'jump on moving platforms and shoot the robots'],
    ['throw.default', 'a golfer chips balls past sand traps and ponds on a seaside golf course'],
    ['throw.default', 'toss ping pong balls into the cups at the fair'],
    ['whack.default', 'bonk the moles popping out of the golf course'],
    ['arena.fight', 'draw your sword and fight the dragon'],
  ])('keeps %s: %s', (mode, sentence) => {
    expect(top(sentence)).toBe(mode);
  });

  it('the quick game builds the same new game the classifier picked', () => {
    for (const [game, sentence] of [
      ['railfps', 'ride a zip line through a jungle canopy and fire at the parrots dive-bombing you on the way down'],
      ['minigolf', 'sink the ball on a jungle course where snakes slide across the green and block your shot'],
      ['drawsave', 'draw a fence to keep the lamb safe from the fox until the farmer arrives'],
    ] as const) expect(draftGameSpecWithMeta(sentence, 1).genre?.genre, sentence).toBe(game);
  }, 180_000);
});
