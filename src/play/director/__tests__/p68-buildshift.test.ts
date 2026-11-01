/**
 * P68 T11: režisér a čtečka znají směnu se stavbou obchodu (`buildshift`). Schéma odpovědi ji bere, oba prompty ji
 * popisují vlastními slovy (řádky z `evals/play/p68/stavba/integration.md`), čtečka už obchod neposílá na `null`,
 * příklad režiséra je z dev věty mimo živou kontrolu a tři nahrané odpovědi se přeloží a robot je publikuje.
 * Popis, který model nedostane, vypadá v diffu hotově – proto test na řádek v hotovém promptu.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import dev from '../../../../evals/play/p68/dev.json';
import { canonicalHash } from '../../../ir/worlddoc';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import { readsMechanic, unreadItems } from '../../capabilities';
import { draftGameSpecWithMeta } from '../../draft/draft';
import { ROUTE_PENDING } from '../../genre/classify';
import type { GenreSpec } from '../../genre/contract';
import { compileGenre } from '../../genre/index';
import { GENRE_MODULES } from '../../genre/modules';
import { MODE_HINTS, readerSystemPrompt } from '../../read/prompt';
import { READY_GENRE_MODES } from '../../read/schema';
import type { GameSpecV1 } from '../../spec';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA } from '../answer-schema';
import { direct } from '../index';
import { GENRE_PITCH, directorSystemPrompt } from '../prompt';
import { DIRECTOR_EXAMPLES, exampleReady, exampleSpec } from '../retrieval';

const GENRE = 'buildshift';
const DEV = dev.sentences.filter((sentence) => sentence.genre === GENRE);
/** Věty živé kontroly (`evals/play/p68/director-buildshift.json`) – příklad režiséra je nesmí prozradit. */
const LIVE = ['d25', 'd31'];

const FIXTURE_DIR = join(process.cwd(), 'src/play/director/__fixtures__');
interface Fixture {
  readonly sentence: string;
  readonly answer: { readonly plan: string; readonly spec: GenreSpec };
}
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => /^p68-buildshift-.+\.json$/.test(name))
  .map((name) => [name, JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture] as const);

// Režisér a čtečka hru dostanou až s R5 (brána `DIRECTOR_PENDING` / `READER_PENDING`); bloky se pak zapnou samy.
describe.skipIf(DIRECTOR_PENDING.has(GENRE))('the director and the reader offer buildshift (P68 T11)', () => {
  it('the answer schema, the reader schema and both prompts carry the game in its own words', () => {
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).toContain(GENRE);
    expect(READY_GENRE_MODES.find((entry) => entry.genre === GENRE)?.modes).toEqual(['default']);
    expect(directorSystemPrompt()).toContain(`- ${GENRE} (${[...GENRE_MODULES[GENRE].cues, GENRE_PITCH[GENRE]!].join(', ')})`);
    const reader = readerSystemPrompt();
    expect(reader).toContain(`- ${GENRE}.default: ${MODE_HINTS[`${GENRE}.default`]!}`);
    // Řádek obchodu jde před stanoviště: „serve customers in my diner“ nesmí vzít jedno pracoviště.
    expect(reader.indexOf(`- ${GENRE}.default:`)).toBeLessThan(reader.indexOf('- quest.station:'));
  });

  it('the reader sends only a shop over many days to null, not a shift in a shop', () => {
    const reader = readerSystemPrompt();
    expect(reader).not.toMatch(/managing a shop, farm or city/);
    expect(reader).toMatch(/managing a farm or a city, or a shop over many days/);
  });

  it('one director example, a P68 dev sentence of the game outside the live check, in a mode that plays', () => {
    const examples = DIRECTOR_EXAMPLES.filter((example) => exampleSpec(example).genre === GENRE);
    expect(examples).toHaveLength(1);
    const source = DEV.find((sentence) => sentence.text === examples[0]!.sentence);
    expect(source?.genre).toBe(GENRE);
    expect(LIVE).not.toContain(source!.id);
    expect(exampleReady(examples[0]!)).toBe(true);
  });
});

describe.skipIf(DIRECTOR_PENDING.has(GENRE))('recorded director answers with buildshift (P68 T11)', () => {
  it('there are three, none the director example', () => {
    expect(FIXTURES).toHaveLength(3);
    const example = DIRECTOR_EXAMPLES.find((entry) => exampleSpec(entry).genre === GENRE)!;
    for (const [name, fixture] of FIXTURES) expect(fixture.sentence, name).not.toBe(example.sentence);
  });

  it.each(FIXTURES)('%s: authored, compiled and published by the robot, the count of customers kept', async (_name, fixture) => {
    const game = await direct(fixture.sentence, { branch: fakeBranch([answered(fixture.answer)]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.source).toBe('authored');
    expect([null, 'VERB_UNPROVED']).toContain(game.fallbackReason);
    expect(game.spec.genre?.id).toBe(GENRE);
    expect(game.spec.roles.find((role) => role.id === 'customer')?.count).toBe(fixture.answer.spec.params?.customers);
    const made = arcadeWorldOf(game.spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(verifyArcade(made.world, undefined, made.roleBindings).publishEligible).toBe(true);
  }, 60_000);
});

describe('capabilities of the buildshift control (P68 T11)', () => {
  // Za bránou aktivace (T11 vrátil hru po branách hry, 54c90971) rychlá hra buildshift nehraje – vrátí se se zapojením.
  it.skipIf(ROUTE_PENDING.has(GENRE)).each(DEV.map((sentence) => [sentence.id, sentence] as const))('%s: the quick game is buildshift and the critic finds nothing unused', (_id, sentence) => {
    const spec = draftGameSpecWithMeta(sentence.text).spec;
    expect(spec.genre?.id).toBe(GENRE);
    expect(unreadItems(spec)).toEqual([]);
  });

  it('health (walk-outs allowed) is read – another cap is another world', () => {
    expect(readsMechanic(GENRE, 'health')).toBe(true);
    const spec = compileGenre({ genre: GENRE, mode: 'default', hero: 'fox', setting: 'forest' } as GenreSpec);
    const hash = (next: GameSpecV1): string => {
      const made = arcadeWorldOf(next, 7);
      if (!made.ok) throw new Error(made.issues.join('; '));
      return canonicalHash(made.world);
    };
    const health = { id: 'health', params: { max: 6 } } as GameSpecV1['mechanics'][number];
    expect(hash({ ...spec, mechanics: [...spec.mechanics.filter((m) => m.id !== 'health'), health] })).not.toBe(hash(spec));
  });
});
