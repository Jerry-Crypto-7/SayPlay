/**
 * Žánr Kresli a zachraň (P68-S T13): věta → chráněná postava, hrozba, počet → hra, kterou robot vyhraje kreslením.
 *
 * Pin: „save the puppy from falling rocks“ se štěnětem pod bombami vypadá jako hra a je špatně; robot, který vyhraje
 * bez kreslení, by publikační bránu obešel. Test čte rychlý návrh (`draftFill`) na 10 dev větách
 * (`evals/play/p68/stavba/dev-drawsave.json`), každou přeloží, pustí publikační bránou (`verifyArcade`) s výhrou robota
 * a v záznamu robota počítá body kresby. Ruční spec e2e (`e2e/fixtures/p68-drawsave-spec.json`) = překlad modulu.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../../arcade/compile';
import { BUTTON, type InputEvent } from '../../arcade/contract';
import { hashArcade, instantiate } from '../../arcade/kernel';
import { DRAWSAVE, isBoardCell } from '../../arcade/pieces/drawsave-world';
import { cellOfAxis } from '../../arcade/pieces/lanes';
import { type ArcadeVerdict, verifyArcade } from '../../arcade/verify';
import { compileWith } from '../../compose/compile';
import { type GameSpecV1, readGameSpec } from '../../spec';
import type { GenreModule } from '../contract';
import { drawsaveGenre } from '../drawsave';
import { readGenreSpec } from '../index';
import { DRAWSAVE_STROKE } from '../p68-contract';

const module = drawsaveGenre as unknown as GenreModule;
const DEV = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p68/stavba/dev-drawsave.json'), 'utf8')) as {
  readonly sentences: readonly { readonly id: string; readonly text: string; readonly protected: string; readonly threat: string; readonly threats: number }[];
};
const FIXTURE_PATH = join(process.cwd(), 'e2e/fixtures/p68-drawsave-spec.json');
/** Obsah ruční hry e2e: „draw a line to save the puppy from falling rocks“, výchozích 10 hrozeb. */
const CONTENT = { genre: 'drawsave', mode: 'default', hero: 'puppy', setting: 'meadow', cast: [{ label: 'rock', does: 'avoid' }] } as const;
const HOLD = BUTTON[DRAWSAVE_STROKE.hold];

function specOf(content: object): GameSpecV1 {
  const read = readGenreSpec(content);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(module, read.value);
}

/** Návrh věty doplněný o výchozí postavu a místo, jak by ho doplnil rychlý návrh bez čtečky. */
const draftSpec = (text: string): GameSpecV1 => specOf({ hero: 'puppy', setting: 'meadow', ...module.draftFill(text, null) });

/**
 * Body kresby v záznamu: tik s `HOLD` na buňce desky, která není posledním bodem drženého tahu. Záznam nese jen tiky
 * se vstupem, takže mezera v tikách = prst nahoře (nový tah).
 */
function drawnPoints(inputs: readonly InputEvent[]): number {
  let points = 0;
  let last = -1;
  let lastTick = -2;
  for (const event of inputs) {
    if ((event.buttons & HOLD) === 0 || event.tick !== lastTick + 1) last = -1;
    lastTick = event.tick;
    const cell = cellOfAxis(event.axis);
    if ((event.buttons & HOLD) === 0 || !isBoardCell(cell) || cell === last) continue;
    points += 1;
    last = cell;
  }
  return points;
}

/** Svět a verdikt brány každé dev věty (semínko 7), jednou za soubor. */
const verdicts = new Map<string, { readonly verdict: ArcadeVerdict; readonly threats: number } | { readonly issues: readonly string[] }>();
function verdictOf(sentence: (typeof DEV.sentences)[number]): { readonly verdict: ArcadeVerdict; readonly threats: number } | { readonly issues: readonly string[] } {
  const known = verdicts.get(sentence.id);
  if (known !== undefined) return known;
  const made = arcadeWorldOf(draftSpec(sentence.text), 7);
  const wave = made.ok ? made.world.rules.find((ref) => ref.id === 'drawsave_wave') : undefined;
  const result = made.ok ? { verdict: verifyArcade(made.world, undefined, made.roleBindings), threats: (wave?.params as { ticks?: readonly number[] } | undefined)?.ticks?.length ?? 0 } : { issues: made.issues };
  verdicts.set(sentence.id, result);
  return result;
}

describe('drawsave genre (P68-S T13)', () => {
  it('reads the protected hero, the threat and its count from at least 9 of the 10 dev sentences', () => {
    const misses: string[] = [];
    for (const sentence of DEV.sentences) {
      const draft = module.draftFill(sentence.text, null) as { hero?: string; cast?: { label: string; does: string }[]; params?: Record<string, number> };
      const threat = draft.cast?.find((item) => item.does === 'avoid')?.label;
      const threats = draft.params?.threats ?? DRAWSAVE.threats.default;
      if (draft.hero !== sentence.protected || threat !== sentence.threat || threats !== sentence.threats) {
        misses.push(`${sentence.id}: ${String(draft.hero)}/${String(threat)}/${String(threats)} ≠ ${sentence.protected}/${sentence.threat}/${String(sentence.threats)}`);
      }
    }
    expect(misses.length, misses.join('\n')).toBeLessThanOrEqual(1);
  });

  it('the hand spec of the e2e fixture is the module translation and passes the spec gate', () => {
    const spec = specOf(CONTENT);
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
    // Fixtura je uložená hra `genre.v7`; P70A T3 zvedl jen verzi nových her (férový start).
    expect({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v7' } }).toEqual(fixture);
    expect(readGameSpec(fixture).ok).toBe(true);
    expect(spec.roles.find((role) => role.id === 'player')?.label).toBe('puppy');
    expect(spec.roles.find((role) => role.id === 'threat')).toMatchObject({ kind: 'hazard', label: 'rock', count: DRAWSAVE.threats.default });
    const made = arcadeWorldOf(spec, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    expect(hashArcade(instantiate(made.world))).toBe('e7921f0a');
  });

  it('every dev sentence compiles to a game the bot wins through the publish gate, with the sentence count of threats', () => {
    const failures: string[] = [];
    for (const sentence of DEV.sentences) {
      const run = verdictOf(sentence);
      if ('issues' in run) {
        failures.push(`${sentence.id}: ${run.issues.join('; ')}`);
        continue;
      }
      if (run.verdict.failures.length > 0 || run.verdict.bot.outcome !== 'won') failures.push(`${sentence.id}: ${run.verdict.bot.outcome} ${run.verdict.failures.join('; ')}`);
      if (run.threats !== sentence.threats) failures.push(`${sentence.id}: ${String(run.threats)} threats planned, the sentence says ${String(sentence.threats)}`);
    }
    expect(failures).toEqual([]);
  });

  it('the bot wins by drawing: its recorded input holds at least 2 drawn points in every dev game', () => {
    const points = DEV.sentences.map((sentence) => {
      const run = verdictOf(sentence);
      return { id: sentence.id, points: 'issues' in run ? 0 : drawnPoints(run.verdict.bot.inputs) };
    });
    expect(points.filter((entry) => entry.points < 2)).toEqual([]);
  });
});
