/**
 * P83C T4: rychlá hra posílá věty „ukaž mi a nech mě sáhnout“ do klikací simulace (`orrery`) a bere věci z věty.
 * Pin drží práh plánu nad vývojovou sadou T1 (≥ 16/20 do `orrery`, 0/10 obyčejných her s „click“, „tap“ nebo „planet“)
 * a čtení: výčet, předmět klepnutí, věc ve středu a známý celek z tabulky.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { draftGameSpecWithMeta } from '@/play/draft';

import { classifyGenre } from '../classify';
import { ORRERY_WHOLES, orreryGenre, orreryThingsOf } from '../orrery';

interface Sentence {
  readonly id: string;
  readonly text: string;
}
const SET = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../evals/play/p83/c-sentences.json'), 'utf8')) as {
  readonly dev: readonly Sentence[];
  readonly not_orrery: readonly Sentence[];
};

const top = (sentence: string): string => classifyGenre(sentence, null).ranked[0]!.genre;

describe('P83C routing of explore-and-touch sentences', () => {
  it('sends at least 16 of the 20 dev sentences to orrery', () => {
    const missed = SET.dev.filter((sentence) => top(sentence.text) !== 'orrery').map((sentence) => sentence.id);
    expect(SET.dev.length - missed.length, missed.join(', ')).toBeGreaterThanOrEqual(16);
  });

  it('sends none of the 10 ordinary click, tap or planet games to orrery', () => {
    expect(SET.not_orrery.filter((sentence) => top(sentence.text) === 'orrery').map((sentence) => sentence.id)).toEqual([]);
  });

  it('reads the things from a list, the tapped thing and the thing in the middle', () => {
    expect(orreryThingsOf('show me a farm with a cow, a pig, a sheep and a horse, and tapping one makes it jump').things).toEqual(['cow', 'pig', 'sheep', 'horse']);
    expect(orreryThingsOf('explore a candy shop where lollipops, cupcakes and donuts light up when you click them').things).toEqual(['lollipop', 'cupcake', 'donut']);
    expect(orreryThingsOf('a toy shelf with a robot, a teddy bear and a rocket that spin when clicked').things).toEqual(['robot', 'teddy bear', 'rocket']);
    expect(orreryThingsOf('fireflies circling a lamp at night, tap a firefly to make it shine brighter')).toEqual({ things: ['firefly'], hub: 'lamp' });
    // „ring and glow“ jsou slovesa, ne výčet věcí.
    expect(orreryThingsOf('a row of bells that ring and glow when you tap them').things).toEqual(['bell']);
  });

  it('a known whole takes its things from the table, the sentence picks the answer and the count', () => {
    const solar = orreryGenre.draftFill('a solar system where clicking a planet shows its name and makes it orbit faster', null);
    expect(solar.params).toEqual({ things: 9, layout: 0, answer: 1, hub: 1, whole: 1 });
    const spec = orreryGenre.compile({ genre: 'orrery', mode: 'default', hero: 'explorer', setting: 'space', params: solar.params });
    expect(spec.roles.filter((role) => role.kind === 'target').map((role) => role.label)).toEqual(ORRERY_WHOLES[0]!.things);
    // „five wagons“: počet z věty; „circling a track“ dráha, ne věc ve středu.
    expect(orreryGenre.draftFill('a toy train with five wagons circling a track, click a wagon to light it up', null).params).toMatchObject({ things: 5, layout: 0, answer: 0, hub: 0, whole: 0 });
  });

  // T7 (první brána): hodinový stroj spadl do sbírání („turn faster when you tap them“), orchestr do rytmu („drum“).
  it('a comparative answer before a tap on a pronoun is explore and beats another game’s cue word', () => {
    expect(top('a clockwork machine with gears that turn faster when you tap them')).toBe('orrery');
    expect(top('an orchestra on a stage with a violin, a drum, a trumpet and a flute that each get brighter when clicked')).toBe('orrery');
    expect(top('a drum kit with a drum, a cymbal and a guitar that light up when you tap them')).toBe('orrery');
    expect(top('a toy robot, click one and it spins faster')).toBe('orrery');
    // Klepnutí na obrazovku věc nejmenuje: hra zůstává svému typu.
    expect(top('a car that goes faster when you tap the screen')).not.toBe('orrery');
  });

  it('the heart names its four parts, a city keeps the buildings the sentence lists', () => {
    const heart = orreryGenre.draftFill('the human heart with its four chambers, tap a chamber to learn its name', null);
    const heartSpec = orreryGenre.compile({ genre: 'orrery', mode: 'default', hero: 'explorer', setting: 'body', ...(heart.params === undefined ? {} : { params: heart.params }) });
    expect(heartSpec.roles.filter((role) => role.kind === 'target').map((role) => role.label)).toEqual(['left atrium', 'right atrium', 'left ventricle', 'right ventricle']);
    const city = orreryGenre.draftFill('a map of a little city with a school, a hospital, a park and a station that light up when touched', null);
    expect(city.cast?.map((item) => item.label)).toEqual(['school', 'hospital', 'park', 'station']);
    expect(city.params).toMatchObject({ things: 4, layout: 3, whole: 0 });
    // Celek bez vlastních věcí („the buildings“) bere věci z tabulky; orchestr s výčtem drží dirigenta ve středu.
    expect(orreryGenre.draftFill('explore a little town, tap the buildings to see their names', null).params).toMatchObject({ things: 6, whole: 8 });
    expect(orreryGenre.draftFill('an orchestra with a violin, a drum and a flute that glow when you tap them', null).cast?.map((item) => item.label)).toEqual(['conductor', 'violin', 'drum', 'flute']);
  });

  it('the quick game builds the orrery scene the classifier picked', () => {
    const meta = draftGameSpecWithMeta('a solar system where clicking a planet shows its name and makes it orbit faster', 1);
    expect(meta.genre?.genre).toBe('orrery');
    expect(meta.spec.control).toBe('orrery');
  }, 180_000);
});
