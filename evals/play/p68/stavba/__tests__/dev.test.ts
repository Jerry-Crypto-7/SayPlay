/**
 * Dev věty pruhu P68-S (T1): 20 nových vět na směnu v obchodě. Věta sdílená s jinou sadou v repu (P30 test-200,
 * otevřené holdouty, dev sady ostatních pruhů) by z ladění udělala ladění na cizích větách, proto test projde každý
 * soubor vět pod `evals/play` – i sady, které vzniknou až po sloučení `origin/main` (dev věty P68-I).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../../scripts/play-fidelity.mjs';

const PLAY = join(process.cwd(), 'evals', 'play');
const OWN = join(PLAY, 'p68', 'stavba', 'dev.json');

interface DevSentence { readonly id: string; readonly genre: string; readonly text: string; readonly customer: string; readonly goods: string; readonly goal: number }
interface DevSet { readonly goalBounds: { readonly min: number; readonly default: number; readonly max: number }; readonly sentences: readonly DevSentence[] }

const dev = JSON.parse(readFileSync(OWN, 'utf8')) as DevSet;

/** Věty souboru, je-li sadou vět (pole `{ text }` nebo `{ sentences: [{ text }] }`); jinak nic. */
function textsIn(path: string): string[] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const rows = Array.isArray(json) ? json : (json as { sentences?: unknown } | null)?.sentences;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (typeof (row as { text?: unknown } | null)?.text === 'string' ? [(row as { text: string }).text] : []));
}

function sentenceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sentenceFiles(path);
    return name.endsWith('.json') && path !== OWN ? [path] : [];
  });
}

describe('P68-S dev sentences', () => {
  it('has 20 unique buildshift sentences with customer, goods and a goal inside the bounds', () => {
    expect(dev.sentences).toHaveLength(20);
    expect(new Set(dev.sentences.map((s) => s.id)).size).toBe(20);
    expect(new Set(dev.sentences.map((s) => normalizeSentence(s.text))).size).toBe(20);
    const { min, max } = dev.goalBounds;
    for (const s of dev.sentences) {
      expect(s.genre, s.id).toBe('buildshift');
      expect(s.customer.length, s.id).toBeGreaterThan(0);
      expect(s.goods.length, s.id).toBeGreaterThan(0);
      expect(Number.isInteger(s.goal) && s.goal >= min && s.goal <= max, s.id).toBe(true);
    }
  });

  it('shares no sentence with P30 test-200 or any other sentence set in evals/play', () => {
    const files = sentenceFiles(PLAY);
    expect(files.map((f) => relative(PLAY, f).replace(/\\/g, '/'))).toContain('p30/test-200.json');
    const seen = new Map<string, string>();
    for (const file of files) for (const text of textsIn(file)) seen.set(normalizeSentence(text), relative(PLAY, file));
    const clashes = dev.sentences.filter((s) => seen.has(normalizeSentence(s.text))).map((s) => `${s.id} ← ${seen.get(normalizeSentence(s.text)) as string}`);
    expect(clashes).toEqual([]);
  });
});
