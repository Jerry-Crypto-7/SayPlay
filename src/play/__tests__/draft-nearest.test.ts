/**
 * Nejbližší arkáda (P28D T2, F-05): věta, ve které slova ovládání ani mřížka
 * nic neslyší, dostala sběr hub. Teď sloveso → ovládání, podstatné jméno →
 * ovládání, jinak běžec – a každý z 40 návrhů měřicích sad musí projít
 * robotem, jinak by se publikovala nevyhratelná hra.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reportFor } from '@/app/api/play/_report';

import { enemyModel, heroModel, propModels } from '../arcade/models';
import { compileGame } from '../compile';
import { fidelityChain } from '../fidelity/chain';
import { draftGameSpec, draftGameSpecWithMeta } from '../draft';
import { nearestControl } from '../draft/controls';

import { legacyDraft } from './legacy-draft';

const DIR = join(process.cwd(), 'evals', 'play', 'fidelity');
const sentences = (file: string): { id: string; text: string }[] => JSON.parse(readFileSync(join(DIR, file), 'utf8')).sentences;

const label = (sentence: string, id: string): string | undefined => draftGameSpec(sentence).roles.find((role) => role.id === id)?.label;

describe('nearest arcade game for a sentence the draft does not know', () => {
  it.each([
    ['pop the bubbles on the ceiling', 'shooter'],
    ['defend the village', 'shooter'],
    ['ride a unicorn over the rainbow', 'flap'],
    ['drive home after work', 'steer'],
    ['dodge the falling pianos', 'move_free'],
    ['climb the beanstalk', 'platform'],
    ['throw pies at the teacher', 'throw'],
    ['sing a song to the moon', 'rhythm'],
    ['fight the dentist', 'duel'],
  ])('reads the verb of %j as %s', (sentence, control) => {
    expect(nearestControl(sentence)).toMatchObject({ choice: { control }, why: 'verb' });
  });

  it('falls back to a noun, then to the runner, never to the grid', () => {
    expect(nearestControl('a birthday with balloons')).toMatchObject({ choice: { control: 'shooter' }, why: 'noun' });
    expect(nearestControl('a dragon in my garden')).toMatchObject({ choice: { control: 'flap' }, why: 'noun' });
    expect(nearestControl('explain quantum physics to my grandma')).toMatchObject({ choice: { control: 'runner' }, why: 'default' });
  });

  it('drafts a sentence without any cue as a runner, not as mushrooms on the grid', () => {
    const spec = draftGameSpec('Explain quantum physics to my grandma.');
    expect(spec.control).toBe('runner');
    expect(spec.roles.map((role) => role.label.toLowerCase()).join(' ')).not.toMatch(/mushroom/);
  });

  // Remix uložené mřížkové hry (P32B T2): slova ovládání mřížku nepřebijí, kde mluví její narážky.
  it('keeps the grid where its own cues speak: collect, crossing, calm, search', () => {
    expect(legacyDraft('a knight collects keys in a castle').control).toBeUndefined();
    expect(legacyDraft('A frog must hop across the road and dodge cars').archetype).toBe('hazard_crossing');
    expect(legacyDraft('something relaxing with bubbles').control).toBeUndefined();
    expect(legacyDraft('explore underwater ruins as a little submarine').control).toBeUndefined();
  });

  it('puts the nouns of the sentence into the roles the control reads', () => {
    const corgi = 'A corgi runs through a park grabbing sausages and jumping over sprinklers';
    expect(label(corgi, 'coin')).toBe('sausage');
    expect(label(corgi, 'obstacle')).toBe('sprinkler');
    expect(label("temple run but you're a banana running from a monkey", 'obstacle')).toBe('monkey');
    const cats = 'angry birds but with cats and cardboard boxes';
    expect(label(cats, 'player')).toBe('cat');
    // Terč hodu je šablona remixu; žánrový Úkol dá krabice do svého terče.
    expect(legacyDraft(cats).roles.find((role) => role.id === 'target')?.label).toBe('cardboard box');
    expect(draftGameSpecWithMeta(cats).genre?.target?.label).toBe('cardboard box');
    expect(label('purple elephants doing taxes on a volcano', 'player')).toBe('purple elephant');
    // Sloveso na -ing frázi končí: ne „swords cutting“.
    expect(draftGameSpec('like beat saber but with swords cutting fruit to music').roles.map((role) => role.label)).not.toContain('swords cutting');
  });

  // P28D T3 (F-05, F-27): podstatná jména věty přebijí rekvizity šablony a titul nekončí předložkou.
  // Střelnice a hod jsou od P32B T2 šablony remixu uložené hry.
  it('draws the knight, the dragon and targets, and titles the game without a dangling preposition', () => {
    const spec = legacyDraft('A knight rides a dragon over a burning castle and must pop ten balloons.', 1, 'shooter');
    expect(spec.control).toBe('shooter');
    expect(heroModel(spec)).toBe('rigged:knight');
    expect(enemyModel(spec)).toBe('cc0-dragon');
    expect(spec.title).toBe('Knight Rides Dragon');
    // Balónek má od e5b840b model z gen3d: scéna ho nakreslí a řetěz věrnosti ho započte.
    const balloons = legacyDraft('pop ten balloons at a birthday party', 1, 'shooter');
    expect(enemyModel(balloons)).toBe('gen3d-balloon');
    expect(fidelityChain(balloons, [{ item: 'balloon', slot: 'any', match: ['balloon'] }])[0]).toMatchObject({ read: true, drawn: true });
    // Věž hodu z krabic: kostky kreslí model z popisku terče – od P30B T4 dvojslovný tag, kartonová krabice místo bedny.
    expect(propModels(legacyDraft('angry birds but with cats and cardboard boxes')).target).toBe('gen3d-cardboard-box');
  });

  it('every draft of the 30 + 10 fidelity sentences publishes: the robot wins it', () => {
    const all = [...sentences('corpus.json'), ...sentences('judge-10.json')];
    expect(all).toHaveLength(40);
    const unwinnable = all.filter(({ text }) => {
      const compiled = compileGame(draftGameSpec(text), 1);
      return !compiled.ok || !reportFor(compiled.value).publishEligible;
    });
    expect(unwinnable.map((entry) => entry.id)).toEqual([]);
  });
});
