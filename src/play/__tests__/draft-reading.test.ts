/**
 * Draft ze čtení věty (P29B T4): když lokální model větu přečetl, bere draft
 * ovládání, hrdinu, role, místo a počty z čtení a klíčová slova použije jen
 * na to, co čtení nemá. Bez čtení se nic nemění (`evals/play/regression`).
 * Každý draft z 20 nahraných čtení musí projít robotem – čtečka nesmí
 * publikovat nevyhratelnou hru.
 */

import { describe, expect, it } from 'vitest';

import { reportFor } from '@/app/api/play/_report';

import { compileGame } from '../compile';
import { draftGameSpec, draftGameSpecWithMeta } from '../draft';
import type { Reading } from '../read/schema';
import recorded from '../read/__fixtures__/readings.json';

import { legacyDraft } from './legacy-draft';

const reading = (over: Partial<Reading>): Reading => ({
  control: 'runner',
  verbs: [],
  hero: null,
  roles: [],
  setting: null,
  mood: null,
  numbers: { seconds: null, counts: [] },
  ...over,
});

const label = (spec: { roles: readonly { id: string; label: string }[] }, id: string) => spec.roles.find((role) => role.id === id)?.label;
const count = (spec: { roles: readonly { id: string; count?: number }[] }, id: string) => spec.roles.find((role) => role.id === id)?.count;

describe('draft from the local reading', () => {
  it('without a reading is the keyword draft and says so', () => {
    const sentence = 'A corgi runs through a park grabbing sausages and jumping over sprinklers';
    const meta = draftGameSpecWithMeta(sentence);
    expect(meta.readBy).toBe('keywords');
    expect(draftGameSpecWithMeta(sentence, 1, { reading: null })).toEqual(meta);
    expect(meta.spec).toEqual(draftGameSpec(sentence));
  });

  // P32B T2: ovládání nové hry vybírá žánr; sloveso čtení rozhodne, když klíčová slova žádné neslyší.
  it('takes the genre from the verb of the reading when the keywords hear none', () => {
    const sentence = 'something with a knight';
    expect(draftGameSpecWithMeta(sentence).genre?.genre).not.toBe('platformer');
    const meta = draftGameSpecWithMeta(sentence, 1, { reading: reading({ verbs: [{ word: 'jump', class: 'platform' }] }) });
    expect(meta.genre?.genre).toBe('platformer');
    expect(meta.spec.control).toBe('platform');
    expect(meta.readBy).toBe('model');
  });

  it('the hero, the setting and the items of the reading land in the genre spec', () => {
    const meta = draftGameSpecWithMeta('something with a knight and three keys', 1, {
      reading: reading({ control: 'tap_go', hero: 'a knight', roles: [{ noun: 'keys', kind: 'collectible', count: 3 }], setting: 'a haunted castle' }),
    });
    expect(meta.genre).toMatchObject({ hero: 'knight', setting: 'haunted castle' });
    expect(meta.genre?.cast).toContainEqual({ label: 'key', does: 'collect' });
    expect(label(meta.spec, 'player')).toBe('knight');
    expect(meta.spec.theme.setting).toBe('haunted castle');
    expect(meta.spec.roles.map((role) => role.label)).toContain('key');
  });

  it('the hero, the setting and the roles of the reading win; keywords fill only what it lacks', () => {
    const sentence = 'A corgi runs through a park grabbing sausages and jumping over sprinklers';
    const read = draftGameSpecWithMeta(sentence, 1, {
      reading: reading({ hero: 'penguin', roles: [{ noun: 'fish', kind: 'collectible', count: null }], setting: 'an ice floe' }),
    }).spec;
    expect(label(read, 'player')).toBe('penguin');
    expect(label(read, 'coin')).toBe('fish');
    expect(read.theme.setting).toBe('ice floe');
    // Překážku čtení nejmenuje – zůstane z klíčových slov.
    expect(label(read, 'obstacle')).toBe('sprinkler');
    // Hrdinu čtení nejmenuje – zůstane z klíčových slov.
    const noHero = draftGameSpecWithMeta(sentence, 1, { reading: reading({}) }).spec;
    expect(label(noHero, 'player')).toBe('corgi');
  });

  it('a generic hero like "player" is no hero: the keywords name it', () => {
    const spec = draftGameSpecWithMeta('A corgi runs through a park', 1, { reading: reading({ hero: 'the player' }) }).spec;
    expect(label(spec, 'player')).toBe('corgi');
  });

  it('the remix template takes counts from the sentence; the genre draft takes the obstacle the reading names', () => {
    expect(count(legacyDraft('run through a city and grab 5 coins'), 'coin')).toBe(5);
    const threats = draftGameSpecWithMeta('run through a city', 1, { reading: reading({ roles: [{ noun: 'cones', kind: 'obstacle', count: 7 }] }) }).spec;
    expect(label(threats, 'obstacle')).toBe('cone');
  });

  // B-R4 (T5b): `GenreSpec.counts` nese počty čtení i do nové hry – generátor, role i cíl; běžec počty nečte (`COUNT_PARAMS`).
  it('the counts of the reading land in a new genre game', () => {
    const meta = draftGameSpecWithMeta('a cat collects fish in a kitchen', 1, {
      reading: reading({ control: 'move_free', hero: 'cat', roles: [{ noun: 'fish', kind: 'collectible', count: 12 }, { noun: 'dogs', kind: 'chaser', count: 3 }] }),
    });
    expect(meta.genre).toMatchObject({ genre: 'arena', mode: 'escape', counts: { enemy: 3, collectible: 12 } });
    expect(meta.spec.controlParams).toMatchObject({ generator: 'arena_escape', tuning: { chasers: 3, items: 12 } });
    expect([count(meta.spec, 'hunter'), count(meta.spec, 'item'), meta.spec.objective.count]).toEqual([3, 12, 12]);
  });

  it('seconds of the reading set the round length', () => {
    const meta = draftGameSpecWithMeta('survive the storm', 1, { reading: reading({ control: 'tap_go', numbers: { seconds: 45, counts: [] } }) });
    expect(meta.genre).toMatchObject({ genre: 'arena', mode: 'escape', params: { seconds: 45 } });
    expect(meta.spec.objective).toMatchObject({ kind: 'survive', seconds: 45 });
  });

  it('every draft of the 20 recorded readings publishes: the robot wins it', () => {
    expect(recorded.readings).toHaveLength(20);
    const unwinnable = recorded.readings.filter(({ sentence, reading: read }) => {
      const meta = draftGameSpecWithMeta(sentence, 1, { reading: read as Reading });
      const compiled = compileGame(meta.spec, 1);
      return meta.readBy !== 'model' || meta.fellBack || !compiled.ok || !reportFor(compiled.value).publishEligible;
    });
    expect(unwinnable.map((entry) => entry.id)).toEqual([]);
  });
});
