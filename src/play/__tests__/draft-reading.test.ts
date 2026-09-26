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

  it('takes the control from the reading over the keywords', () => {
    const sentence = 'a knight collects keys in a castle';
    expect(draftGameSpec(sentence).control).toBeUndefined();
    const meta = draftGameSpecWithMeta(sentence, 1, { reading: reading({ control: 'shooter' }) });
    expect(meta.spec.control).toBe('shooter');
    expect(meta.readBy).toBe('model');
  });

  it('a tap_go reading drafts the grid with the roles it read', () => {
    const meta = draftGameSpecWithMeta('something with a knight and three keys', 1, {
      reading: reading({ control: 'tap_go', hero: 'a knight', roles: [{ noun: 'keys', kind: 'collectible', count: 3 }], setting: 'a haunted castle' }),
    });
    expect(meta.spec.control).toBeUndefined();
    expect(meta.archetype).toBe('collect_exit');
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

  it('counts come from the reading, over the counts the keywords found', () => {
    const sentence = 'run through a city and grab 5 coins';
    expect(count(draftGameSpec(sentence), 'coin')).toBe(5);
    const read = draftGameSpecWithMeta(sentence, 1, { reading: reading({ roles: [{ noun: 'coins', kind: 'collectible', count: 12 }] }) }).spec;
    expect(count(read, 'coin')).toBe(12);
    const threats = draftGameSpecWithMeta('run through a city', 1, { reading: reading({ roles: [{ noun: 'cones', kind: 'obstacle', count: 7 }] }) }).spec;
    expect(label(threats, 'obstacle')).toBe('cone');
    expect(count(threats, 'obstacle')).toBe(7);
  });

  it('seconds of the reading set the grid timer', () => {
    const meta = draftGameSpecWithMeta('survive the storm', 1, { reading: reading({ control: 'tap_go', numbers: { seconds: 45, counts: [] } }) });
    expect(meta.archetype).toBe('survival_timer');
    expect(JSON.stringify(meta.spec)).toContain('45');
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
