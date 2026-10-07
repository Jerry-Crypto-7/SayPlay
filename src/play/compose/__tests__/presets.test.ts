import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readGenreSpec } from '@/play/genre';
import type { GameSpecV1 } from '@/play/spec';
import { variants } from '../../../../evals/play/p41/golden/freeze';
import { compileRecipe } from '../compile';
import { presetOf } from '../presets';

const frozen = new Map((JSON.parse(readFileSync('evals/play/p41/golden/genres.json', 'utf8')) as { variants: { id: string; spec?: GameSpecV1 }[] }).variants.map(row => [row.id, row.spec]));

describe('genre presets compiled as recipes', () => {
  it('retains extra cast mechanics and rejects a recipe/content mismatch', () => {
    const assembly = presetOf({ genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest', cast: [{ label: 'wolf', does: 'chase_me' }, { label: 'robot', does: 'shoot_at' }] });
    expect(assembly.actions).toContain('shoot');
    expect(assembly.threats).toContain('chaser');
    expect(compileRecipe(assembly).addons).toEqual(['chaser', 'shoot']);
    expect(() => compileRecipe({ ...assembly, move: 'drive' })).toThrow('Recipe does not match');
  });
  for (const variant of variants()) it(variant.id, () => {
    const read = readGenreSpec(variant.input);
    if (!read.ok) throw new Error(read.issues.join('; '));
    let spec = compileRecipe(presetOf(read.value));
    if (variant.addon !== undefined) spec = { ...spec, addons: [...new Set([...(spec.addons ?? []), variant.addon])] };
    expect(spec).toEqual(frozen.get(variant.id));
  });
});
