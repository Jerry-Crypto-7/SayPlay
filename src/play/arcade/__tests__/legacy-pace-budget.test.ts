import { expect, it } from 'vitest';
import { arcadeWorldOf } from '../compile';
import { compileWith } from '../../compose/compile';
import { throwGenre } from '../../genre/throw';
import { questGenre } from '../../genre/quest';
import { readRecipeContent } from '../../director/read';
import { liveCells } from '../../compose/allowed';
import type { GenreModule, GenreSpec } from '../../genre/contract';

it.each(['throw', 'quest'] as const)('%s keeps generated work and shortens only the visible deadline', genre => {
 const module = (genre === 'throw' ? throwGenre : questGenre) as GenreModule;
 const content = { genre, mode: genre === 'throw' ? 'default' : 'station', hero: 'fox', setting: 'forest' } as GenreSpec;
 const original = compileWith(module, content);
 const faster = compileWith(module, { ...content, params: { paceBudgetPct: 60 } });
 for (let seed = 1; seed <= 5; seed++) {
  const a = arcadeWorldOf(original, seed); const b = arcadeWorldOf(faster, seed);
  if (!a.ok || !b.ok) throw new Error('Both clocks must build.');
  expect(b.world.initial).toEqual(a.world.initial);
  expect(b.world.control).toEqual(a.world.control); expect(b.world.bot).toEqual(a.world.bot);
  expect(b.world.kinds).toEqual(a.world.kinds);
  expect(b.world.rules.filter(rule => rule.id !== 'time_limit' && rule.id !== 'score_bonus')).toEqual(a.world.rules.filter(rule => rule.id !== 'time_limit' && rule.id !== 'score_bonus'));
  const before = a.world.rules.find(rule => rule.id === 'time_limit')!.params.seconds as number;
  const after = b.world.rules.find(rule => rule.id === 'time_limit')!.params.seconds;
  expect(after).toBe(Math.floor(before * .6));
  expect(b.world.rules.find(rule => rule.id === 'score_bonus')?.params.limit).toBe(Number(after) * 60);
  expect(faster.objective.description).toContain(String(after));
 }
});
it('accepts only the same bounded recipe clock ratio',()=>{
 for (const id of ['throw.default','quest.station']) {
  const cell=liveCells().find(cell=>cell.id===id)!;
  for(const paceBudgetPct of [50,60,100]) expect(readRecipeContent(cell,{params:{paceBudgetPct}}).ok).toBe(true);
  for(const paceBudgetPct of [49,101]) expect(readRecipeContent(cell,{params:{paceBudgetPct}}).ok).toBe(false);
 }
});
