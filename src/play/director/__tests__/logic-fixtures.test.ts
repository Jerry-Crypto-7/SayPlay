/**
 * Zaznamenané odpovědi lokálního gpt-oss-20b s logikou projdou offline (P45B T11).
 * Fixtury zapisuje jen měření `evals/play/p45b/director-logic.measure.ts`; ručně
 * psaná odpověď by prošla vždy, proto test bere jen soubor s modelem a s hashem
 * dnešního promptu – po změně promptu nebo schématu se musí nahrát znovu.
 * Cíl: ≥ 20 z 25 odpovědí logiku napíše a projde včetně `logic_proved`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOGIC_ANSWERS_DIR, type LogicAnswerFixture, judgeLogicAnswer } from '../__fixtures__/logic-answers';
import { COMPACT_PROMPT_VERSION } from '../compact';
import { DIRECTOR_PROMPT_VERSION } from '../prompt';

const SENTENCES = (JSON.parse(readFileSync('evals/play/p45b/director-sentences.json', 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
const fixtures = (): LogicAnswerFixture[] =>
  readdirSync(LOGIC_ANSWERS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(LOGIC_ANSWERS_DIR, file), 'utf8')) as LogicAnswerFixture);

const stub = (answer: unknown): LogicAnswerFixture => ({ id: 'stub', sentence: 'Collect five acorns in a moonlit forest', axis: 'collect', model: 'none', promptVersion: '', directorPromptVersion: '', recordedAt: '', ms: 0, answer, failure: answer === null ? 'UPSTREAM_UNAVAILABLE: scripted' : null });

describe('the judge of a recorded logic answer', () => {
  it('fails an answer the model did not give and one that declares no logic', async () => {
    expect(await judgeLogicAnswer(stub(null))).toMatchObject({ passed: false, wroteLogic: false, why: 'no answer: UPSTREAM_UNAVAILABLE: scripted' });
    const plain = { plan: 'p', spec: { genre: 'arena', mode: 'collect', hero: 'fox', setting: 'forest', logic: null, rules: null } };
    expect(await judgeLogicAnswer(stub(plain))).toMatchObject({ passed: false, wroteLogic: false, why: 'the answer declares no logic' });
  });
});

describe('recorded gpt-oss-20b logic answers', () => {
  it('one fixture per chosen sentence, each written by the measurement with today\'s prompt', () => {
    const recorded = fixtures();
    expect(recorded.map((fixture) => fixture.id).sort()).toEqual(SENTENCES.map((sentence) => sentence.id).sort());
    for (const fixture of recorded) {
      expect(fixture.sentence, fixture.id).toBe(SENTENCES.find((sentence) => sentence.id === fixture.id)?.text);
      expect(fixture.model, fixture.id).toBe('gpt-oss-20b');
      expect(fixture.promptVersion, `${fixture.id}: recorded with another compact prompt – re-record`).toBe(COMPACT_PROMPT_VERSION);
      expect(fixture.directorPromptVersion, `${fixture.id}: recorded with another director prompt – re-record`).toBe(DIRECTOR_PROMPT_VERSION);
    }
  });

  it('at least 20 of 25 write logic and pass with logic_proved', async () => {
    const verdicts = [];
    for (const fixture of fixtures()) verdicts.push(await judgeLogicAnswer(fixture));
    const failed = verdicts.filter((verdict) => !verdict.passed);
    for (const verdict of failed) console.log(`${verdict.id}: ${String(verdict.why)}`);
    expect(verdicts.filter((verdict) => verdict.passed).length, failed.map((verdict) => `${verdict.id}: ${String(verdict.why)}`).join('\n')).toBeGreaterThanOrEqual(20);
  }, 600_000);
});
