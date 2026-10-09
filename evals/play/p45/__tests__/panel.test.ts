/**
 * Vývojový panel P45 (T1): 40 vět zmrazených nad `main` 0714a352 dřív, než se
 * P45 čehokoli dotkl. Test drží výběr pevně – věta dobraná po první změně hry
 * by zkreslila každé další číslo měřidla zábavy.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkCorpus, normalizeSentence } from '../../../../scripts/play-fidelity.mjs';

const PLAY = join(process.cwd(), 'evals', 'play');
const readLf = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const json = (path: string) => JSON.parse(readLf(join(PLAY, path)));

interface PanelSentence { id: string; text: string; from: string; genre: string; enemy: boolean; [key: string]: unknown }
const PANEL: { about: string; sentences: PanelSentence[] } = json('p45/panel.json');

/** Výběr zmrazený 8. 10. 2026; změna = nový panel, ne tichá úprava. */
const PANEL_IDS = [
  'f01', 'f02', 'f03', 'f05', 'f10', 'f12', 'f17', 'f18', 'm01', 'm02', 'm03', 'm04', 'm06', 'm07', 'm08', 'm09', 'm11', 'm16', 'n01', 'n02',
  'n04', 'u01', 'u02', 'u03', 'u06', 'd01', 'd03', 'd04', 'd09', 'h02', 'h03', 'h05', 'j01', 'j04', 'j05', 'j08', 's002', 's003', 's021', 's035',
];

const SOURCES = { 'p37a/dev-150.json': 25, 'p30/dev.json': 15 } as const;

/** Sady, ze kterých se na panelu ladit nesmí: testovací a všechny pečeti. */
function sealedSentences(): Set<string> {
  const texts = (path: string) => (json(path).sentences as { text: string }[]).map((s) => s.text);
  const p44c = Object.values(json('p44c/sealed-110.json').groups as Record<string, { sentence: string }[]>).flat().map((s) => s.sentence);
  return new Set([...texts('p30/test-200.json'), ...texts('p43/sealed-100.json'), ...texts('p44e/sealed-200.json'), ...p44c].map(normalizeSentence));
}

describe('P45 dev panel', () => {
  it('is a valid corpus of 40 sentences', () => {
    expect(checkCorpus(PANEL)).toEqual([]);
    expect(PANEL.sentences).toHaveLength(40);
  });

  it('takes 25 sentences from p37a dev-150 and 15 from p30 dev, each unchanged', () => {
    for (const [from, count] of Object.entries(SOURCES)) {
      const picked = PANEL.sentences.filter((s) => s.from === from);
      expect(picked, from).toHaveLength(count);
      const original = new Map((json(from).sentences as { id: string }[]).map((s) => [s.id, s]));
      for (const { from: _from, genre: _genre, enemy: _enemy, ...sentence } of picked) expect(sentence, sentence.id).toEqual(original.get(sentence.id));
    }
    expect(PANEL.sentences.every((s) => s.from in SOURCES)).toBe(true);
  });

  it('shares no sentence with the test set or any seal', () => {
    const sealed = sealedSentences();
    expect(PANEL.sentences.filter((s) => sealed.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    // Kontrola sama musí kolizi poznat: věta z test-200 se přepisem velikosti a interpunkce neschová.
    const leaked = json('p30/test-200.json').sentences[0].text as string;
    expect(sealed.has(normalizeSentence(`${leaked.toUpperCase()}!`))).toBe(true);
  });

  it('covers at least six draft genres and five sentences with an enemy', () => {
    expect(new Set(PANEL.sentences.map((s) => s.genre)).size).toBeGreaterThanOrEqual(6);
    expect(PANEL.sentences.filter((s) => s.enemy).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps the frozen selection, recorded in the README with its main commit', () => {
    expect(PANEL.sentences.map((s) => s.id)).toEqual(PANEL_IDS);
    const readme = readLf(join(PLAY, 'p45', 'README.md'));
    expect(readme).toContain('0714a352');
    for (const id of PANEL_IDS) expect(readme, id).toContain(`\`${id}\``);
  });
});
