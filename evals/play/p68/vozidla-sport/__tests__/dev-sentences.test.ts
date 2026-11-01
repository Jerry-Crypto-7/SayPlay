/**
 * P68V T1: dev věty pruhu jsou nové. Věta, která už je v zapečetěné sadě P30 nebo v jiné sadě pod `evals/play`,
 * by ladění na dev větách potichu přenesla na měřené věty.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLAY = join(HERE, '..', '..');

interface Sentence { id: string; game: string; text: string }

const dev = (JSON.parse(readFileSync(join(HERE, 'dev.json'), 'utf8')) as { sentences: Sentence[] }).sentences;
const norm = (text: string): string => text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Texty každé sady vět (pole `{ text }` nebo `{ sentences: [{ text }] }`) pod `evals/play`, mimo tento pruh. */
function otherSets(dir: string, out: Map<string, string> = new Map()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (file === HERE || name === 'node_modules') continue;
    if (statSync(file).isDirectory()) {
      otherSets(file, out);
      continue;
    }
    if (!name.endsWith('.json')) continue;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const rows = Array.isArray(json) ? json : (json as { sentences?: unknown } | null)?.sentences;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const text = (row as { text?: unknown } | null)?.text;
      if (typeof text === 'string') out.set(norm(text), relative(PLAY, file).replace(/\\/g, '/'));
    }
  }
  return out;
}

describe('P68V dev sentences', () => {
  it('ten per game, unique ids and texts', () => {
    expect(dev.filter((s) => s.game === 'stunt')).toHaveLength(10);
    expect(dev.filter((s) => s.game === 'minigolf')).toHaveLength(10);
    expect(new Set(dev.map((s) => s.id)).size).toBe(dev.length);
    expect(new Set(dev.map((s) => norm(s.text))).size).toBe(dev.length);
  });

  it('none of them is in the sealed P30 set or any other sentence set under evals/play', () => {
    const known = otherSets(PLAY);
    expect(known.size).toBeGreaterThan(200);
    const test200 = (JSON.parse(readFileSync(join(PLAY, 'p30/test-200.json'), 'utf8')) as { sentences: { text: string }[] }).sentences;
    expect(test200.every((s) => known.has(norm(s.text)))).toBe(true);
    expect(dev.filter((s) => known.has(norm(s.text))).map((s) => `${s.id} = ${known.get(norm(s.text))}`)).toEqual([]);
  });
});
