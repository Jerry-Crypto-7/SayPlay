/**
 * Zaznamenané odpovědi režiséra s logikou (P45B T11): co měření
 * `evals/play/p45b/director-logic.measure.ts` uloží a jak se odpověď soudí –
 * měření i offline test (`logic-fixtures.test.ts`) volají tentýž `judgeLogicAnswer`.
 *
 * Odpověď se čte cestou produktu: `direct()` kompaktního režiséra s větví, která
 * vrátí zaznamenané tělo, bez opravného kola. Prošla, když model logiku napsal,
 * hra je autorská a nese logiku té odpovědi (ne šablonu okamžitého návrhu, která
 * se připojí jen hře bez logiky), zkompiluje se a robot ji ověří včetně `logic_proved`.
 * Cesta produktu nese deterministickou opravu vstupu do fáze (`withPhaseEntries`);
 * `rawPassed` říká, jestli by odpověď prošla i bez ní.
 */

import { arcadeWorldOf } from '../../arcade/compile';
import { logicSchema, modelRulesSchema, withPhaseEntries } from '../../arcade/rules/schema';
import { verifyArcade } from '../../arcade/verify';
import type { GameSpecV1 } from '../../spec';
import { direct } from '..';
import { withoutNulls } from '../read';
import { answered, fakeBranch } from './branch';

export const LOGIC_ANSWERS_DIR = 'src/play/director/__fixtures__/logic-answers';

/** Jeden záznam: surové tělo první odpovědi modelu, nic ručně upraveného. */
export interface LogicAnswerFixture {
  readonly id: string;
  readonly sentence: string;
  readonly axis: string;
  readonly model: string;
  /** `COMPACT_PROMPT_VERSION` – prompt, který režisér v produktu posílá. */
  readonly promptVersion: string;
  /** `DIRECTOR_PROMPT_VERSION` – plný prompt; nese stejné řádky logiky a schéma. */
  readonly directorPromptVersion: string;
  readonly recordedAt: string;
  readonly ms: number;
  readonly answer: unknown;
  /** Proč model neodpověděl (`reason: detail`); `null` = odpověděl. */
  readonly failure: string | null;
}

export interface LogicVerdict {
  readonly id: string;
  /** Prošla cestou produktu, tedy i s opravou vstupu do fáze. */
  readonly passed: boolean;
  /**
   * Prošla by i bez opravy: oprava nic nedoplnila. Kde doplnila, `readGameSpec` by bez ní
   * odpověď odmítl („no rule enters phase“) a logika by vypadla – to je neúspěch.
   */
  readonly rawPassed: boolean;
  /** Fáze, do kterých čtení odpovědi doplnilo vstupní pravidlo. */
  readonly phasesEntered: readonly string[];
  /** Model v odpovědi deklaroval aspoň jednu proměnnou, časovač, fázi nebo událost. */
  readonly wroteLogic: boolean;
  /** První důvod neúspěchu; `null` = prošla. */
  readonly why: string | null;
  readonly fallbackReason: string | null;
}

type Declared = { readonly vars?: readonly { id: string }[] | null; readonly timers?: readonly { id: string }[] | null; readonly phases?: readonly { id: string }[] | null; readonly events?: readonly string[] | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Jména, která blok logiky deklaruje (`druh:jméno`). */
function namesOf(logic: Declared | null | undefined): string[] {
  if (!isRecord(logic)) return [];
  const ids = (kind: string, list: readonly unknown[] | null | undefined) => (Array.isArray(list) ? list.map((entry) => `${kind}:${isRecord(entry) ? String(entry.id) : String(entry)}`) : []);
  return [...ids('var', logic.vars), ...ids('timer', logic.timers), ...ids('phase', logic.phases), ...ids('event', logic.events)];
}

/** Fáze, do kterých oprava čtení doplní vstup – na pravidlech a logice, jak je odpověď napsala. */
function phasesEnteredIn(spec: unknown): string[] {
  const cleaned = withoutNulls(spec);
  const rules = modelRulesSchema.safeParse(isRecord(cleaned) ? cleaned.rules : undefined);
  const logic = logicSchema.safeParse(isRecord(cleaned) ? cleaned.logic : undefined);
  if (!rules.success || !logic.success) return [];
  return withPhaseEntries(rules.data, logic.data)
    .slice(rules.data.length)
    .flatMap((rule) => rule.do.flatMap((effect) => ('goPhase' in effect ? [effect.goPhase] : [])));
}

export async function judgeLogicAnswer(fixture: LogicAnswerFixture): Promise<LogicVerdict> {
  const spec = isRecord(fixture.answer) && isRecord(fixture.answer.spec) ? fixture.answer.spec : fixture.answer;
  const phasesEntered = phasesEnteredIn(spec);
  const verdict = (passed: boolean, wroteLogic: boolean, why: string | null, fallbackReason: string | null = null): LogicVerdict => ({ id: fixture.id, passed, rawPassed: passed && phasesEntered.length === 0, phasesEntered, wroteLogic, why, fallbackReason });
  if (fixture.answer === null) return verdict(false, false, `no answer: ${String(fixture.failure)}`);
  const written = namesOf(isRecord(spec) ? (spec.logic as Declared | null | undefined) : undefined);
  if (written.length === 0) return verdict(false, false, 'the answer declares no logic');

  // První nálezy robota nad hrou, jak ji odpověď složila – před tím, než režisér vadná pravidla vyřadí.
  let firstFailures: readonly string[] | null = null;
  let tick = 0;
  const game = await direct(fixture.sentence, {
    branch: fakeBranch([answered(fixture.answer)]),
    now: () => (tick += 1),
    compact: true,
    maxRepairRounds: 0,
    check: (candidate: GameSpecV1) => {
      if (firstFailures === null) {
        const made = arcadeWorldOf(candidate, 1);
        firstFailures = made.ok ? verifyArcade(made.world, undefined, made.roleBindings).failures : made.issues;
      }
      return [];
    },
  });
  const reason = game.fallbackReason;
  const firstWhy = (fallback: string) => (firstFailures as readonly string[] | null)?.[0] ?? game.failure?.detail ?? fallback;
  if (game.source !== 'authored') return verdict(false, true, `not authored (${String(reason)}): ${firstWhy('no detail')}`, reason);
  const kept = new Set(namesOf(game.spec.logic));
  const lost = written.filter((name) => !kept.has(name));
  if (lost.length > 0) return verdict(false, true, `the game does not keep the answer's logic (${lost.join(', ')}): ${firstWhy(game.failure?.detail ?? 'read without it')}`, reason);
  const made = arcadeWorldOf(game.spec, 1);
  if (!made.ok) return verdict(false, true, `does not compile: ${made.issues.join('; ')}`, reason);
  const checked = verifyArcade(made.world, undefined, made.roleBindings);
  if (checked.failures.length > 0) return verdict(false, true, checked.failures[0]!, reason);
  if (checked.logic.length === 0) return verdict(false, true, 'no logic construct to prove', reason);
  return verdict(true, true, null, reason);
}
