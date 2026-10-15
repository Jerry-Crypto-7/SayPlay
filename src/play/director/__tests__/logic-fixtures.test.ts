/**
 * Zaznamenané odpovědi lokálního gpt-oss-20b s logikou projdou offline (P45B T11).
 * Fixtury zapisuje jen měření `evals/play/p45b/director-logic.measure.ts`; ručně
 * psaná odpověď by prošla vždy, proto test bere jen soubor s modelem a s hashem
 * dnešního promptu – po změně promptu nebo schématu se musí nahrát znovu.
 * Cíl byl ≥ 20 z 25 odpovědí s logikou, které projdou včetně `logic_proved` cestou
 * produktu (s opravou vstupu do fáze). Nesplněn ani po novém příkladu T12a (1/25,
 * README), takže test drží zapsané číslo: soud každé fixtury bez opravy i s ní musí
 * sedět na `director-logic.json`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../../arcade/compile';
import { PHASE_ENTRY_TICKS } from '../../arcade/rules/schema';
import { verifyArcade } from '../../arcade/verify';
import { assemblyOfCell, liveCells } from '../../compose/allowed';
import { compileRecipe } from '../../compose/compile';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { direct } from '..';
import { genreAnswer } from '../__fixtures__';
import { answered, fakeBranch } from '../__fixtures__/branch';
import { LOGIC_ANSWERS_DIR, type LogicAnswerFixture, type LogicVerdict, judgeLogicAnswer } from '../__fixtures__/logic-answers';
import { COMPACT_PROMPT_VERSION } from '../compact';
import { DIRECTOR_PROMPT_VERSION } from '../prompt';
import { readGenreAnswer, readModelSpec, readRecipeAnswer, readRecipeContent } from '../read';

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

/** Tatáž odpověď bez vstupu do `harvest`, ale receptem (`recipe` místo `genre`) – druhá větev `readComposedAnswer`. */
function harvestRecipe() {
  const cell = liveCells().find((each) => each.id === 'arena.collect')!;
  const { logic, rules } = harvestAnswer(false).spec;
  return { cell, body: { plan: 'collect acorns until the harvest', spec: { recipe: cell.recipe, hero: 'fox', setting: 'moonlit forest', cast: [{ label: 'acorn', does: 'collect' }], unmet: [], logic, rules } } };
}

/** Pravidla každé hry, kterou `direct()` dá ověřit (`check`) – co z odpovědi produkt opravdu hraje. */
async function checkedRuleIds(sentence: string, answer: unknown): Promise<string[][]> {
  const checked: string[][] = [];
  let tick = 0;
  await direct(sentence, {
    branch: fakeBranch([answered(answer)]),
    now: () => (tick += 1),
    compact: true,
    maxRepairRounds: 0,
    check: (candidate: GameSpecV1) => {
      checked.push((candidate.rules ?? []).map((rule) => rule.id));
      return [];
    },
  });
  return checked;
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

describe('the phase-entry repair of the read path', () => {
  it('adds no entry the world cannot take: with every free rule slot used, the spec reads as the model wrote it', () => {
    const read = readGenreAnswer(harvestAnswer(true));
    if (!read.ok) throw new Error(read.detail);
    const [ripen, cheer] = read.spec.rules!;
    const pads = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `pad${String(i)}`, verb: 'cheer', when: { every: 600 }, do: [{ score: 1 }] }));
    // Kolik pravidel specu svět této arény unese vedle vestavěných – pod stropem specu 16, jinak by test zkoušel ten.
    const fits = (count: number) => arcadeWorldOf({ ...read.spec, rules: [ripen!, cheer!, ...pads(count - 2)] }, 1).ok;
    let most = 2;
    while (most < 16 && fits(most + 1)) most += 1;
    expect(most).toBeLessThan(16);
    const roomy = readModelSpec({ ...read.spec, rules: [cheer!, ...pads(most - 2)] });
    expect(roomy.ok ? roomy.spec.rules?.map((rule) => rule.id).at(-1) : roomy.detail).toBe('enter_harvest');
    const full = readModelSpec({ ...read.spec, rules: [cheer!, ...pads(most - 1)] });
    expect(full.ok ? full.spec.rules?.map((rule) => rule.id) : full.detail).toContain('no rule enters phase harvest');
  });

  it('fills the entry on the recipe path: readRecipeAnswer → compileRecipe → readModelSpec, and the robot sees the phase change', () => {
    const { cell, body } = harvestRecipe();
    const read = readRecipeAnswer(body);
    if (!read.ok) throw new Error(read.detail);
    const { recipe, unmet: _unmet, ...content } = read.value;
    const checked = readRecipeContent(cell, content);
    if (!checked.ok) throw new Error(checked.issues.join('; '));
    const compiled = compileRecipe({ ...assemblyOfCell(cell, checked.value), ...recipe });
    const raw = readGameSpec(compiled);
    expect(raw.ok ? 'read as written' : raw.issues.join('; ')).toContain('no rule enters phase harvest');
    const game = readModelSpec(compiled);
    if (!game.ok) throw new Error(game.detail);
    expect(game.spec.rules?.map((rule) => rule.id)).toEqual(['cheer', 'enter_harvest']);
    const made = arcadeWorldOf(game.spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(verifyArcade(made.world, undefined, made.roleBindings).logic.find((proof) => proof.id === 'harvest')).toMatchObject({ kind: 'phase', fired: true, changed: true });
  });

  it('a recipe answer with the dead phase passes through direct() repaired, not raw', async () => {
    expect(await judgeLogicAnswer(stub(harvestRecipe().body))).toMatchObject({ passed: true, rawPassed: false, phasesEntered: ['harvest'], why: null });
  }, 120_000);

  it('the entry reaches the game direct() checks for a recorded answer, once its world can be built', async () => {
    const j08 = fixtures().find((fixture) => fixture.id === 'j08')!;
    // Jak ho model napsal, svět souboje v Aréně vlnu od okraje odmítne, takže čtení vezme odpověď bez
    // vstupu a pravidla vypadnou; zbylé 3 záznamy s doplněnou fází mají navíc nespuštěný časovač.
    // Jediná změna (vlna u hráče) ukáže, že oprava skutečnou odpověď modelu doplní cestou produktu.
    const playable = JSON.parse(JSON.stringify(j08.answer).split('"at":"edge"').join('"at":"player"')) as unknown;
    expect((await judgeLogicAnswer(j08)).phasesEntered).toEqual(['second']);
    const [first] = await checkedRuleIds(j08.sentence, playable);
    expect(first).toEqual(['start_wave', 'spawn_skeleton', 'reset_wave', 'enter_second']);
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
    // Řádky nejsou všechny prázdné: rozbité čtení logiky shodí s008, rozbitá oprava vstupu fáze těchto čtyř.
    expect(verdicts.some((verdict) => verdict.passed)).toBe(true);
    // Demo 12. 10.: vstup dostane i fáze, kterou nikdo nečte, takže oprava sáhne na většinu odpovědí.
    expect(verdicts.filter((verdict) => verdict.phasesEntered.length > 0).map((verdict) => verdict.id)).toEqual(expect.arrayContaining(['h09', 'j08', 's003', 's188']));
    // T12a záznam 5: číslo pevně – nový záznam, který ho pohne, musí přepsat i README. Demo 12. 10.: 1/1 → 2/3.
    // P46D/H 15. 10.: delší a těžší trať, robot s008 prohraje v 557. metru → 1/2 (rozhodnutí majitele: přijmout).
    expect([summary.raw.hit, summary.repaired.hit]).toEqual([1, 2]);
  }, 600_000);
});
