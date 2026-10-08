/**
 * Šablony pravidel v okamžitém návrhu (P45B T9). Šablona, která hru shodí, by se v návrhu tiše
 * ztratila ubráním dílu – test proto hlídá pořadí „se šablonou → tentýž recept bez ní → méně
 * dílů“, že šablona dostane role jen z rolí hry, že cesty mimo `compose` (režisér, buňky) žádnou
 * nedostanou, že doručení autem (`drive.ts`) zůstane, jak bylo, a že šablona nezhorší `unmet`.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { expandTemplate } from '@/play/arcade/rules/templates';
import { verifyArcade } from '@/play/arcade/verify';
import { matchesWitness } from '@/play/arcade/witness';
import { essentialTriples } from '@/play/intent/contract';
import { extractIntent } from '@/play/intent/extract';

import { ALLOWED, assemblyOfCell } from '../allowed';
import { compileRecipe, compileTemplated } from '../compile';
import { compose } from '../compose';
import type { RecipeAssembly } from '../presets';

beforeAll(async () => { await loadRapier(); });

/** Tentýž recept bez záměru = bez šablony (jak ho staví režisér a buňky). */
const plain = (recipe: RecipeAssembly): RecipeAssembly => {
  const { intent: _intent, ...rest } = recipe;
  return rest;
};

/** Trojice věty, které hra bez šablony nedokáže. */
function unmetWithout(sentence: string, recipe: RecipeAssembly): string[] {
  const made = arcadeWorldOf(compileRecipe(plain(recipe)), 1);
  if (!made.ok) throw new Error(made.issues.join('; '));
  const verdict = verifyArcade(made.world, undefined, made.roleBindings);
  return essentialTriples(extractIntent(sentence)).filter((triple) => !verdict.witnesses.some((witness) => matchesWitness(triple, witness))).map((triple) => JSON.stringify(triple));
}

describe('the instant draft composes a rule template by the recipe axes', () => {
  it('a collecting arena gets the treasure rush overlay: logic, waves of its own pickups, every construct proved', () => {
    const made = compose(extractIntent('a robot collects batteries on Mars'));
    expect(made.template).toBe('treasure_rush');
    expect(made.spec.logic).toBeDefined();
    const world = arcadeWorldOf(made.spec, 1);
    if (!world.ok) throw new Error(world.issues.join('; '));
    const verdict = verifyArcade(world.world, undefined, world.roleBindings);
    expect(verdict.publishEligible).toBe(true);
    expect(verdict.logic.length).toBeGreaterThan(0);
    expect(verdict.logic.filter((proof) => !proof.changed)).toEqual([]);
    // Vlna rodí tělo role hry (sbírané věci), ne cizí roli.
    const wave = made.spec.rules?.flatMap((rule) => rule.do.flatMap((effect) => ('wave' in effect ? [effect.wave.role] : []))) ?? [];
    expect(wave.length).toBeGreaterThan(0);
    for (const role of wave) expect(made.spec.roles.find((item) => item.id === role)?.kind).toBe('collectible');
  });

  it('a track gets an overlay that waves at the player – a river race keeps its own finish', () => {
    const made = compose(extractIntent('a girl paddles a canoe down a rocky river'));
    expect(made.template).toBe('coin_shower');
    expect(made.spec.objective.role).toBe('finish');
    expect(made.spec.rules?.some((rule) => rule.do.some((effect) => 'win' in effect))).toBe(false);
  });

  it('an escape arena with hunters gets one reinforcement patrol, not the survive waves that lose it', () => {
    const made = compose(extractIntent('a cat stealing fish from a market while dodging the fishmonger'));
    expect(made.template).toBe('reinforcements');
    expect(made.issues.filter((issue) => issue.includes('+ template'))).toEqual([]);
  });

  it('a game without a role for any slot plays without a template and records no attempt', () => {
    const made = compose(extractIntent('candy crush but with gems in a cave'));
    expect(made.template).toBeNull();
    expect(made.spec.logic).toBeUndefined();
    expect(made.issues.filter((issue) => issue.includes('template'))).toEqual([]);
  });

  it('a template that loses the game is retried as the same recipe without it before any part is dropped', () => {
    // Let nad městem: spršky mincí u hráče robota shodí – hra jde bez šablony, ale se všemi díly.
    const sentence = 'a baby dragon learns to fly over a medieval town';
    const made = compose(extractIntent(sentence));
    expect(made.template).toBeNull();
    const failed = made.issues.findIndex((issue) => /\+ template coin_shower: .*bot_wins/.test(issue));
    expect(failed).toBeGreaterThanOrEqual(0);
    // Hned po šabloně uspěl tentýž recept bez ní: žádný jiný pokus mezi tím, díly beze změny.
    expect(made.issues.slice(failed + 1)).toEqual([]);
    expect(made.recipe.intent).toBeUndefined();
    expect(JSON.stringify(made.spec)).toBe(JSON.stringify(compileRecipe(made.recipe)));
  });

  it('a composed game whose template fails keeps every part – the template goes first, not a part', () => {
    const sentence = 'A pizza delivery scooter races through traffic to deliver before the pizza gets cold';
    const intent = extractIntent(sentence);
    const made = compose(intent);
    expect(made.recipe.parts?.length).toBeGreaterThan(0);
    const requested = made.recipe.parts?.length ?? 0;
    // Bez ohledu na to, jestli šablona prošla: díl se ubere až po pokusu bez šablony.
    const partDropped = made.issues.some((issue) => !issue.includes('+ template'));
    expect(partDropped).toBe(false);
    expect(made.recipe.parts?.length).toBe(requested);
  });

  it('the template never adds an unmet triple', () => {
    for (const sentence of ['a robot collects batteries on Mars', 'a girl paddles a canoe down a rocky river', 'an owl delivers letters across a snowy mountain village', 'me trying to fall asleep in bed the night before a big exam', 'boat race through a jungle river full of crocodiles']) {
      const made = compose(extractIntent(sentence));
      if (made.template === null) continue;
      const before = unmetWithout(sentence, made.recipe);
      const after = made.unmet.map((triple) => JSON.stringify(triple));
      expect({ sentence, extra: after.filter((triple) => !before.includes(triple)) }).toEqual({ sentence, extra: [] });
    }
  });
});

describe('paths outside the instant draft stay as they were', () => {
  it('a cell compiled for the director or a measurement (no intent) gets no template', () => {
    for (const id of ['arena.collect', 'arena.escape', 'drive.reach', 'quest.spatial']) {
      const cell = ALLOWED.find((item) => item.id === id);
      if (cell === undefined || cell.preset === null) continue;
      const { spec, template } = compileTemplated(assemblyOfCell(cell));
      expect({ id, template, logic: spec.logic }).toEqual({ id, template: null, logic: undefined });
    }
  });

  it('car delivery keeps its carry rules first and unchanged (drive.ts)', () => {
    const cell = ALLOWED.find((item) => item.id === 'drive.reach+deliver')!;
    const carry = expandTemplate('carry', { item: 'cargo', goal: 'finish' })!.map((rule) => ({ ...rule, id: `p41_${rule.id}` }));
    expect(compileRecipe(assemblyOfCell(cell)).rules).toEqual(carry);
    const made = compose(extractIntent('deliver pizzas on a bike'));
    expect(made.recipe.actions).toContain('deliver');
    expect(made.spec.rules?.slice(0, carry.length)).toEqual(carry);
  });
});
