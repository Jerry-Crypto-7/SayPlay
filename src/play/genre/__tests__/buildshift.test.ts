/**
 * Žánr Směna se stavbou obchodu (P68-S T4): věta → zákazník, zboží, cíl → hra, kterou robot vyhraje.
 *
 * Pin: „cats want milk“ s pizzou místo mléka vypadá jako hra a je špatně. Test čte rychlý návrh (`draftFill`) na 20 dev
 * větách (`evals/play/p68/stavba/dev.json`), každou přeloží a pustí publikační bránou (`verifyArcade`) s výhrou robota.
 * Ruční spec e2e (`e2e/fixtures/p68-buildshift-spec.json`) = překlad modulu; jeho svět má pevný otisk.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../../arcade/compile';
import { hashArcade, instantiate } from '../../arcade/kernel';
import { BUILDSHIFT } from '../../arcade/pieces/buildshift-world';
import { verifyArcade } from '../../arcade/verify';
import { compileWith } from '../../compose/compile';
import { buildshiftGenre } from '../buildshift';
import type { GenreModule } from '../contract';
import { readGenreSpec } from '../index';
import type { GameSpecV1 } from '../../spec';

const module = buildshiftGenre as unknown as GenreModule;
const DEV = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p68/stavba/dev.json'), 'utf8')) as {
  readonly sentences: readonly { readonly id: string; readonly text: string; readonly customer: string; readonly goods: string; readonly goal: number }[];
};
const FIXTURE_PATH = join(process.cwd(), 'e2e/fixtures/p68-buildshift-spec.json');
/** Obsah ruční hry e2e: roboti chtějí pizzu v malém bistru, cíl 10. */
const CONTENT = { genre: 'buildshift', mode: 'default', hero: 'chef', setting: 'tiny diner', cast: [{ label: 'robot', does: 'collect' }, { label: 'pizza', does: 'scenery' }], params: { customers: 10 } } as const;

function specOf(content: object): GameSpecV1 {
  const read = readGenreSpec(content);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(module, read.value);
}

/** Návrh věty doplněný o výchozího hrdinu a místo, jak by ho doplnil rychlý návrh bez čtečky. */
function draftSpec(text: string): GameSpecV1 {
  return specOf({ hero: 'chef', setting: 'shop', ...module.draftFill(text, null) });
}

describe('buildshift genre (P68-S T4)', () => {
  it('reads customer, goods and goal from at least 18 of the 20 dev sentences', () => {
    const misses: string[] = [];
    for (const sentence of DEV.sentences) {
      const draft = module.draftFill(sentence.text, null) as { cast?: { label: string; does: string }[]; params?: Record<string, number> };
      const customer = draft.cast?.find((item) => item.does === 'collect')?.label;
      const goods = draft.cast?.find((item) => item.does === 'scenery')?.label;
      const goal = draft.params?.customers ?? BUILDSHIFT.goal.default;
      if (customer !== sentence.customer || goods !== sentence.goods || goal !== sentence.goal) {
        misses.push(`${sentence.id}: ${String(customer)}/${String(goods)}/${String(goal)} ≠ ${sentence.customer}/${sentence.goods}/${String(sentence.goal)}`);
      }
    }
    expect(misses.length, misses.join('\n')).toBeLessThanOrEqual(2);
  });

  it('a number that counts the shift or the time is not the count of customers (P68-K T2)', () => {
    const goalOf = (text: string): number | undefined => (module.draftFill(text, null) as { params?: { customers?: number } }).params?.customers;
    // Dev P68 d25: „one“ patří směně → bez čísla u zákazníků výchozí cíl 12.
    expect(goalOf('run a burger shop for one shift: place grills and counters on the grid, spend coins and serve every customer before closing time')).toBeUndefined();
    expect(goalOf('run a diner for two hours and serve 10 robots their soup')).toBe(10);
    expect(goalOf('serve 15 customers')).toBe(15);
    expect(goalOf('serve 6 cats their milk')).toBe(9);
  });

  it('the hand spec of the e2e fixture is the module translation', () => {
    const spec = specOf(CONTENT);
    if (process.env.BUILDSHIFT_WRITE_FIXTURE === '1' || !existsSync(FIXTURE_PATH)) writeFileSync(FIXTURE_PATH, `${JSON.stringify(spec, null, 2)}\n`);
    // Fixtura je uložená hra `genre.v7`; P70A T3 zvedl jen verzi nových her (férový start).
    expect({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v7' } }).toEqual(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));
    expect(spec.objective.count).toBe(10);
    expect(spec.roles.find((role) => role.id === 'customer')?.label).toBe('robot');
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(hashArcade(instantiate(made.world))).toBe('ad6da927');
  });

  it('every dev sentence compiles to a game the bot wins through the publish gate', () => {
    const failures: string[] = [];
    for (const sentence of DEV.sentences) {
      const spec = draftSpec(sentence.text);
      const made = arcadeWorldOf(spec, 7);
      if (!made.ok) {
        failures.push(`${sentence.id}: ${made.issues.join('; ')}`);
        continue;
      }
      const verdict = verifyArcade(made.world, undefined, made.roleBindings);
      if (verdict.failures.length > 0 || verdict.bot.outcome !== 'won') failures.push(`${sentence.id}: ${verdict.bot.outcome} ${verdict.failures.join('; ')}`);
    }
    expect(failures).toEqual([]);
  });
});
