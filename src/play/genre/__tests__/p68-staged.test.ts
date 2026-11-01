/**
 * Pět her P68 (T1): kostry ve všech sdílených registrech a brána aktivace. Kategorie (P68-V/F/S) smí modul své hry
 * přepnout na `ready` a napsat mu narážky dřív, než ho P68-I zapojí – proto test kostry NEVĚŘÍ `staged`: modul každé
 * nové hry tu podvrhne jako hotový (`ready`, narážky ze slov dev vět) a hlídá, že ho přesto nevidí klasifikátor
 * (`ROUTE_PENDING`), režisér (`DIRECTOR_PENDING`) ani čtečka (`READER_PENDING`, `READ_CONTROLS`). Hru zapne jen úloha
 * „zapoj X“ odebráním ze všech tří množin.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '@/play/director/answer-schema';
import { directorSystemPrompt, genrePromptLines } from '@/play/director/prompt';
import { readerSystemPrompt } from '@/play/read/prompt';
import { READ_CONTROLS } from '@/play/spec';

import { ROUTE_PENDING, classifyGenre } from '../classify';
import { GENRES, GENRE_COMPILER_VERSION, GENRE_MODES, type GenreId } from '../contract';
import { GENRE_MODULES } from '../index';
import { P68_GENRES } from '../p68-contract';

/** Narážky, které by kategorie hře napsala – slova, která dev věty P68 opravdu obsahují. */
const FAKE_CUES = vi.hoisted(() => ({
  stunt: ['stunt', 'ramp', 'jump', 'race', 'crash', 'track'],
  minigolf: ['golf', 'putt', 'hole', 'ball', 'course', 'stroke'],
  railfps: ['shoot', 'rail', 'aim', 'cart', 'target', 'ride'],
  buildshift: ['shop', 'build', 'serve', 'customer', 'counter', 'shift'],
  drawsave: ['draw', 'line', 'wall', 'protect', 'save', 'shield'],
}));

// Podvrh: modul každé nové hry jako by ho kategorie dodala hotový (překlad zůstává kostrový – hází).
vi.mock('../stunt', async (real) => ({ stuntGenre: { ...(await real<typeof import('../stunt')>()).stuntGenre, availability: () => 'ready', cues: FAKE_CUES.stunt } }));
vi.mock('../minigolf', async (real) => ({ minigolfGenre: { ...(await real<typeof import('../minigolf')>()).minigolfGenre, availability: () => 'ready', cues: FAKE_CUES.minigolf } }));
vi.mock('../railfps', async (real) => ({ railfpsGenre: { ...(await real<typeof import('../railfps')>()).railfpsGenre, availability: () => 'ready', cues: FAKE_CUES.railfps } }));
vi.mock('../buildshift', async (real) => ({ buildshiftGenre: { ...(await real<typeof import('../buildshift')>()).buildshiftGenre, availability: () => 'ready', cues: FAKE_CUES.buildshift } }));
vi.mock('../drawsave', async (real) => ({ drawsaveGenre: { ...(await real<typeof import('../drawsave')>()).drawsaveGenre, availability: () => 'ready', cues: FAKE_CUES.drawsave } }));

const P68 = ['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'] as const;
/** Hry, které už úloha „zapoj X“ pustila (T11 `buildshift`) – brána aktivace drží jen zbytek. */
const WIRED: readonly string[] = ['buildshift'];
const PENDING = P68.filter((genre) => !WIRED.includes(genre));
const PLAY = join(process.cwd(), 'evals', 'play');
const sentencesOf = (set: string): string[] => {
  const json = JSON.parse(readFileSync(join(PLAY, set), 'utf8')) as { text: string }[] | { sentences: { text: string }[] };
  return (Array.isArray(json) ? json : json.sentences).map((row) => row.text);
};
/** Celé slovo id hry v textu promptu (`stunt` ano, `stunts` v cizí větě taky – prompt slovo nesmí mít vůbec). */
const mentions = (text: string, id: string): boolean => new RegExp(`\\b${id}`, 'i').test(text);

describe('P68 skeletons (T1)', () => {
  it('the contract has 29 genres: the 24 before P68 and five new ones with one default mode', () => {
    expect(GENRES).toHaveLength(29);
    expect(P68_GENRES).toEqual(P68);
    for (const genre of P68) {
      expect(GENRES).toContain(genre);
      expect(GENRE_MODES[genre as GenreId]).toEqual(['default']);
      expect(GENRE_MODULES[genre as GenreId].id).toBe(genre);
    }
    expect(GENRE_COMPILER_VERSION).toBe('genre.v7');
  });

  it('the stand-in modules are ready with cues, so the gate below is what keeps them hidden, not `staged`', () => {
    for (const genre of P68) {
      expect(GENRE_MODULES[genre as GenreId].availability('default' as never), genre).toBe('ready');
      expect(GENRE_MODULES[genre as GenreId].cues.length, genre).toBeGreaterThan(0);
    }
  });
});

describe('P68 activation gate: a ready module stays invisible until "wire X" removes it', () => {
  it('every new game not yet wired sits in all three gates; a wired one in none', () => {
    for (const genre of PENDING) expect(ROUTE_PENDING.has(genre), `${genre} ROUTE_PENDING`).toBe(true);
    // T11 pustil `buildshift` jen do rychlé hry; režisér a čtečka čekají na R5 (placený re-record P46E).
    for (const genre of WIRED) expect(ROUTE_PENDING.has(genre as GenreId), `${genre} ROUTE_PENDING`).toBe(false);
    for (const genre of P68) {
      expect(DIRECTOR_PENDING.has(genre), `${genre} DIRECTOR_PENDING`).toBe(true);
      expect(READ_CONTROLS, genre).not.toContain(genre);
    }
  });

  it('the classifier never ranks a new game not yet wired on any P30, P66 or P68 dev sentence', () => {
    const sentences = [...sentencesOf('p30/dev.json'), ...sentencesOf('p66/dev.json'), ...sentencesOf('p68/dev.json')];
    expect(sentences.length).toBeGreaterThanOrEqual(120);
    const leaked = sentences.flatMap((sentence) => classifyGenre(sentence, null).ranked.filter((choice) => (PENDING as readonly string[]).includes(choice.genre)).map((choice) => `${choice.genre}: ${sentence}`));
    expect(leaked).toEqual([]);
  });

  it('the director prompt, its genre lines and its answer schema name no new game not yet wired', () => {
    const lines = genrePromptLines();
    const system = directorSystemPrompt();
    const schema = JSON.stringify(GENRE_ANSWER_SCHEMA);
    for (const genre of P68) {
      expect(mentions(lines, genre), `${genre} in genre lines`).toBe(false);
      expect(mentions(system, genre), `${genre} in director prompt`).toBe(false);
      expect(schema.includes(`"${genre}"`), `${genre} in answer schema`).toBe(false);
    }
  });

  it('the reader prompt names no new game or control not yet wired', () => {
    const prompt = readerSystemPrompt();
    for (const genre of P68) expect(mentions(prompt, genre), genre).toBe(false);
  });
});
