/**
 * Sady P54C (T2): dev sada osmi nových žánrů s větami „nesmí přepnout“ a
 * nezávislý holdout 80 vět, hlídaný otiskem. Holdout napsal subagent bez
 * přístupu ke kódu, plánům a sadám; do konečného měření (T16) ho kromě tohoto
 * testu nic nečte – změna jediného bajtu = nová sada, ne tichá úprava.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GENRE_MODES, type GenreId } from '@/play/genre/contract';

import { normalizeSentence } from '../../../../scripts/play-fidelity.mjs';

const PLAY = join(process.cwd(), 'evals', 'play');
const DIR = join(PLAY, 'p54c');
const readLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** SHA-256 nad LF bajty `holdout.json`, zapsaný v README při vzniku sady. */
export const P54C_HOLDOUT_SHA256 = 'c3d545c53a59d8569f264466818bf3172fbba49a9914928d1efd7b6e650eca68';

/** Osm nových žánrů plánu; v `GENRES` přibudou až v T4, sada je zná napřed. */
export const P54C_GENRES = ['catch', 'whack', 'defense', 'slice', 'hop', 'crowd', 'merge', 'push'] as const;

interface DevSentence { readonly id: string; readonly family: 'target' | 'trap'; readonly expect: string; readonly text: string }
const DEV: { sentences: DevSentence[] } = JSON.parse(readLf(join(DIR, 'dev.json')));
const HOLDOUT = (): { sentences: { id: string; family: string; genre: string | null; text: string }[] } => JSON.parse(readLf(join(DIR, 'holdout.json')));

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

const countBy = <T>(list: readonly T[], key: (item: T) => string): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of list) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
};

describe('P54C sets', () => {
  it('dev set has 8 sentences per new genre and 16 traps labelled with an existing genre mode', () => {
    expect(DEV.sentences).toHaveLength(80);
    const targets = DEV.sentences.filter((s) => s.family === 'target');
    expect(countBy(targets, (s) => s.expect)).toEqual(Object.fromEntries(P54C_GENRES.map((genre) => [`${genre}.default`, 8])));
    const traps = DEV.sentences.filter((s) => s.family === 'trap');
    expect(traps).toHaveLength(16);
    for (const trap of traps) {
      const [genre, mode] = trap.expect.split('.') as [GenreId, string];
      expect((GENRE_MODES[genre] as readonly string[] | undefined)?.includes(mode), trap.id).toBe(true);
      expect((P54C_GENRES as readonly string[]).includes(genre), trap.id).toBe(false);
    }
    expect(new Set(DEV.sentences.map((s) => s.id)).size).toBe(80);
  });

  it('baseline records every dev sentence', () => {
    const baseline = JSON.parse(readLf(join(DIR, 'baseline.json'))) as { sentences: { id: string }[] };
    expect(baseline.sentences.map((row) => row.id)).toEqual(DEV.sentences.map((s) => s.id));
  });

  it('holdout matches its recorded SHA-256, also written in the README', () => {
    const bytes = readLf(join(DIR, 'holdout.json'));
    expect(createHash('sha256').update(bytes, 'utf8').digest('hex')).toBe(P54C_HOLDOUT_SHA256);
    expect(readLf(join(DIR, 'README.md'))).toContain(P54C_HOLDOUT_SHA256);
  });

  it('holdout has 60 target sentences in the planned genre shares and 20 distractors', () => {
    const holdout = HOLDOUT().sentences;
    expect(holdout).toHaveLength(80);
    expect(countBy(holdout.filter((s) => s.family === 'target'), (s) => String(s.genre))).toEqual({ catch: 8, whack: 8, defense: 8, slice: 8, hop: 7, crowd: 7, merge: 7, push: 7 });
    expect(holdout.filter((s) => s.family === 'distractor' && s.genre === null)).toHaveLength(20);
  });

  it('shares no sentence with any other set, nor dev with holdout', () => {
    const others = otherSentences();
    // Kontrola sama kolizi pozná: věta P30 dev se přepisem velikosti a interpunkce neschová.
    expect(others.has(normalizeSentence('Zombie shooter in a MALL!'))).toBe(true);
    const holdout = HOLDOUT().sentences;
    // Jen id a sada, ne věta: holdout se do výstupu testu nedostane.
    const clash = (list: readonly { id: string; text: string }[]) => list.filter((s) => others.has(normalizeSentence(s.text))).map((s) => `${s.id} = ${String(others.get(normalizeSentence(s.text)))}`);
    expect(clash(DEV.sentences)).toEqual([]);
    expect(clash(holdout)).toEqual([]);
    const dev = new Set(DEV.sentences.map((s) => normalizeSentence(s.text)));
    expect(dev.size).toBe(DEV.sentences.length);
    expect(holdout.filter((s) => dev.has(normalizeSentence(s.text))).map((s) => s.id)).toEqual([]);
    expect(new Set(holdout.map((s) => normalizeSentence(s.text))).size).toBe(holdout.length);
  });

  // T16 (pin): holdout otevřený dvakrát je dev sada. Záznam otevření nese otisk zapečetěné sady a `final.json` je
  // z téhož otevření – jeho souhrn sedí na řádky všech 80 vět, takže číslo ve zprávě nejde přepsat bez nového měření.
  it('was opened once for the final report, and final.json summarises exactly its 80 rows (T16)', () => {
    const opened = JSON.parse(readLf(join(DIR, 'holdout-opened.json'))) as { sha256: string; commit: string };
    const final = JSON.parse(readLf(join(DIR, 'final.json'))) as {
      sha256: string;
      commit: string;
      summary: { targetGenre: { hit: number; of: number }; distractorStays: { hit: number; of: number }; playable: { hit: number; of: number } };
      rows: { id: string; family: string; genreOk: boolean; bot: { wins: boolean } }[];
    };
    expect(opened.sha256).toBe(P54C_HOLDOUT_SHA256);
    expect(final.sha256).toBe(P54C_HOLDOUT_SHA256);
    expect(final.commit).toBe(opened.commit);
    expect(final.rows.map((row) => row.id)).toEqual(HOLDOUT().sentences.map((s) => s.id));
    const targets = final.rows.filter((row) => row.family === 'target');
    expect(final.summary.targetGenre).toMatchObject({ hit: targets.filter((row) => row.genreOk).length, of: 60 });
    expect(final.summary.distractorStays).toMatchObject({ hit: final.rows.filter((row) => row.family === 'distractor' && row.genreOk).length, of: 20 });
    expect(final.summary.playable).toMatchObject({ hit: final.rows.filter((row) => row.bot.wins).length, of: 80 });
  });
});
