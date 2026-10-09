/**
 * Zaznamenané odpovědi lokálního gpt-oss-20b s logikou projdou offline (P45B T11).
 * Fixtury zapisuje jen měření `evals/play/p45b/director-logic.measure.ts`; ručně
 * psaná odpověď by prošla vždy, proto test bere jen soubor s modelem a s hashem
 * dnešního promptu – po změně promptu nebo schématu se musí nahrát znovu.
 * Cíl byl ≥ 20 z 25 odpovědí s logikou, které projdou včetně `logic_proved` cestou
 * produktu (s opravou vstupu do fáze). Nesplněn (README), takže test drží zapsané
 * číslo: soud každé fixtury bez opravy i s ní musí sedět na `director-logic.json`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHASE_ENTRY_TICKS } from '../../arcade/rules/schema';
import { genreAnswer } from '../__fixtures__';
import { LOGIC_ANSWERS_DIR, type LogicAnswerFixture, type LogicVerdict, judgeLogicAnswer } from '../__fixtures__/logic-answers';
import { COMPACT_PROMPT_VERSION } from '../compact';
import { DIRECTOR_PROMPT_VERSION } from '../prompt';

const SENTENCES = (JSON.parse(readFileSync('evals/play/p45b/director-sentences.json', 'utf8')) as { sentences: { id: string; text: string }[] }).sentences;
const fixtures = (): LogicAnswerFixture[] =>
  readdirSync(LOGIC_ANSWERS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(LOGIC_ANSWERS_DIR, file), 'utf8')) as LogicAnswerFixture);

const stub = (answer: unknown): LogicAnswerFixture => ({ id: 'stub', sentence: 'Collect five acorns in a moonlit forest', axis: 'collect', model: 'none', promptVersion: '', directorPromptVersion: '', recordedAt: '', ms: 0, answer, failure: answer === null ? 'UPSTREAM_UNAVAILABLE: scripted' : null });

/**
 * Sběr žaludů s fází `harvest`, na kterou reaguje `cheer`, jak ji píše přísné schéma;
 * `entered` přidá pravidlo, které do ní přepne. Body, ne vlna: doplněný vstup přijde
 * po `PHASE_ENTRY_TICKS` a dřívější vlna strážných by měnila obtížnost, ne čtení.
 */
function harvestAnswer(entered: boolean) {
  const cheer = { id: 'cheer', verb: 'cheer', when: { phase: 'harvest' }, if: null, do: [{ score: 5 }] };
  const ripen = { id: 'ripen', verb: 'ripen', when: { every: PHASE_ENTRY_TICKS }, if: [{ inPhase: 'calm' }], do: [{ goPhase: 'harvest' }] };
  return {
    plan: 'collect acorns until the harvest',
    spec: { ...genreAnswer().spec, ruleRoles: null, things: null, logic: { vars: null, timers: null, events: null, phases: [{ id: 'calm' }, { id: 'harvest' }] }, rules: entered ? [ripen, cheer] : [cheer] },
  };
}

describe('the judge of a recorded logic answer', () => {
  it('fails an answer the model did not give and one that declares no logic', async () => {
    expect(await judgeLogicAnswer(stub(null))).toMatchObject({ passed: false, rawPassed: false, wroteLogic: false, why: 'no answer: UPSTREAM_UNAVAILABLE: scripted' });
    const plain = { plan: 'p', spec: { genre: 'arena', mode: 'collect', hero: 'fox', setting: 'forest', logic: null, rules: null } };
    expect(await judgeLogicAnswer(stub(plain))).toMatchObject({ passed: false, rawPassed: false, wroteLogic: false, why: 'the answer declares no logic' });
  });

  it('reads the answer through the product path: a phase a rule reacts to with no entry passes repaired, not raw', async () => {
    expect(await judgeLogicAnswer(stub(harvestAnswer(true)))).toMatchObject({ passed: true, rawPassed: true, phasesEntered: [], why: null });
    expect(await judgeLogicAnswer(stub(harvestAnswer(false)))).toMatchObject({ passed: true, rawPassed: false, phasesEntered: ['harvest'], why: null });
  }, 120_000);
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

  it('each answer passes raw and repaired exactly as director-logic.json records (target 20/25 missed – README)', async () => {
    type Row = Pick<LogicVerdict, 'id' | 'passed' | 'rawPassed' | 'phasesEntered'>;
    const summary = JSON.parse(readFileSync('evals/play/p45b/director-logic.json', 'utf8')) as { raw: { hit: number }; repaired: { hit: number }; rows: Row[] };
    const verdicts: LogicVerdict[] = [];
    for (const fixture of fixtures()) verdicts.push(await judgeLogicAnswer(fixture));
    for (const verdict of verdicts.filter((each) => !each.passed)) console.log(`${verdict.id}: ${String(verdict.why)}`);
    const rows = (list: readonly Row[]) => list.map(({ id, passed, rawPassed, phasesEntered }) => ({ id, passed, rawPassed, phasesEntered })).sort((a, b) => a.id.localeCompare(b.id));
    expect(rows(verdicts)).toEqual(rows(summary.rows));
    expect(verdicts.filter((verdict) => verdict.passed).length).toBe(summary.repaired.hit);
    expect(verdicts.filter((verdict) => verdict.rawPassed).length).toBe(summary.raw.hit);
  }, 600_000);
});
