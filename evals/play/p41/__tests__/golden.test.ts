/**
 * Zmrazení P41 T3 – síť pod přestavbou žánrů na recepty.
 *
 * Přepočítá z dnešního kódu všechno, co `golden/freeze.measure.ts` zapsal,
 * a porovná. Červená = některá existující hra se změnila; zpráva jmenuje
 * `žánr.režim/varianta#semínko` a co se pohnulo. Nový stav se zmrazí jen
 * vědomě, generátorem – nikdy přepsáním čísla v testu.
 *
 * Co test pokrývá (celá matice, žádný výběr):
 * - každá varianta: verdikt `readGenreSpec`, celý `GameSpecV1` z `compileGenre`
 *   (deep-equal), verdikt a `specHash` z `readGameSpec`;
 * - každé semínko 1–3: hash světa `arcadeWorldOf` (nebo že je dál odmítnutý);
 * - každý zmrazený záznam robota: přehrání `scoredReplay` nad dnešním světem
 *   → výsledek, tik, skóre, životy a hash stavu;
 * - brána publikace `compileArcade` (ořez cílového skóre, robot, nečinný hráč)
 *   jen na semínku 1 – plná brána pouští robota znovu a stála by minuty;
 * - uložené hry: dekódování souborovým úložištěm, `readGameSpec`, hash
 *   uloženého světa, nové přeložení, přehrání zmrazeného záznamu;
 * - fixtury `mustReject`: dál odmítnuté týmž čtenářem z téhož důvodu.
 *
 * Text důvodu odmítnutí (`issues`) se nesrovnává – jen to, že odmítnutí trvá
 * a jeho `reason`; hra, která nevznikla, se změnit nemůže.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { canonical } from '@/ir/worlddoc';

import {
  type CompiledRecord,
  GOLDEN_FILES,
  type MustReject,
  type ReplayRecord,
  SEEDS,
  type StoredGame,
  type Variant,
  type VariantRecord,
  botReplay,
  decodeInputs,
  decodeStored,
  deriveStored,
  guarded,
  rejectVerdict,
  replayKey,
  replayOutcome,
  runVariant,
  variants,
} from '../golden/freeze';

type Rejection = { readonly ok: false; readonly reason?: string; readonly issues: readonly string[] };

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const genres = read<{ readonly variants: readonly VariantRecord[] }>(GOLDEN_FILES.genres);
const replays = read<{ readonly replays: Readonly<Record<string, ReplayRecord | Rejection>> }>(GOLDEN_FILES.replays).replays;
const stored = read<{ readonly games: readonly StoredGame[]; readonly mustReject: readonly MustReject[] }>(GOLDEN_FILES.stored);

const frozenById = new Map(genres.variants.map((record) => [record.id, record]));
const VARIANTS = variants();

/** Verdikt bez textu důvodu (viz hlavička). */
function verdict(value: unknown): string {
  if (value === undefined) return 'absent';
  const { issues: _issues, ...rest } = value as Partial<Rejection> & Record<string, unknown>;
  return canonical((value as { readonly ok?: boolean }).ok === false ? rest : value);
}

