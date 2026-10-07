/**
 * Slepý soud knihovny (P43 T11): běží bez dozoru po dny nad sdíleným denním
 * stropem Codexu. Přetečení `--max-calls` nebo dvojí soud téhož listu spálí
 * rozpočet, který patří i P42 a jiným projektům; posunutá buňka dá verdikt
 * cizímu modelu a vypadá v pořádku.
 */

import { describe, expect, it } from 'vitest';

import { judgeSlice, pendingSheets, questionFor, verdictsOf } from '../library-judge.mjs';

const index = {
  size: 3,
  sheets: [
    { sheet: 'grid-001', cells: ['cat', 'cc0-ak', 'cc0-ambulance'] },
    { sheet: 'grid-002', cells: ['washing-machine', 'raptor'] },
    { sheet: 'grid-003', cells: ['apple'] },
  ],
};
const names: Record<string, string[]> = {
  cat: ['Cat', 'cat', 'kitten'],
  'cc0-ak': ['Assault rifle', 'rifle', 'gun'],
  'cc0-ambulance': ['Ambulance', 'ambulance'],
  'washing-machine': ['Washing machine', 'washing-machine'],
  raptor: ['Raptor', 'raptor', 'dinosaur'],
  apple: ['Apple', 'apple'],
};
const namesOf = (id: string) => names[id] ?? [id];
const cell = (n: number, name: string, extra: Partial<{ alternatives: string[]; recognizable: boolean; realSize: number }> = {}) => ({
  cell: n,
  name,
  alternatives: extra.alternatives ?? [],
  recognizable: extra.recognizable ?? true,
  realSize: extra.realSize ?? 1,
});
const answerFor = (sheet: string) =>
  ({
    'grid-001': { cells: [cell(1, 'cat'), cell(2, 'rifle'), cell(3, 'delivery van', { alternatives: ['ambulance'] })] },
    'grid-002': { cells: [cell(1, 'dishwasher', { realSize: 0.85 }), cell(2, 'blob', { recognizable: false })] },
    'grid-003': { cells: [cell(1, 'apple', { realSize: 0.08 })] },
  })[sheet];

function fakeCall() {
  const asked: string[] = [];
  const call = async (sheet: string) => {
    asked.push(sheet);
    return answerFor(sheet) ?? null;
  };
  return { asked, call };
}

describe('questionFor', () => {
  it('asks about exactly the cells on the sheet and never names a model', () => {
    const q = questionFor(3);
    expect(q).toContain('3 numbered cells');
    for (const id of Object.keys(names)) expect(q.toLowerCase()).not.toContain(id.replace('cc0-', ''));
  });
});

describe('verdictsOf', () => {
  it('maps cell numbers to the asset in that cell and checks the name against label and tags', () => {
    const v = verdictsOf(index.sheets[0], answerFor('grid-001'), namesOf);
    expect(v.cat).toMatchObject({ sheet: 'grid-001', cell: 1, recognizable: true, nameFits: true });
    expect(v['cc0-ak']).toMatchObject({ cell: 2, nameFits: true });
    expect(v['cc0-ambulance']).toMatchObject({ cell: 3, nameFits: true, suggestedName: null });
  });

  it('suggests a name only for a recognisable model whose catalog name does not fit', () => {
    const v = verdictsOf(index.sheets[1], answerFor('grid-002'), namesOf);
    expect(v['washing-machine']).toMatchObject({ nameFits: false, suggestedName: 'dishwasher', realSize: 0.85 });
    expect(v.raptor).toMatchObject({ recognizable: false, nameFits: false, suggestedName: null });
  });

  it('rejects an answer whose cells do not match the sheet one to one', () => {
    expect(verdictsOf(index.sheets[0], { cells: [cell(1, 'cat'), cell(2, 'rifle')] }, namesOf)).toBeNull();
    expect(verdictsOf(index.sheets[0], { cells: [cell(1, 'cat'), cell(2, 'rifle'), cell(2, 'van')] }, namesOf)).toBeNull();
    expect(verdictsOf(index.sheets[0], { cells: [cell(1, 'cat'), cell(2, 'rifle'), cell(4, 'van')] }, namesOf)).toBeNull();
  });
});

describe('judgeSlice', () => {
  it('never asks more than maxCalls', async () => {
    const { asked, call } = fakeCall();
    const verdicts = {};
    const run = await judgeSlice({ index, verdicts, maxCalls: 2, call, namesOf });
    expect(asked).toHaveLength(2);
    expect(run.calls).toBe(2);
    expect(Object.keys(verdicts)).toHaveLength(5);
  });

  it('asks nothing with maxCalls 0', async () => {
    const { asked, call } = fakeCall();
    await judgeSlice({ index, verdicts: {}, maxCalls: 0, call, namesOf });
    expect(asked).toHaveLength(0);
  });

  it('skips sheets already judged on a re-run', async () => {
    const verdicts = {};
    await judgeSlice({ index, verdicts, maxCalls: 2, call: fakeCall().call, namesOf });
    const again = fakeCall();
    await judgeSlice({ index, verdicts, maxCalls: 25, call: again.call, namesOf });
    expect(again.asked).toEqual(['grid-003']);
    expect(pendingSheets(index, verdicts)).toEqual([]);
  });

  it('counts a failed call against the budget but leaves the sheet pending', async () => {
    const asked: string[] = [];
    const call = async (sheet: string) => {
      asked.push(sheet);
      return sheet === 'grid-001' ? null : answerFor(sheet)!;
    };
    const verdicts = {};
    const run = await judgeSlice({ index, verdicts, maxCalls: 3, call, namesOf });
    expect(run.calls).toBe(3);
    expect(run.failed).toEqual(['grid-001']);
    expect(pendingSheets(index, verdicts).map((s) => s.sheet)).toEqual(['grid-001']);
  });

  it('saves after every judged sheet so a crash loses at most one answer', async () => {
    let saves = 0;
    await judgeSlice({ index, verdicts: {}, maxCalls: 3, call: fakeCall().call, namesOf, save: () => saves++ });
    expect(saves).toBe(3);
  });
});
