/**
 * Režisér a čtečka znají pět žánrů P66 (T13): schéma je bere, oba prompty je popisují vlastními slovy, příklad na žánr
 * je z dev vět P66, nahrané odpovědi s novým žánrem se přeloží a robot je publikuje, kritik u nich nehlásí nic
 * nečteného. Popis žánru, který model nedostane, vypadá v diffu hotově – proto test na řádek v hotovém promptu.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import dev from '../../../../evals/play/p66/dev.json';
import { canonicalHash } from '../../../ir/worlddoc';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { readsMechanic, unreadItems } from '../../capabilities';
import { draftGameSpecWithMeta } from '../../draft/draft';
import type { GenreSpec } from '../../genre/contract';
import { compileGenre, readGenreSpec } from '../../genre/index';
import { GENRE_MODULES } from '../../genre/modules';
import { MODE_HINTS, readerSystemPrompt } from '../../read/prompt';
import { READY_GENRE_MODES } from '../../read/schema';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../answer-schema';
import { direct } from '../index';
import { GENRE_PITCH, directorSystemPrompt } from '../prompt';
import { DIRECTOR_EXAMPLES, exampleReady, exampleSpec } from '../retrieval';

const NEW = ['survivor', 'hole', 'steal', 'sort', 'arrows'] as const;
const DEV = dev.sentences;
/** Věty živé kontroly (`evals/play/p66/director-live.json`) – příklad režiséra je nesmí prozradit. */
const LIVE = ['v01', 'v02', 'v05', 'v06', 'v09', 'v10', 'v13', 'v14', 'v17', 'v19'];

const FIXTURE_DIR = join(process.cwd(), 'src/play/director/__fixtures__');
interface Fixture {
  readonly sentence: string;
  readonly answer: { readonly plan: string; readonly spec: GenreSpec };
}
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => /^p66-.+\.json$/.test(name))
  .map((name) => [name, JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture] as const);

describe('the spec takes the five P66 genres (T13)', () => {
  it.each(NEW)('%s: { genre, mode: default } and the module bounds read, one past a bound does not', (genre) => {
    const base = { genre, mode: 'default', hero: 'fox', setting: 'forest' };
    expect(readGenreSpec(base).ok).toBe(true);
    const bounds = Object.entries(GENRE_MODULES[genre].paramBounds);
    expect(bounds.length).toBeGreaterThan(0);
    for (const edge of ['min', 'max'] as const) expect(readGenreSpec({ ...base, params: Object.fromEntries(bounds.map(([key, range]) => [key, range[edge]])) }).ok, edge).toBe(true);
    for (const [key, range] of bounds) expect(readGenreSpec({ ...base, params: { [key]: range.max + 1 } }).ok, key).toBe(false);
    const game = readGameSpec(compileGenre(base as GenreSpec));
    expect(game.ok).toBe(true);
    if (game.ok) expect(game.value.genre?.id).toBe(genre);
  });
});

describe('the director and the reader offer the five P66 genres (T13)', () => {
  it('the answer schema, the reader schema and both prompts carry every new genre', () => {
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    const offered = variants.flatMap((variant) => variant.properties.genre?.enum ?? []);
    const director = directorSystemPrompt();
    const reader = readerSystemPrompt();
    for (const genre of NEW) {
      expect(offered, genre).toContain(genre);
      expect(READY_GENRE_MODES.find((entry) => entry.genre === genre)?.modes, genre).toEqual(['default']);
      // Vlastní slova, ne jen narážka modulu: řádek žánru nese větu, co se hraje.
      expect(director, genre).toContain(`- ${genre} (${[...GENRE_MODULES[genre].cues, GENRE_PITCH[genre]!].join(', ')})`);
      expect(MODE_HINTS[`${genre}.default`]?.length ?? 0, genre).toBeGreaterThan(30);
      expect(reader, genre).toContain(`- ${genre}.default: ${MODE_HINTS[`${genre}.default`]!}`);
    }
  });

  it('one director example per new genre, each a P66 dev sentence outside the live check, in a mode that plays', () => {
    for (const genre of NEW) {
      const examples = DIRECTOR_EXAMPLES.filter((example) => exampleSpec(example).genre === genre);
      expect(examples, genre).toHaveLength(1);
      const source = DEV.find((sentence) => sentence.text === examples[0]!.sentence);
      expect(source?.genre, genre).toBe(genre);
      expect(LIVE, genre).not.toContain(source!.id);
      expect(exampleReady(examples[0]!), genre).toBe(true);
    }
  });
});

describe('recorded director answers with a new genre (T13)', () => {
  it('there is one per new genre', () => {
    expect(FIXTURES.map(([, fixture]) => fixture.answer.spec.genre).sort()).toEqual([...NEW].sort());
  });

  it.each(FIXTURES)('%s: authored, compiled and published by the robot', async (_name, fixture) => {
    const game = await direct(fixture.sentence, { branch: fakeBranch([answered(fixture.answer)]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.source).toBe('authored');
    // Sloveso věty bez svědka (`VERB_UNPROVED`, „puts“, „untangle“) hru režiséra neshodí: upgrade odmítá jen akci, kterou
    // rychlá verze dokázala a AI verze ztratila (`lostActions`) – mezery svědků nových žánrů jsou v README P66 (T13).
    expect([null, 'VERB_UNPROVED']).toContain(game.fallbackReason);
    expect(game.spec.genre?.id).toBe(fixture.answer.spec.genre);
    const made = arcadeWorldOf(game.spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(verifyArcade(made.world, undefined, made.roleBindings).publishEligible).toBe(true);
  }, 60_000);
});

describe('capabilities of the five P66 controls (T13)', () => {
  it.each(DEV.map((sentence) => [sentence.id, sentence] as const))('%s: the critic finds nothing the game does not use', (_id, sentence) => {
    const spec = draftGameSpecWithMeta(sentence.text).spec;
    expect(spec.genre?.id).toBe(sentence.genre);
    expect(unreadItems(spec)).toEqual([]);
  });

  // Životy, které tabulka tvrdí, svět opravdu čte: jiný strop zdraví = jiný svět.
  it.each(NEW.filter((genre) => readsMechanic(genre, 'health')))('%s: health is read – the world changes', (genre) => {
    const spec = compileGenre({ genre, mode: 'default', hero: 'fox', setting: 'forest' } as GenreSpec);
    const hash = (next: GameSpecV1): string => {
      const made = arcadeWorldOf(next, 7);
      if (!made.ok) throw new Error(made.issues.join('; '));
      return canonicalHash(made.world);
    };
    const health = { id: 'health', params: { max: 5 } } as GameSpecV1['mechanics'][number];
    expect(hash({ ...spec, mechanics: [...spec.mechanics.filter((m) => m.id !== 'health'), health] })).not.toBe(hash(spec));
  });
});
