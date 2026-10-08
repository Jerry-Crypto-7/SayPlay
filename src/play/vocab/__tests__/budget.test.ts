/**
 * Rozpočty P44C (T12). Tabulka v klientském balíku nebo pomalé vyhledání hru nerozbije, jen ji
 * zpomalí na telefonu – a nikdo by si toho nevšiml. Balík nad buildem hlídá `scripts/vocab/check-bundle.mjs`.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { vocabVerb } from '../lookup';

const read = (path: string): string => readFileSync(path, 'utf8');
const texts = (path: string): string[] => (JSON.parse(read(path)) as { sentences: { text: string }[] }).sentences.map((sentence) => sentence.text);
const round5 = JSON.parse(read('evals/play/p42/round5/sentences.json')) as { groups: Record<string, { sentence: string }[]> };
const open = [...texts('evals/play/p37a/dev-150.json'), ...texts('evals/play/p30/dev.json'), ...Object.values(round5.groups).flat().map((label) => label.sentence)];
const sentences = Array.from({ length: 500 }, (_, index) => open[index % open.length] as string);

describe('P44C budgets', () => {
  it('keeps the table files within their byte budgets', () => {
    expect(Buffer.byteLength(read('src/play/vocab/verbs.json'))).toBeLessThanOrEqual(160 * 1024);
    const nearest = read('src/play/arcade/nearest.json');
    expect(Buffer.byteLength(nearest)).toBeLessThanOrEqual(200 * 1024);
    expect(gzipSync(nearest).length).toBeLessThanOrEqual(48 * 1024);
  });

  it('parses the verb table within 50 ms', () => {
    const text = read('src/play/vocab/verbs.json');
    const started = performance.now();
    JSON.parse(text);
    expect(performance.now() - started).toBeLessThanOrEqual(50);
  });

  it('looks up every word of a sentence within 1 ms after warm-up', () => {
    const words = sentences.map((sentence) => sentence.toLowerCase().match(/[a-z]+/g) ?? []);
    for (const list of words) for (const word of list) vocabVerb(word);
    const started = performance.now();
    for (const list of words) for (const word of list) vocabVerb(word);
    expect(open.length).toBeGreaterThan(200);
    expect((performance.now() - started) / sentences.length).toBeLessThanOrEqual(1);
  });
});
