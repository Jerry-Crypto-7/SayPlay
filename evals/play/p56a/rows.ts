/**
 * Řádek věty P56A a jeho souhrny – sdílí výchozí měření bez čtečky (`baseline.measure.ts`, T1) a měření se čtením
 * (`dev.measure.ts`, T11). Žije mimo `.measure.ts`: import měřicího souboru by spustil i jeho `it` a přepsal jeho výstup.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lookOf } from '../../../src/play/arcade/look';
import { heroChoice } from '../../../src/play/arcade/models';
import { draftGameSpecWithMeta } from '../../../src/play/draft/draft';
import { classifyGenre } from '../../../src/play/genre/classify';
import { castFor } from '../../../src/play/genre/contract';
import type { Reading } from '../../../src/play/read/schema';

import { P55_GENRES } from '../p55/seal';

export const ROOT = join(process.cwd(), 'evals', 'play');

export interface Sentence { readonly id: string; readonly text: string; readonly family?: string; readonly expect?: string; readonly genre?: string | null; readonly checklist?: readonly { readonly slot: string; readonly match: readonly string[] }[] }

export const readSet = (path: string): Sentence[] => (JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as { sentences: Sentence[] }).sentences;
const full = (genre: string | null | undefined): string | null => genre == null ? null : genre.includes('.') ? genre : `${genre}.default`;

/** Šablona názvu z modulů žánrů: „<Postava> <Run|Quest|…>“ (T8). */
export const TEMPLATE_TITLE = /^\w+ (?:Run|Quest|Beat|Stack|Escape|Duel|Hunt|Catch|Slice|Whack|Defense|Race|Drive|Score|Hop|Merge|Push|Crowd|Flap|Throw|Shoot|Land|Dash|Fight)$/i;

export function rowOf(sentence: Sentence, reading: Reading | null = null) {
  const ranking = classifyGenre(sentence.text, reading);
  const base = { id: sentence.id, expect: full(sentence.expect ?? sentence.genre), ranked: ranking.ranked.map((choice) => `${choice.genre}.${choice.mode}`).join(' '), fallback: ranking.fallback };
  try {
    const meta = draftGameSpecWithMeta(sentence.text, 1, { reading });
    const spec = meta.spec;
    const hero = spec.roles.find((role) => role.kind === 'player')?.label ?? null;
    const heroPick = hero === null ? null : heroChoice(hero, spec.genre?.id, spec.control);
    const foe = meta.genre === null ? null : castFor(meta.genre, 'fight', 'chase_me', 'shoot_at', 'avoid')?.label ?? null;
    const foePick = foe === null ? null : heroChoice(foe, undefined, spec.control, 'enemy');
    return {
      ...base,
      draft: meta.genre === null ? null : `${meta.genre.genre}.${meta.genre.mode}`,
      cell: meta.composition?.cellId ?? null,
      title: spec.title,
      hero, heroModel: heroPick?.model ?? null, heroLevel: heroPick?.level ?? null,
      foe, foeModel: foePick?.model ?? null, foeLevel: foePick?.level ?? null,
      cast: meta.genre?.cast?.map((item) => `${item.does}:${item.label}`) ?? [],
      look: lookOf({ setting: spec.theme.setting, mood: spec.theme.mood, look: spec.theme.look }),
      goal: spec.tutorial.goalLine,
      objective: spec.objective.description,
    };
  } catch (error) {
    return { ...base, draft: null, error: (error as Error).message.slice(0, 160) };
  }
}

export type Row = ReturnType<typeof rowOf>;

export function genreSummary(sentences: readonly Sentence[], rows: readonly Row[]) {
  const targets = rows.filter((row, i) => row.expect !== null && (sentences[i]!.family ?? 'target') === 'target');
  const traps = rows.filter((row, i) => sentences[i]!.family !== undefined && sentences[i]!.family !== 'target');
  const hit = targets.filter((row) => row.draft === row.expect).length;
  // Rušivá věta P54C/P55 (žánr `null`) projde, když nehraje žádný z osmi žánrů P54C – jako `genreOk` v p55/holdout.measure.ts.
  const playsNew = (row: Row): boolean => row.draft !== null && (P55_GENRES as readonly string[]).includes(row.draft.split('.')[0]!);
  return {
    targets: { of: targets.length, draft: hit, misses: targets.filter((row) => row.draft !== row.expect).map((row) => `${row.id}: ${row.expect} -> ${row.draft ?? 'none'}`) },
    traps: { of: traps.length, stay: traps.filter((row) => !playsNew(row)).length, playedNew: traps.filter(playsNew).map((row) => `${row.id}: ${row.draft}`) },
  };
}

const said = (text: string, word: string): boolean => new RegExp(`\\b${word}`, 'i').test(text);

export function castSummary(sentences: readonly Sentence[], rows: readonly Row[]) {
  const looks = new Map<string, number>();
  for (const row of rows) if ('look' in row) looks.set(row.look, (looks.get(row.look) ?? 0) + 1);
  return {
    sentences: rows.length,
    foxHeroNotSaid: rows.filter((row, i) => 'hero' in row && row.hero === 'fox' && !said(sentences[i]!.text, 'fox')).map((row) => row.id),
    heroFallback: rows.filter((row) => 'heroLevel' in row && row.heroLevel === 'fallback').length,
    templateTitles: rows.filter((row) => 'title' in row && TEMPLATE_TITLE.test(row.title)).length,
    distinctTitles: new Set(rows.map((row) => 'title' in row ? row.title : row.id)).size,
    looks: Object.fromEntries([...looks].sort((a, b) => b[1] - a[1])),
  };
}

/** P43 panel: kolik slotů `hero`/`role` z kontrolního seznamu nese popisek hrdiny nebo obsazení (T6). */
export function panelSummary(sentences: readonly Sentence[], rows: readonly Row[]) {
  const tally = { hero: { hit: 0, of: 0 }, role: { hit: 0, of: 0 } };
  sentences.forEach((sentence, i) => {
    const row = rows[i]!;
    const hero = 'hero' in row ? (row.hero ?? '').toLowerCase() : '';
    const cast = 'cast' in row ? row.cast.join(' ').toLowerCase() : '';
    for (const item of sentence.checklist ?? []) {
      if (item.slot !== 'hero' && item.slot !== 'role') continue;
      const where = item.slot === 'hero' ? hero : `${hero} ${cast}`;
      tally[item.slot].of += 1;
      if (item.match.some((word) => where.includes(word.toLowerCase()))) tally[item.slot].hit += 1;
    }
  });
  const share = (t: { hit: number; of: number }) => ({ ...t, share: Math.round((t.hit / t.of) * 1000) / 1000 });
  return { hero: share(tally.hero), role: share(tally.role) };
}
