/**
 * P68 T9: režisér a čtečka znají minigolf (`minigolf`). Schéma odpovědi ho bere, oba prompty ho popisují vlastními
 * slovy (`evals/play/p68/vozidla-sport/integration.md` → Popis), příklad režiséra je z dev věty mimo živou kontrolu
 * a tři odpovědi ve tvaru režiséra se přeloží a robot je publikuje. Nabídka režisérovi a čtečce čeká na R6
 * (placené nové nahrání P46E) – do té doby drží test jen to, že odpovědi jsou hratelné hry.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import dev from '../../../../evals/play/p68/dev.json';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
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

const GENRE = 'minigolf';
const DEV = dev.sentences.filter((sentence) => sentence.genre === GENRE);
/** Věty živé kontroly (`evals/play/p68/director-minigolf.json`) – příklad režiséra je nesmí prozradit. */
const LIVE = ['d09', 'd12'];

const FIXTURE_DIR = join(process.cwd(), 'src/play/director/__fixtures__');
interface Fixture {
  readonly sentence: string;
  readonly answer: { readonly plan: string; readonly spec: GenreSpec & { readonly params?: Readonly<Record<string, number>> } };
}
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => /^p68-minigolf-.+\.json$/.test(name))
  .map((name) => [name, JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture] as const);

/** Odpověď drží, co řekla: počet odrazníků z `obstacles` a pohyblivou překážku z `patrol`; svět projde publikační branou. */
function expectKept(spec: GameSpecV1, answer: Fixture['answer']): void {
  expect(spec.genre?.id).toBe(GENRE);
  const obstacles = answer.spec.params?.obstacles;
  if (obstacles !== undefined) expect(spec.roles.find((role) => role.id === 'bumper')?.count).toBe(obstacles);
  const patrols = (answer.spec.cast ?? []).some((item) => (item as { patrol?: boolean }).patrol === true);
  expect(spec.roles.some((role) => role.id === 'mover')).toBe(patrols);
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  expect(verifyArcade(made.world, undefined, made.roleBindings).publishEligible).toBe(true);
}

describe('director answers with minigolf are playable games (P68 T9)', () => {
  it('there are three, none the director example nor a live-check sentence', () => {
    expect(FIXTURES).toHaveLength(3);
    const example = DIRECTOR_EXAMPLES.find((entry) => exampleSpec(entry).genre === GENRE)!;
    const live = DEV.filter((sentence) => LIVE.includes(sentence.id)).map((sentence) => sentence.text);
    for (const [name, fixture] of FIXTURES) {
      expect(fixture.sentence, name).not.toBe(example.sentence);
      expect(live, name).not.toContain(fixture.sentence);
    }
  });

  it.each(FIXTURES)('%s: compiles, keeps its bumpers and mover, passes the publish gate', (_name, fixture) => {
    expectKept(compileGenre(fixture.answer.spec), fixture.answer);
  }, 60_000);

  it('one director example, a P68 dev sentence of the game outside the live check', () => {
    const examples = DIRECTOR_EXAMPLES.filter((example) => exampleSpec(example).genre === GENRE);
    expect(examples).toHaveLength(1);
    const source = DEV.find((sentence) => sentence.text === examples[0]!.sentence);
    expect(source?.genre).toBe(GENRE);
    expect(LIVE).not.toContain(source!.id);
  });
});

// Režisér a čtečka hru dostanou až s R6 (brána `DIRECTOR_PENDING` / `READER_PENDING`); bloky se pak zapnou samy.
describe.skipIf(DIRECTOR_PENDING.has(GENRE))('the director and the reader offer minigolf (P68 T9)', () => {
  it('the answer schema, the reader schema and both prompts carry the game in its own words', () => {
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).toContain(GENRE);
    expect(READY_GENRE_MODES.find((entry) => entry.genre === GENRE)?.modes).toEqual(['default']);
    expect(directorSystemPrompt()).toContain(`- ${GENRE} (${[...GENRE_MODULES[GENRE].cues, GENRE_PITCH[GENRE]!].join(', ')})`);
    const reader = readerSystemPrompt();
    expect(reader).toContain(`- ${GENRE}.default: ${MODE_HINTS[`${GENRE}.default`]!}`);
    // Golf jde před hod: „sink the ball“ u jamky nesmí vzít koš.
    expect(reader.indexOf(`- ${GENRE}.default:`)).toBeLessThan(reader.indexOf('- throw.default:'));
  });

  it('the director example plays', () => {
    const example = DIRECTOR_EXAMPLES.find((entry) => exampleSpec(entry).genre === GENRE)!;
    expect(exampleReady(example)).toBe(true);
  });

  it.each(FIXTURES)('%s: authored by the director, compiled and published by the robot', async (_name, fixture) => {
    const game = await direct(fixture.sentence, { branch: fakeBranch([answered(fixture.answer)]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.source).toBe('authored');
    expect([null, 'VERB_UNPROVED']).toContain(game.fallbackReason);
    expectKept(game.spec, fixture.answer);
  }, 60_000);
});
