/**
 * Věrnost počítá slovesa pravidel (P29A T9): sloveso, které pokrývá pravidlo,
 * je čtené teprve tehdy, když ho robot během vítězného běhu vystřelil.
 * Pravidlo, které se nestalo, čitelnost nezvedne – číslo by šlo nahoru za nic.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import throwRock from '../arcade/__fixtures__/rules/throw-rock.json';
import { fidelityChain, type ChecklistEntry } from '../fidelity/chain';
import { readGameSpec, type GameSpecV1 } from '../spec';

function spec(input: unknown): GameSpecV1 {
  const read = readGameSpec(input);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return read.value;
}

const THROW: ChecklistEntry = { item: 'throw', slot: 'verb', controls: [] };
const stages = (items: ReturnType<typeof fidelityChain>) => items.map((item) => [item.item, item.inSpec, item.read, item.drawn, item.why]);

describe('fidelity counts rule verbs the robot proved', () => {
  it('a throw rule the robot fired reads and draws the verb', () => {
    expect(stages(fidelityChain(spec(throwRock), [THROW]))).toEqual([['throw', true, true, true, 'ok']]);
  });

  it('a throw rule the robot never fired is in the spec but not read', () => {
    // Hod jen s kamenem v ruce na druhé tlačítko, výhra zvonem na dotek: robot vyhraje, aniž by kdy hodil.
    const idle = spec({
      ...throwRock,
      rules: [
        { id: 'toss', verb: 'throw', when: { every: 5400 }, do: [{ score: 1 }] },
        { id: 'ring', verb: 'ring', when: { contact: ['player', 'bell'] }, do: [{ win: true }] },
      ],
    });
    expect(stages(fidelityChain(idle, [THROW]))).toEqual([['throw', true, false, false, 'not-read-by-control']]);
  });

  it('proofs from the report override the robot run', () => {
    const game = spec(throwRock);
    expect(fidelityChain(game, [THROW], [{ verb: 'throw', fired: false, firstTick: null, changed: false, evidence: null }])[0]?.read).toBe(false);
    expect(fidelityChain(game, [THROW], [{ verb: 'throw', fired: true, firstTick: 40, changed: true, evidence: 'body 3 moved 4.0 m after tick 40' }])[0]?.read).toBe(true);
  });

  it('a rule that fired and changed nothing does not read the verb (P30B R2)', () => {
    // `VERB_NO_EFFECT`: pravidlo vystřelilo, hra zůstala stejná – kontrakt `VerbProof` ho nepočítá jako dokázané.
    const idle = [{ verb: 'throw', fired: true, firstTick: 40, changed: false, evidence: null }] as const;
    expect(stages(fidelityChain(spec(throwRock), [THROW], idle))).toEqual([['throw', true, false, false, 'not-read-by-control']]);
  });

  it('a verb no rule carries stays not in spec', () => {
    expect(fidelityChain(spec(throwRock), [{ item: 'swim', slot: 'verb', controls: [] }])[0]?.why).toBe('not-in-spec');
  });

  it('leaves the frozen judge set untouched', () => {
    const file = fileURLToPath(new URL('../../../evals/play/fidelity/judge-10.json', import.meta.url));
    const sha = createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');
    expect(sha).toBe('fc108201c388715dc989de94eed7b8263dc18c5276ab49baf2b6f7cf11e71990');
  });
});
