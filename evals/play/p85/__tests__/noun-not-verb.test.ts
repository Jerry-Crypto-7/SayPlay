/**
 * P85A T2: podstatné jméno s tvarem slovesa („a building“, „three hits“) nestaví hru.
 * Před opravou: „A city where clicking a building shows how many people live there“ byl úkol „Make all 2 shows hows“
 * („building“ = stavět; odpověď „shows how many“ klikací scéna neznala) a „Two knights joust and the first to three hits
 * wins“ úkol „Use all 3 coins“ se soupeřem „win“ („hits wins“ = trefit výhru; „joust“ souboj neznal).
 * Obměny: jiné místo, jiní soupeři, jiný počet.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { classifyGenre } from '@/play/genre/classify';

import { readSentence } from '../read';

beforeAll(async () => {
  await loadRapier();
});

const TAP_PLACES = [
  ['A city where clicking a building shows how many people live there', 'city'],
  ['A village where tapping a building shows how many people live in it', 'village'],
  ['A harbor where clicking a boat shows how many fish it caught', 'harbor'],
] as const;

const DUELS = [
  ['Two knights joust and the first to three hits wins', 'knight'],
  ['Two pirates joust and the first to five hits wins', 'pirate'],
  ['Two wizards joust on dragons and the first to two hits wins', 'wizard'],
  ['Two robots joust in an arena', 'robot'],
] as const;

describe('P85A T2: a noun shaped like a verb is not the game verb', () => {
  it.each(TAP_PLACES)('%s is the tap-to-explore scene', async (sentence, place) => {
    expect(classifyGenre(sentence, null).verb).not.toBe('make');
    const read = await readSentence('-', sentence);
    expect(read.genre).toBe('orrery');
    expect(read.place).toContain(place);
    expect(read.goal).toMatch(/^Tap the /);
  });

  it.each(DUELS)('%s is a duel against another %s, never against "win"', async (sentence, rival) => {
    expect(classifyGenre(sentence, null).verb).toBe('duel');
    const read = await readSentence('-', sentence);
    expect(read.genre).toBe('duel');
    expect(read.you).toBe(rival);
    expect(read.against).toEqual([rival]);
  });
});
