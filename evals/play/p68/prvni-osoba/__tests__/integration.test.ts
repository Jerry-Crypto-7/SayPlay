/**
 * Předávací soubor kategorie `prvni-osoba` pro P68-I (P68-F T7). P68-I čte `integration.md` strojově podle nadpisů
 * šablony `evals/play/p68/integration-template.md` a hru zapne až podle značky `p68-ready` na konci souboru.
 *
 * Pin: předávací soubor, kterému chybí sekce nebo věta, se nevšimne nikdo, dokud P68-I nezapojí hru bez narážek.
 * Značka smí mít jen dva tvary: zástupný ze šablony (hra ještě není hotová) a hotový `railfps`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (name: string): string => readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

/** Nadpisy šablony P68-I v jejím pořadí a na konci poznámka VR. */
const HEADINGS = [
  '## Popis pro režiséra a čtečku',
  '## Věty pro klasifikátor',
  '## Narážky',
  '## Assety',
  '## Požadované změny sdíleného kontraktu',
  '## Fixture spec',
  '## VR',
] as const;
/** Značka ve tvaru šablony: hra ještě není hotová (e2e `play-railfps` chybí). */
const PENDING = '<!-- p68-ready: <id> -->';
/** Značka hotové hry: podle ní P68-I hru zapojí. */
const READY = '<!-- p68-ready: railfps -->';

interface Sentence {
  readonly id: string;
  readonly text: string;
}

const lines = read('integration.md').split(/\r?\n/);
const sentences = (JSON.parse(read('sentences.json')) as { sentences: Sentence[] }).sentences;

/** Řádky tabulky vět v sekci „Věty pro klasifikátor“: id a věta. */
function tableRows(): { readonly id: string; readonly text: string }[] {
  const start = lines.indexOf('## Věty pro klasifikátor');
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end)
    .map((line) => /^\| (s\d{2}) \| ([^|]+?) \|/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ id: match[1] as string, text: match[2] as string }));
}

describe('railfps integration.md for P68-I', () => {
  it('has every template heading in the template order and the VR note last', () => {
    const at = HEADINGS.map((heading) => lines.indexOf(heading));
    expect(HEADINGS.filter((_, k) => (at[k] as number) < 0)).toEqual([]);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(lines.filter((line) => line.startsWith('## ')).at(-1)).toBe('## VR');
  });

  it('ends with exactly one p68-ready marker, in the template form or the finished railfps form', () => {
    const markers = lines.filter((line) => line.includes('p68-ready:'));
    expect(markers).toHaveLength(1);
    expect([PENDING, READY]).toContain(markers[0]);
    expect(lines.filter((line) => line.trim() !== '').at(-1)).toBe(markers[0]);
  });

  it('sentences.json has 20 unique English sentences', () => {
    expect(sentences).toHaveLength(20);
    expect(new Set(sentences.map((entry) => entry.text.trim().toLowerCase())).size).toBe(20);
    for (const entry of sentences) expect(entry.text, entry.id).toMatch(/^[\x20-\x7e]+$/);
  });

  it('the sentence table lists all 20 sentences, each word for word from sentences.json', () => {
    const rows = tableRows();
    const byText = new Map(sentences.map((entry) => [entry.text, entry.id]));
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map((row) => row.id)).size).toBe(20);
    for (const row of rows) expect(byText.get(row.text), `${row.id}: ${row.text}`).toBe(row.id);
  });
});
