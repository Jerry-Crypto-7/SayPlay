/**
 * Sady P47A (T1): vývojová sada 30 vět pro šest žánrů plánu a nezávislý
 * holdout 60 vět, hlídaný otiskem. Holdout napsal subagent bez přístupu ke
 * kódu, plánům a sadám; do konečného měření (T12) ho kromě tohoto testu nic
 * nečte – změna jediného bajtu = nová sada, ne tichá úprava.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadRapier } from '@/play/arcade/physics/world';
import { draftGameSpecWithMeta } from '@/play/draft';

import { checkCorpus, normalizeSentence } from '../../../../scripts/play-fidelity.mjs';
import { genreOfSpec } from '../finale';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p47a');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při vzniku sady. */
const HOLDOUT_SHA256 = '7f62855dd8f45ad6ab1f050aea403ad76030b5c9163c6bedef643cdddbd9bd79';

interface DevSentence { readonly id: string; readonly cell: string; readonly text: string }
const DEV: { sentences: DevSentence[] } = JSON.parse(readLf(join(DIR, 'dev.json')));
const DEV_CELLS = { 'arena.collect': 10, 'arena.escape': 4, 'quest.spatial': 5, 'quest.station': 4, duel: 4, throw: 3 };
const HOLDOUT_GROUPS = { threat: 24, everyday: 15, fantasy: 12, 'non-game': 9 };

/**
 * Věty všech ostatních sad `evals/play/**`: `sentences[].text|sentence` a `groups.*[].sentence`.
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

describe('P47A sets', () => {
  beforeAll(async () => {
    await loadRapier();
  });

  it('dev set has 30 sentences in the planned genre shares, each cell = the fast draft genre on seed 1', () => {
    expect(DEV.sentences).toHaveLength(30);
    const counts: Record<string, number> = {};
    for (const sentence of DEV.sentences) counts[sentence.cell] = (counts[sentence.cell] ?? 0) + 1;
    expect(counts).toEqual(DEV_CELLS);
    for (const sentence of DEV.sentences) expect(genreOfSpec(draftGameSpecWithMeta(sentence.text, 1).spec), sentence.id).toBe(sentence.cell);
  });

  it('holdout matches its recorded SHA-256, also written in the README', () => {
    const bytes = readLf(join(DIR, 'holdout.json'));
    expect(createHash('sha256').update(bytes, 'utf8').digest('hex')).toBe(HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(HOLDOUT_SHA256);
  });

  it('holdout is a valid corpus of 60 sentences in the P45 group shares', () => {
    const holdout = JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: { id: string; group: string; text: string }[] };
    expect(checkCorpus(holdout)).toEqual([]);
    expect(holdout.sentences).toHaveLength(60);
    const counts: Record<string, number> = {};
    for (const sentence of holdout.sentences) counts[sentence.group] = (counts[sentence.group] ?? 0) + 1;
    expect(counts).toEqual(HOLDOUT_GROUPS);
  });

  it('shares no sentence with any other set, nor dev with holdout', () => {
    const others = otherSentences();
    // Kontrola sama kolizi pozná: věta panelu P45 se přepisem velikosti a interpunkce neschová.
    expect(others.has(normalizeSentence('A FAIRY lights lanterns along a moonlit forest path!'))).toBe(true);
    const holdout = (JSON.parse(readLf(join(DIR, 'holdout.json'))) as { sentences: { id: string; text: string }[] }).sentences;
    const clash = (list: readonly { id: string; text: string }[]) => list.filter((s) => others.has(normalizeSentence(s.text))).map((s) => `${s.id} = ${String(others.get(normalizeSentence(s.text)))}`);
    expect(clash(DEV.sentences)).toEqual([]);
    expect(clash(holdout)).toEqual([]);
    const dev = new Set(DEV.sentences.map((s) => normalizeSentence(s.text)));
    expect(holdout.filter((s) => dev.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(new Set(holdout.map((s) => normalizeSentence(s.text))).size).toBe(holdout.length);
  });
});