/** První cesta, kde se dva JSON liší – ať zpráva řekne, co se ve specu pohnulo. */
function firstDiff(a: unknown, b: unknown, path = ''): string {
  if (canonical(a) === canonical(b)) return '';
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return `${path || '/'}: ${JSON.stringify(a)?.slice(0, 120)} → ${JSON.stringify(b)?.slice(0, 120)}`;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const found = firstDiff((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}/${key}`);
    if (found !== '') return found;
  }
  return path || '/';
}

const describeRun = (run: ReplayRecord | Rejection | Omit<ReplayRecord, 'inputs'>): string =>
  'outcome' in run ? `${run.outcome}@${run.tick} score ${run.score} lives ${run.lives} hash ${run.hash}` : `THROWN ${run.issues.join('; ')}`;

/** Rozdíly jedné varianty proti zmrazenému záznamu (prázdné = beze změny). */
function variantChanges(variant: Variant, withCompiledSeed: number | null): string[] {
  const frozen = frozenById.get(variant.id);
  if (frozen === undefined) return [`${variant.id}: new variant, not frozen`];
  const { record, worlds } = runVariant(variant, { compiledSeeds: withCompiledSeed === null ? [] : [withCompiledSeed] });
  const changes: string[] = [];
  const at = variant.id;
  if (verdict(record.genreSpec) !== verdict(frozen.genreSpec)) changes.push(`${at}: readGenreSpec ${verdict(frozen.genreSpec)} → ${verdict(record.genreSpec)}`);
  if (record.thrown !== frozen.thrown) changes.push(`${at}: compileGenre threw ${String(frozen.thrown)} → ${String(record.thrown)}`);
  if (canonical(record.spec) !== canonical(frozen.spec)) changes.push(`${at}: GameSpecV1 changed at ${firstDiff(frozen.spec, record.spec)}`);
  if (verdict(record.read) !== verdict(frozen.read)) changes.push(`${at}: readGameSpec ${verdict(frozen.read)} → ${verdict(record.read)}`);
  for (const seed of SEEDS) {
    const key = replayKey(variant.id, seed);
    const want = frozen.worlds?.[String(seed)];
    const got = record.worlds?.[String(seed)];
    if (verdict(got) !== verdict(want)) changes.push(`${key}: world ${verdict(want)} → ${verdict(got)}`);
    const frozenRun = replays[key];
    const world = worlds.get(seed);
    if (frozenRun === undefined || world === undefined) {
      if ((frozenRun === undefined) !== (world === undefined)) changes.push(`${key}: world ${world === undefined ? 'no longer builds' : 'builds now'}, frozen replay ${frozenRun === undefined ? 'absent' : 'present'}`);
      continue;
    }
    if ('inputs' in frozenRun) {
      const { inputs, ...want } = frozenRun;
      const now = guarded(() => replayOutcome(world, decodeInputs(inputs)));
      if (canonical(now) !== canonical(want)) changes.push(`${key}: replay ${describeRun(want)} → ${describeRun(now)}`);
    } else {
      // Dnes robot na tomhle světě padá výjimkou – musí padat dál, jinak se hra změnila.
      const now = guarded(() => botReplay(world, key));
      if (verdict(now) !== verdict(frozenRun)) changes.push(`${key}: bot run ${describeRun(frozenRun)} → ${describeRun(now)}`);
    }
  }
  if (withCompiledSeed !== null && record.read?.ok === true) {
    const gate = record.compiled?.[String(withCompiledSeed)];
    const want: CompiledRecord | undefined = frozen.compiled?.[String(withCompiledSeed)];
    if (verdict(gate) !== verdict(want)) changes.push(`${replayKey(variant.id, withCompiledSeed)}: compileArcade ${verdict(want)} → ${verdict(gate)}`);
  }
  return changes;
}

describe('P41 golden freeze – genre outputs, worlds and replays', () => {
  it('the variant matrix is the frozen one', () => {
    expect(VARIANTS.map((variant) => variant.id)).toEqual(genres.variants.map((record) => record.id));
  });

  const groups = [...new Set(VARIANTS.map((variant) => variant.id.split('/')[0] as string))];
  it.each(groups)('%s: every variant compiles, builds and replays as frozen', (group) => {
    const changes = VARIANTS.filter((variant) => variant.id.startsWith(`${group}/`)).flatMap((variant) => variantChanges(variant, 1));
    expect(changes).toEqual([]);
  });
});

describe('P41 golden freeze – stored games', () => {
  it('every frozen stored game decodes and replays identically', async () => {
    expect(stored.games.length).toBeGreaterThan(0);
    const decoded = await decodeStored(stored.games);
    const changes: string[] = [];
    for (const game of stored.games) {
      const at = `stored ${game.versionId}`;
      const now = decoded.get(game.versionId);
      if (now === null || now === undefined) {
        changes.push(`${at}: does not decode`);
        continue;
      }
      if (canonical(now) !== canonical(game.game)) changes.push(`${at}: decoded envelope changed at ${firstDiff(game.game, now)}`);
      const derived = await deriveStored(now, at, decodeInputs(game.derived.replay.inputs));
      // Záznam vstupu se nesrovnává jako text: jiná verze zlib ho zabalí jinak, přehraje se ale stejně.
      const { replay: { inputs: _frozenInputs, ...wantReplay }, ...want } = game.derived;
      const { replay: { inputs: _inputs, ...gotReplay }, ...got } = derived;
      if (canonical(got) !== canonical(want)) changes.push(`${at}: ${firstDiff(want, got)}`);
      if (canonical(gotReplay) !== canonical(wantReplay)) changes.push(`${at}: replay ${describeRun(wantReplay)} → ${describeRun(gotReplay)}`);
    }
    expect(changes).toEqual([]);
  });

  it('every mustReject fixture is still rejected by the same reader for the same reason', () => {
    expect(stored.mustReject.length).toBeGreaterThan(0);
    const changes = stored.mustReject.flatMap((frozen) => {
      const now = rejectVerdict(frozen.file);
      if (!('reader' in now)) return [`${frozen.file}: accepted now, was ${frozen.reader} ${frozen.reason}`];
      return now.reader === frozen.reader && now.reason === frozen.reason ? [] : [`${frozen.file}: ${frozen.reader} ${frozen.reason} → ${now.reader} ${now.reason}`];
    });
    expect(changes).toEqual([]);
  });
});
