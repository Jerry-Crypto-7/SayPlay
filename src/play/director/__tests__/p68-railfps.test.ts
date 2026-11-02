/**
 * P68 R9: režisér a čtečka nabízejí střelnici z očí na kolejích (`railfps`, zapojenou do rychlé hry v T10). Schéma
 * odpovědi ji bere, oba prompty ji popisují vlastními slovy (`evals/play/p68/prvni-osoba/integration.md` → Popis pro
 * režiséra a čtečku), čtečka smí volit i její ovládání, příklad režiséra je z dev věty mimo živou kontrolu a tři odpovědi
 * ve tvaru režiséra se přeloží a robot je publikuje.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import dev from '../../../../evals/play/p68/dev.json';
import { arcadeWorldOf } from '../../arcade/compile';
import { verifyArcade } from '../../arcade/verify';
import type { GenreSpec } from '../../genre/contract';
import { GENRE_MODULES } from '../../genre/modules';
import { railfpsSplit } from '../../genre/railfps';
import { MODE_HINTS, readerSystemPrompt } from '../../read/prompt';
import { READY_GENRE_MODES } from '../../read/schema';
import { READ_CONTROLS, type GameSpecV1 } from '../../spec';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { GENRE_ANSWER_SCHEMA } from '../answer-schema';
import { direct } from '../index';
import { GENRE_PITCH, directorSystemPrompt } from '../prompt';
import { DIRECTOR_EXAMPLES, exampleReady, exampleSpec } from '../retrieval';

const GENRE = 'railfps';
const DEV = dev.sentences.filter((sentence) => sentence.genre === GENRE);
/**
 * Věty živé kontroly (`evals/play/p68/director-railfps.json`) – příklad režiséra je nesmí prozradit. Rychlá hra trefí
 * všech osm dev vět (`route-railfps.json`); d17 říká pohled i koleje, d22 ani jedno („tour jeep … on its own“).
 */
const LIVE = ['d17', 'd22'];

const FIXTURE_DIR = join(process.cwd(), 'src/play/director/__fixtures__');
interface Fixture {
  readonly sentence: string;
  readonly answer: { readonly plan: string; readonly spec: GenreSpec & { readonly params?: Readonly<Record<string, number>> } };
}
const FIXTURES = readdirSync(FIXTURE_DIR)
  .filter((name) => /^p68-railfps-.+\.json$/.test(name))
  .map((name) => [name, JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as Fixture] as const);

/** Odpověď drží, co řekla: nepřítel z obsazení, počty z `targets` a `waves`, boss; svět projde publikační branou. */
function expectKept(spec: GameSpecV1, answer: Fixture['answer']): void {
  expect(spec.genre?.id).toBe(GENRE);
  const { foes, marks } = railfpsSplit(answer.spec.params!.targets!, answer.spec.params!.waves!);
  const enemy = spec.roles.find((role) => role.id === 'enemy');
  expect(enemy?.label).toBe(answer.spec.cast?.[0]?.label);
  expect(enemy?.count).toBe(foes);
  expect(spec.objective.count).toBe(foes + marks);
  if (answer.spec.boss !== undefined) expect(spec.roles.find((role) => role.id === 'boss')?.label).toBe(answer.spec.boss.role);
  const made = arcadeWorldOf(spec, 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  expect(verifyArcade(made.world, undefined, made.roleBindings).publishEligible).toBe(true);
}

describe('the director and the reader offer railfps (P68 R9)', () => {
  it('the answer schema, the reader schema and both prompts carry the game in its own words', () => {
    const variants = (GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: { properties: Record<string, { enum?: unknown[] }> }[] }>).spec.anyOf;
    expect(variants.flatMap((variant) => variant.properties.genre?.enum ?? [])).toContain(GENRE);
    expect(READY_GENRE_MODES.find((entry) => entry.genre === GENRE)?.modes).toEqual(['default']);
    expect(READ_CONTROLS).toContain(GENRE);
    expect(directorSystemPrompt()).toContain(`- ${GENRE} (${[...GENRE_MODULES[GENRE].cues, GENRE_PITCH[GENRE]!].join(', ')})`);
    const reader = readerSystemPrompt();
    expect(reader).toContain(`- ${GENRE}.default: ${MODE_HINTS[`${GENRE}.default`]!}`);
    // Pohled z očí jde před bouchání a střílečku: „clowns popping up along the track“ (d20) nesmí vzít `whack`.
    for (const later of ['whack.default', 'defense.default', 'shooter.default']) expect(reader.indexOf(`- ${GENRE}.default:`), later).toBeLessThan(reader.indexOf(`- ${later}:`));
  });

  it('one director example, a P68 dev sentence of the game outside the live check, and it plays', () => {
    const examples = DIRECTOR_EXAMPLES.filter((example) => exampleSpec(example).genre === GENRE);
    expect(examples).toHaveLength(1);
    const source = DEV.find((sentence) => sentence.text === examples[0]!.sentence);
    expect(source?.genre).toBe(GENRE);
    expect(LIVE).not.toContain(source!.id);
    expect(exampleReady(examples[0]!)).toBe(true);
  });

  it('three recorded answers, none the director example nor a dev sentence', () => {
    expect(FIXTURES).toHaveLength(3);
    const example = DIRECTOR_EXAMPLES.find((entry) => exampleSpec(entry).genre === GENRE)!;
    const devTexts = DEV.map((sentence) => sentence.text);
    for (const [name, fixture] of FIXTURES) {
      expect(fixture.sentence, name).not.toBe(example.sentence);
      expect(devTexts, name).not.toContain(fixture.sentence);
    }
  });

  it.each(FIXTURES)('%s: authored by the director, keeps its foe, counts and boss, published by the robot', async (_name, fixture) => {
    const game = await direct(fixture.sentence, { branch: fakeBranch([answered(fixture.answer)]), now: () => 0, seed: 1, maxRepairRounds: 0 });
    expect(game.source).toBe('authored');
    expect([null, 'VERB_UNPROVED']).toContain(game.fallbackReason);
    expectKept(game.spec, fixture.answer);
  }, 60_000);
});
