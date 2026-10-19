/**
 * Sady P52 (T2): dev sada 40 vět mířená na mezery P47B a nezávislý holdout
 * 40 vět, hlídaný otiskem. Holdout napsal subagent bez přístupu ke kódu,
 * plánům a sadám; do konečného měření (T11) ho kromě tohoto testu nic nečte –
 * změna jediného bajtu = nová sada, ne tichá úprava.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { ACTION_KINDS } from '../../p46/actions';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p52');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při vzniku sady. */
export const P52_HOLDOUT_SHA256 = '5dad1fbaac0da5066ff2a8906ce9fba5677770db33b868176b004bf32c8d3e61';

interface Labelled { readonly id: string; readonly text: string; readonly wants: readonly string[] }
const DEV: { sentences: (Labelled & { gap: string })[] } = JSON.parse(readLf(join(DIR, 'dev.json')));
const HOLDOUT = (): { sentences: (Labelled & { family: string })[] } => JSON.parse(readLf(join(DIR, 'holdout.json')));

/** Mezery z Fakt plánu: každá aspoň dvěma větami. */
const GAPS = [
  'strike-catch', 'strike-quest', 'strike-walker', 'shield-ball', 'shoot-free', 'dash-walker', 'shield-walker', 'shoot-walker', 'grab-stealth',
  'grab-shooter', 'shield-shooter', 'shoot-duel', 'grab-duel', 'runner-blocked', 'lexicon', 'bot-late-dash', 'arena-dash-shield',
];

/**
 * Věty všech ostatních sad `evals/play/**`: `sentences[].text|sentence` a `groups.*[].sentence` (vzor `p51/__tests__/sets.test.ts`).
 * simplified: jen soubory do 1 MB (sady vět; výsledky měření nad 1 MB věty jen opakují), při růstu sad zvednout.
 */
function otherSentences(): Map<string, string> {
  const found = new Map<string, string>();
  const add = (text: unknown, where: string): void => {
    if (typeof text === 'string') found.set(normalizeSentence(text), where);
  };
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (path !== DIR) walk(path);
        continue;
      }
      if (!name.endsWith('.json') || statSync(path).size > 1_000_000) continue;
      let data: unknown;
      try {
        data = JSON.parse(readLf(path));
      } catch {
        continue;
      }
      const where = relative(PLAY, path);
      const { sentences, groups } = (data ?? {}) as { sentences?: unknown; groups?: unknown };
      if (Array.isArray(sentences)) for (const item of sentences) add(typeof item === 'string' ? item : (item as { text?: unknown; sentence?: unknown })?.text ?? (item as { sentence?: unknown })?.sentence, where);
      if (groups !== null && typeof groups === 'object') for (const list of Object.values(groups)) if (Array.isArray(list)) for (const item of list) add((item as { sentence?: unknown })?.sentence, where);
    }
  };
  walk(PLAY);
  return found;
}

const validWants = (wants: readonly string[]): boolean => wants.length <= 2 && wants.every((kind) => (ACTION_KINDS as readonly string[]).includes(kind));

describe('P52 sets', () => {
  it('dev set: 40 sentences, every gap at least twice, six enemy-verb traps that want nothing', () => {
    expect(DEV.sentences).toHaveLength(40);
    const counts: Record<string, number> = {};
    for (const sentence of DEV.sentences) counts[sentence.gap] = (counts[sentence.gap] ?? 0) + 1;
    for (const gap of GAPS) expect(counts[gap] ?? 0, gap).toBeGreaterThanOrEqual(2);
    expect(counts['enemy-verb']).toBe(6);
    expect(Object.keys(counts).sort()).toEqual([...GAPS, 'enemy-verb'].sort());
    for (const sentence of DEV.sentences) {
      expect(validWants(sentence.wants), sentence.id).toBe(true);
      expect(sentence.wants.length === 0, sentence.id).toBe(sentence.gap === 'enemy-verb');
    }
  });

  it('holdout matches its recorded SHA-256, also written in the README', () => {
    const bytes = readLf(join(DIR, 'holdout.json'));
    expect(createHash('sha256').update(bytes, 'utf8').digest('hex')).toBe(P52_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P52_HOLDOUT_SHA256);
  });

  it('holdout: 40 labelled sentences, 30 with a hero action and 10 enemy-only', () => {
    const { sentences } = HOLDOUT();
    expect(sentences).toHaveLength(40);
    // Jen id, ne věta: holdout se do výstupu testu nedostane.
    expect(sentences.filter((s) => !validWants(s.wants)).map((s) => s.id)).toEqual([]);
    expect(sentences.filter((s) => s.wants.length > 0)).toHaveLength(30);
    expect(sentences.filter((s) => (s.wants.length === 0) !== (s.family === 'enemy')).map((s) => s.id)).toEqual([]);
  });

  it('shares no sentence with any other set, nor dev with holdout', () => {
    const others = otherSentences();
    // Kontrola sama kolizi pozná: věta panelu P47B se přepisem velikosti a interpunkce neschová.
    expect(others.has(normalizeSentence('A KANGAROO boxer punches a robot opponent in a neon ring'))).toBe(true);
    const holdout = HOLDOUT().sentences;
    const clash = (list: readonly Labelled[]) => list.filter((s) => others.has(normalizeSentence(s.text))).map((s) => `${s.id} = ${String(others.get(normalizeSentence(s.text)))}`);
    expect(clash(DEV.sentences)).toEqual([]);
    expect(clash(holdout)).toEqual([]);
    const dev = new Set(DEV.sentences.map((s) => normalizeSentence(s.text)));
    expect(dev.size).toBe(DEV.sentences.length);
    expect(holdout.filter((s) => dev.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(new Set(holdout.map((s) => normalizeSentence(s.text))).size).toBe(holdout.length);
  });
});
