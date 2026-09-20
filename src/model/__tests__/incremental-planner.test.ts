/**
 * **Jedna věta, jeden kus** (P21 T9).
 *
 * Co oko nepokryje: plánovač, který na krátkou větu vrátí dva kusy, nebo
 * který dvacet zaznamenaných vět druhé věty rozřeže na půlky, vypadá v preview
 * úplně stejně jako správný — jen model dostane jinou větu, než jakou porotce
 * napsal. Proto se tu měří nad **zaznamenanými** větami: deset krátkých vět
 * přidání a všech dvacet vět z `evals/worldstream/refine.jsonl`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { planIncrement } from '../incremental-planner';

/** Deset krátkých vět, jak je porotci píšou: každá je jedna věc. */
const SHORT: readonly { sentence: string; kind: 'object' | 'rule' | 'change' }[] = [
  { sentence: 'add a lantern at the far edge', kind: 'object' },
  { sentence: 'Put a small brass bell by the gate.', kind: 'object' },
  { sentence: 'There is a well in the middle of the courtyard.', kind: 'object' },
  { sentence: 'A wooden bench under the tree', kind: 'object' },
  { sentence: 'place another crate next to the first one', kind: 'object' },
  { sentence: 'When the lever is pulled, the gate opens.', kind: 'rule' },
  { sentence: 'the bell should ring every time someone walks past the well', kind: 'rule' },
  { sentence: 'If the lantern is lit the door unlocks', kind: 'rule' },
  { sentence: 'make the well deeper', kind: 'change' },
  { sentence: 'Paint the gate rust red.', kind: 'change' },
];

describe('krátká věta je jeden kus', () => {
  it.each(SHORT)('$sentence → $kind', ({ sentence, kind }) => {
    const read = planIncrement(sentence);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.pieces).toHaveLength(1);
    expect(read.pieces[0].kind).toBe(kind);
  });

  it('zaznamenané věty druhé věty zůstávají celé — smíšený rozsah je jedna změna', () => {
    const prompts = readFileSync('evals/worldstream/refine.jsonl', 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { prompt: string }).prompt);
    expect(prompts).toHaveLength(20);
    for (const prompt of prompts) {
      const read = planIncrement(prompt);
      expect(read.ok, prompt).toBe(true);
      if (read.ok) expect(read.pieces.map((piece) => piece.text), prompt).toEqual([prompt.replace(/[.]+$/, '')]);
    }
  });
});

describe('dlouhá věta je pořadí kusů', () => {
  it('řeže na tečce, na „then" a na „and" před novou věcí, v pořadí věty', () => {
    const read = planIncrement('Add a lantern by the gate. Then put a bell on the well, and when the bell rings the gate opens; and add another bench');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.pieces).toEqual([
      { kind: 'object', text: 'Add a lantern by the gate' },
      { kind: 'object', text: 'put a bell on the well' },
      { kind: 'rule', text: 'when the bell rings the gate opens' },
      { kind: 'object', text: 'add another bench' },
    ]);
  });

  it('„and" uvnitř jedné změny nedělí, „and add" ano', () => {
    const read = planIncrement('make the well deeper and wider and add a rope beside it');
    expect(read.ok && read.pieces.map((piece) => piece.text)).toEqual(['make the well deeper and wider', 'add a rope beside it']);
  });
});

describe('věta bez obsahu', () => {
  it.each(['ok', 'hmm, something nice please', 'add it', 'make it', 'just do the thing again'])('%s → NO_CONTENT', (sentence) => {
    expect(planIncrement(sentence)).toMatchObject({ ok: false, reason: 'NO_CONTENT' });
  });

  // Naměřeno 18. 9. 2026: „well" a „new" sedí v seznamu prázdných slov a „ox" má
  // dvě písmena, takže „add a well" bylo NO_CONTENT — na světě, který je o studni.
  it.each(['add a well', 'there is a well', 'add a new well here', 'add an ox'])('%s je jeden kus — za členem stojí věc', (sentence) => {
    expect(planIncrement(sentence)).toMatchObject({ ok: true, pieces: [{ kind: 'object', text: sentence }] });
  });

  it('člen bez věci za ním obsah nedělá', () => {
    expect(planIncrement('well, add another one')).toMatchObject({ ok: false, reason: 'NO_CONTENT' });
  });

  it('prázdný kus se zahodí, obsahový zůstane', () => {
    const read = planIncrement('ok. add a lantern by the gate. thanks');
    expect(read.ok && read.pieces).toEqual([{ kind: 'object', text: 'add a lantern by the gate' }]);
  });
});
