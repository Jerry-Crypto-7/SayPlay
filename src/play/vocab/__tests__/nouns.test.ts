/**
 * Podstatná jména OEWN v `nearest.json` (P44C T10). Nafouknutý klientský balík nebo přepsané staré
 * záznamy nejsou vidět, dokud někdo neměří – proto test měří bajty a porovná staré záznamy s `main`.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { modelOf, NEAREST_MIN, sceneModelOf } from '@/play/arcade/models';

const NEAREST = 'src/play/arcade/nearest.json';
const raw = readFileSync(NEAREST, 'utf8').replace(/\r\n/g, '\n');
const table = JSON.parse(raw) as { abstractCeiling: number; words: Record<string, [string, number]> };
/** Tabulka před P44C (667 slov, přepočítaná P43 proti katalogu bez nepoznatelných modelů) – `main` po PR #28. */
const before = JSON.parse(execFileSync('git', ['show', 'ef0bcdea:src/play/arcade/nearest.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as typeof table;
const manifest = JSON.parse(readFileSync('src/play/vocab/manifest.json', 'utf8')) as { outputs: { nearest?: { sha256: string } } };

describe('OEWN nouns in nearest.json', () => {
  it('stays within the client budget', () => {
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(200 * 1024);
    expect(gzipSync(raw).length).toBeLessThanOrEqual(48 * 1024);
  });

  it('keeps every P37A entry and the abstract ceiling as they were', () => {
    expect(Object.keys(before.words)).toHaveLength(667);
    for (const [word, entry] of Object.entries(before.words)) expect(table.words[word], word).toEqual(entry);
    expect(table.abstractCeiling).toBe(before.abstractCeiling);
  });

  it('adds new nouns only at or above the loose threshold', () => {
    const added = Object.entries(table.words).filter(([word]) => !(word in before.words));
    expect(added.length).toBeGreaterThan(1000);
    for (const [word, [, score]] of added) expect(score, word).toBeGreaterThanOrEqual(0.5);
  });

  it('gives fantasy creatures a model', () => {
    // Oba tvory má katalog od P42 přímo; „wyvern“ OEWN zná, ale s žádným modelem nedosáhne 0,5 a do tabulky nejde.
    for (const word of ['griffin', 'kraken']) expect(modelOf(word, true), word).toBeDefined();
    expect(table.words.wyvern).toBeUndefined();
  });

  it('draws a noun only OEWN brought in', () => {
    const added = Object.entries(table.words).filter(([word, [, score]]) => !(word in before.words) && score >= NEAREST_MIN);
    expect(added.length).toBeGreaterThan(100);
    for (const [word] of added) expect(sceneModelOf(word, false), word).toBeDefined();
  });

  it('is pinned in the manifest', () => {
    expect(manifest.outputs.nearest?.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});
