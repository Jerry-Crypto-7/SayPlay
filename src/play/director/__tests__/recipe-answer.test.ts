import { driveSpec } from '../../compose/drive';
import { nativeSpec } from '../../compose/native';
import type { Recipe } from '../../compose/recipe';
import type { GenreSpec } from '../../genre/contract';
import { describe, expect, it } from 'vitest';
import { ALLOWED, liveCells } from '../../compose/allowed';
import { DIRECTOR_PENDING, GENRE_ANSWER_SCHEMA, RECIPE_ANSWER_SCHEMA, recipeAnswerSchema } from '../answer-schema';
import { buildCompactRequest } from '../compact';
import { GENRE_RULES, buildDirectorRequest, genrePromptLines } from '../prompt';
import { readGenreAnswer, readRecipeAnswer, readRecipeContent, readModelSpec } from '../read';

const answer = () => ({ recipe: liveCells()[0]!.recipe, hero: 'fox', setting: 'forest', cast: [{ label: 'coins', does: 'collect' }], unmet: [{ actor: 'fox', verb: 'sing', object: null }] });

describe('P41 recipe answers', () => {
  it('reads bare and wrapped recipes with named cast and explicit unmet', () => {
    for (const body of [answer(), { plan: 'Preserve the requested actions.', spec: answer() }]) {
      const read = readRecipeAnswer(body);
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error(read.detail);
      expect(read.value.recipe).toEqual(answer().recipe);
      expect(read.value.cast).toEqual([{ label: 'coin', does: 'collect' }]);
      expect(read.value.unmet).toEqual([{ actor: 'fox', verb: 'sing', object: null }]);
    }
  });
  it('does not silently discard an unknown movement', () => {
    const read = readRecipeAnswer({ ...answer(), recipe: { ...answer().recipe, move: 'teleport' } });
    expect(read).toMatchObject({ ok: false, reason: 'MALFORMED_SPEC' });
    if (!read.ok) expect(read.detail).toContain('recipe.move');
  });
  it('rejects a valid vocabulary combined outside the live table', () => {
    expect(readRecipeAnswer({ ...answer(), recipe: { move: 'stationary', actions: [], objective: 'race', threats: [] } })).toMatchObject({ ok: false, detail: expect.stringContaining('not a live combination') });
  });
  it('accepts model null optional fields without dropping a null triple object', () => {
    const read = readRecipeAnswer({ ...answer(), cast: null, params: null, palette: null });
    expect(read.ok).toBe(true);
    if (read.ok) { expect(read.value.cast).toBeUndefined(); expect(read.value.unmet[0]!.object).toBeNull(); }
  });
  it('retains unsupported named objects and never calls a declaration proof', () => {
    const read = readRecipeAnswer({ ...answer(), unmet: [{ actor: 'robot', verb: 'repair', object: 'spaceship' }] });
    expect(read.ok && read.value.unmet).toEqual([{ actor: 'robot', verb: 'repair', object: 'spaceship' }]);
  });
  it('rejects arbitrary parameter names and essential missing unmet field', () => {
    expect(readRecipeAnswer({ ...answer(), params: { teleportSpeed: 99 } }).ok).toBe(false);
    const { unmet: _unmet, ...missing } = answer();
    expect(recipeAnswerSchema.safeParse(missing).success).toBe(false);
  });
  it('continues to compile the legacy genre answer', () => {
    const read = readGenreAnswer({ plan: 'Run and collect.', spec: { genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest' } });
    expect(read.ok).toBe(true);
    if (read.ok) { expect(read.genre.genre).toBe('runner'); expect(read.spec).toBeDefined(); }
  });
  it('exports model JSON Schema entirely inline with recipe and legacy alternatives', () => {
    const json = JSON.stringify(GENRE_ANSWER_SCHEMA);
    expect(json).not.toContain('"$ref"'); expect(json).not.toContain('"$defs"');
    expect(json).toContain('"recipe"'); expect(json).toContain('"genre"'); expect(json).toContain('"unmet"');
  });
  it('offers exactly current live recipes and requires honest unmet without nearest-action claims', () => {
    const prompt = genrePromptLines();
    // P54C T5: buňky žánru, který režisér ještě nenabízí (`DIRECTOR_PENDING`), v tabulce nejsou. T14: tabulka po pohybech.
    // T14b: pohyby se stejnými kombinacemi sdílejí řádek (`- run, jump: …`).
    const row = (move: string) => prompt.split('\n').find((line) => line.startsWith('- ') && line.slice(2, line.indexOf(': ')).split(', ').includes(move))?.split(': ')[1]?.split(', ') ?? [];
    for (const cell of liveCells().filter((live) => !DIRECTOR_PENDING.has(live.preset.genre))) expect(row(cell.recipe.move), cell.id).toContain(`${cell.recipe.actions.join('+') || '-'}/${cell.recipe.objective}/${cell.recipe.threats.join('+') || '-'}`);
    expect(prompt).not.toContain('nearest one for the rest');
    expect(prompt).not.toContain('Every action the player does in the sentence must be playable');
    expect(GENRE_RULES).toContain('listed explicitly in unmet');
  });
});


describe('native recipe parameter boundaries', () => {
  it('drive accepts only lengthM/turbo/drift, preserving them in the control spec', () => {
    const cell = ALLOWED.find(item => item.assembly === 'drive')!;
    const read = readRecipeContent({ ...cell, preset: cell.preset! }, { params: { lengthM: 600, turbo: 0, drift: 1 } });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const spec = driveSpec(cell.recipe, read.value);
    expect(spec.controlParams).toMatchObject({ lengthM: 600, turbo: false, drift: true });
    expect(readModelSpec(spec).ok).toBe(true);
    for (const params of [{ lengthM: 801 }, { lengthM: 199 }, { turbo: 2 }, { drift: -1 }, { rivals: 1 }, { topSpeed: 220 }]) expect(readRecipeContent({ ...cell, preset: cell.preset! }, { params }).ok, JSON.stringify(params)).toBe(false);
  });

  it.each([
    ['glide', { lengthM: 80, topSpeed: 120 }, { lengthM: 79 }, { topSpeed: 241 }],
    ['walk', { size: 15, speed: 160 }, { size: 10 }, { speed: 161 }],
    ['ball', { targets: 5 }, { targets: 6 }, { size: 11 }],
  ] as const)('%s validates its own factory without legacy arena/voyage bounds', (move, good, bad, unrelated) => {
    const recipe: Recipe = { move, actions: [], objective: move === 'ball' ? 'score' : 'reach', threats: [] };
    const preset: GenreSpec = { genre: 'arena', mode: 'collect', hero: 'fox', setting: 'forest' };
    const cell = { recipe, assembly: 'native', preset };
    const read = readRecipeContent(cell, { params: good });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error(read.issues.join('; '));
    const compiled = readModelSpec(nativeSpec(recipe, read.value));
    expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
    expect(readRecipeContent(cell, { params: bad }).ok).toBe(false);
    expect(readRecipeContent(cell, { params: unrelated }).ok).toBe(false);
    expect(readRecipeContent(cell, { params: { invented: 1 } }).ok).toBe(false);
    expect(recipeAnswerSchema.safeParse({ recipe, hero: 'fox', setting: 'forest', params: good, unmet: [] }).success).toBe(true);
  });

  it('a count the factory does not read is dropped, never passed on; params win', () => {
    const cell = { recipe: { move: 'ball' }, assembly: 'native', preset: { genre: 'arena', mode: 'collect', hero: 'fox', setting: 'field' } as GenreSpec };
    const counts = (content: Record<string, unknown>) => { const read = readRecipeContent(cell, content); if (!read.ok) throw new Error(read.issues.join('; ')); return read.value.counts; };
    expect(counts({ counts: { target: 5 } })).toEqual({ target: 5 });
    expect(counts({ counts: { target: 6 } })).toBeUndefined();
    expect(counts({ counts: { enemy: 3, target: 4 } })).toEqual({ target: 4 });
    expect(counts({ params: { targets: 2 }, counts: { target: 3 } })).toBeUndefined();
    const walk = liveCells().find(live => live.id === 'walk.collect+guard')!;
    const read = readRecipeContent(walk, { counts: { collectible: 3 } });
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.value.counts).toBeUndefined();
  });
});

describe('P70B T4a: codex gets the recipe-only schema', () => {
  it('reaches every genre a legacy variant offers, so dropping the variants loses no game', () => {
    const variants = ((GENRE_ANSWER_SCHEMA.properties as Record<string, { anyOf: Record<string, unknown>[] }>).spec.anyOf);
    expect((RECIPE_ANSWER_SCHEMA.properties as Record<string, unknown>).spec).toEqual(variants[0]);
    const legacy = variants.slice(1).flatMap((variant) => {
      const genre = (variant.properties as Record<string, { const?: string; enum?: string[] }>).genre;
      return genre.enum ?? [genre.const as string];
    });
    const recipeGenres = new Set<string>(liveCells().filter((cell) => !DIRECTOR_PENDING.has(cell.preset.genre)).map((cell) => cell.preset.genre));
    expect(legacy.length).toBeGreaterThan(20);
    expect(legacy.filter((genre) => !recipeGenres.has(genre))).toEqual([]);
  });

  it('rides on both director requests while the other providers keep the full schema', () => {
    for (const request of [buildCompactRequest('a race car speeds around the track', null), buildDirectorRequest('a race car speeds around the track', null)]) {
      expect(request.outputSchema).toBe(GENRE_ANSWER_SCHEMA);
      expect(request.codexOutputSchema).toBe(RECIPE_ANSWER_SCHEMA);
    }
  });
});
