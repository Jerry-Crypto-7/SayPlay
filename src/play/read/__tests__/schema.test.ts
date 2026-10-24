/**
 * Čtení věty nese žánr, protivníka, předmět, svět a název (P56A T3). Všechna pole jsou povinná: volitelné pole by
 * gramatika llama.cpp i `strict` u Groq modelu dovolily tiše vynechat a čtení by vypadalo platně, jen bez žánru.
 */

import { describe, expect, it } from 'vitest';

import { LOOK_IDS } from '../../arcade/look';
import { GENRE_MODULES } from '../../genre/modules';
import { readerSystemPrompt } from '../prompt';
import { READ_CONTROLS } from '../../spec';
import { READING_JSON_SCHEMA, READY_GENRE_MODES, readingSchema, type Reading } from '../schema';

const READING: Reading = {
  control: 'runner',
  verbs: [{ word: 'dodges', class: 'runner' }],
  hero: 'astronaut',
  roles: [{ noun: 'asteroids', kind: 'obstacle', count: null }],
  setting: 'space station',
  mood: null,
  numbers: { seconds: null, counts: [] },
  genre: { genre: 'runner', mode: 'default' },
  sure: true,
  foe: 'asteroid',
  item: null,
  world: 'space',
  title: 'Asteroid Dash',
};

const FIELDS = ['control', 'verbs', 'hero', 'roles', 'setting', 'mood', 'numbers', 'genre', 'sure', 'foe', 'item', 'world', 'title'];

describe('readingSchema P56A fields', () => {
  it('accepts a full reading and the same reading with every new field null', () => {
    expect(readingSchema.safeParse(READING).success).toBe(true);
    expect(readingSchema.safeParse({ ...READING, genre: null, foe: null, item: null, world: null, title: null }).success).toBe(true);
  });

  it('refuses a reading that leaves a new field out', () => {
    for (const key of ['genre', 'foe', 'item', 'world', 'title'] as const) {
      const { [key]: _drop, ...without } = READING;
      expect(readingSchema.safeParse(without).success, key).toBe(false);
    }
  });

  it('takes only genre and mode pairs that play', () => {
    for (const { genre, modes } of READY_GENRE_MODES) for (const mode of modes) expect(readingSchema.safeParse({ ...READING, genre: { genre, mode } }).success, `${genre}.${mode}`).toBe(true);
    expect(readingSchema.safeParse({ ...READING, genre: { genre: 'runner', mode: 'stack' } }).success).toBe(false);
    expect(readingSchema.safeParse({ ...READING, genre: { genre: 'golf', mode: 'default' } }).success).toBe(false);
    expect(readingSchema.safeParse({ ...READING, genre: { genre: 'runner', mode: 'default', extra: 1 } }).success).toBe(false);
    const ready = Object.values(GENRE_MODULES).flatMap((module) => (module.modes as readonly string[]).filter((mode) => module.availability(mode as never) === 'ready').map((mode) => `${module.id}.${mode}`));
    expect(READY_GENRE_MODES.flatMap(({ genre, modes }) => modes.map((mode) => `${genre}.${mode}`)).sort()).toEqual(ready.sort());
  });

  it('takes a world only from the look sets and a title of 1 to 32 characters', () => {
    expect(readingSchema.safeParse({ ...READING, world: 'moon' }).success).toBe(false);
    expect(readingSchema.safeParse({ ...READING, title: '' }).success).toBe(false);
    expect(readingSchema.safeParse({ ...READING, title: 'x'.repeat(33) }).success).toBe(false);
    expect(readingSchema.safeParse({ ...READING, title: 'x'.repeat(32) }).success).toBe(true);
  });
});

describe('READING_JSON_SCHEMA', () => {
  it('requires every field, so neither grammar can drop one', () => {
    expect(READING_JSON_SCHEMA.required).toEqual(FIELDS);
    expect(READING_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('spells genre as closed pairs: every branch requires genre and mode and allows nothing else', () => {
    const genre = (READING_JSON_SCHEMA.properties as Record<string, { anyOf: Record<string, unknown>[] }>).genre;
    const branches = genre.anyOf.flatMap((branch) => ('anyOf' in branch ? (branch.anyOf as Record<string, unknown>[]) : [branch])).filter((branch) => branch.type === 'object');
    expect(branches).toHaveLength(READY_GENRE_MODES.length);
    for (const branch of branches) {
      expect(branch.required).toEqual(['genre', 'mode']);
      expect(branch.additionalProperties).toBe(false);
    }
    expect(genre.anyOf.some((branch) => branch.type === 'null')).toBe(true);
  });
});

describe('readerSystemPrompt', () => {
  const prompt = readerSystemPrompt();

  it('names every mode that plays, every look set and every control', () => {
    for (const { genre, modes } of READY_GENRE_MODES) for (const mode of modes) expect(prompt).toMatch(new RegExp(`- ${genre}\\.${mode}: \\S`));
    for (const look of LOOK_IDS) expect(prompt).toContain(look);
    for (const control of READ_CONTROLS) expect(prompt).toContain(control);
    for (const field of ['genre:', 'foe:', 'item:', 'world:', 'title:']) expect(prompt).toContain(field);
  });
});
