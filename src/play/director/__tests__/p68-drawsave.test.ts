/**
 * P68 R7: režisér a čtečka nabízejí Kresli a zachraň (`drawsave`, zapojený do rychlé hry v T12). Schéma odpovědi ho
 * bere, oba prompty ho popisují vlastními slovy (`evals/play/p68/stavba/integration.md` → Pitch (drawsave)), příklad
 * režiséra je z dev věty mimo živou kontrolu a tři odpovědi ve tvaru režiséra se přeloží a robot je publikuje.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import dev from '../../../../evals/play/p68/dev.json';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import type { GenreSpec } from '../../genre/contract';
import { GENRE_MODULES } from '../../genre/modules';
import { MODE_HINTS, readerSystemPrompt } from '../../read/prompt';
import { READY_GENRE_MODES } from '../../read/schema';
import type { GameSpecV1 } from '../../spec';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../answer-schema';
import { direct } from '../index';
import { GENRE_PITCH, directorSystemPrompt } from '../prompt';
import { DIRECTOR_EXAMPLES, exampleReady, exampleSpec } from '../retrieval';

const GENRE = 'drawsave';
const DEV = dev.sentences.filter((sentence) => sentence.genre === GENRE);
/**
 * Věty živé kontroly (`evals/play/p68/director-drawsave.json`) – příklad režiséra je nesmí prozradit. d36 rychlá hra
 * pošle na závod (`route-drawsave.json`), takže ukáže, jestli čtení hru najde; d38 rychlá hra trefí.
 */
const LIVE = ['d36', 'd38'];

const FIXTURE_DIR = join(process.cwd(), 'src/play/director/__fixtures__');
interface Fixture {
  readonly sentence: string;
  readonly answer: { readonly plan: string; readonly spec: GenreSpec & { readonly params?: Readonly<Record<string, number>> } };
}
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => /^p68-drawsave-.+\.json$/.test(name))
  .map((name) => [name, JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture] as const);

/** Odpověď drží, co řekla: hrozba z obsazení a jejich počet z `threats`; svět projde publikační branou. */
function expectKept(spec: GameSpecV1, answer: Fixture['answer']): void {
  expect(spec.genre?.id).toBe(GENRE);
  const threat = spec.roles.find((role) => role.id === 'threat');
  expect(threat?.count).toBe(answer.spec.params?.threats);
  expect(threat?.label).toBe(answer.spec.cast?.[0]?.label);
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  expect(verifyArcade(made.world, undefined, made.roleBindings).publishEligible).toBe(true);
}

describe('the director and the reader offer drawsave (P68 R7)', () => {
  it('the answer schema, the reader schema and both prompts carry the game in its own words', () => {
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).toContain(GENRE);
    expect(READY_GENRE_MODES.find((entry) => entry.genre === GENRE)?.modes).toEqual(['default']);
    expect(directorSystemPrompt()).toContain(`- ${GENRE} (${[...GENRE_MODULES[GENRE].cues, GENRE_PITCH[GENRE]!].join(', ')})`);
    const reader = readerSystemPrompt();
    expect(reader).toContain(`- ${GENRE}.default: ${MODE_HINTS[`${GENRE}.default`]!}`);
    // Kresba jde před chytání: „things fall“ z řádku hry nesmí přetáhnout věty, kde hráč padající věci chytá.
    expect(reader.indexOf(`- ${GENRE}.default:`)).toBeLessThan(reader.indexOf('- catch.default:'));
  });

  it('one director example, a P68 dev sentence of the game outside the live check, and it plays', () => {
    const examples = DIRECTOR_EXAMPLES.filter((example) => exampleSpec(example).genre === GENRE);
    expect(examples).toHaveLength(1);
    const source = DEV.find((sentence) => sentence.text === examples[0]!.sentence);
    expect(source?.genre).toBe(GENRE);
    expect(LIVE).not.toContain(source!.id);
    expect(exampleReady(examples[0]!)).toBe(true);
  });

  it('three recorded answers, none the director example nor a live-check sentence', () => {
    expect(FIXTURES).toHaveLength(3);
    const example = DIRECTOR_EXAMPLES.find((entry) => exampleSpec(entry).genre === GENRE)!;
    const live = DEV.filter((sentence) => LIVE.includes(sentence.id)).map((sentence) => sentence.text);
    for (const [name, fixture] of FIXTURES) {
      expect(fixture.sentence, name).not.toBe(example.sentence);
      expect(live, name).not.toContain(fixture.sentence);
    }
  });

  it.each(FIXTURES)('%s: authored by the director, keeps its threat and count, published by the robot', async (_name, fixture) => {
    const game = await direct(fixture.sentence, { branch: fakeBranch([answered(fixture.answer)]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.source).toBe('authored');
    expect([null, 'VERB_UNPROVED']).toContain(game.fallbackReason);
    expectKept(game.spec, fixture.answer);
  }, 60_000);
});
