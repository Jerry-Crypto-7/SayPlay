/**
 * Žánr Obchod se součtem (P83E T3): ruční spec e2e je překlad modulu a projde branou specu; přeložená hra se dá
 * vyhrát (ověřovač, robot `shop_bot`) u obou cílů a trefa má životy. Čtení věty a směrování hlídá T4.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '../../arcade/compile';
import { nativeRule } from '../../arcade/contract';
import type { ShopGame } from '../../arcade/pieces/shop-level';
import { verifyArcade } from '../../arcade/verify';
import { compileWith } from '../../compose/compile';
import { type GameSpecV1, readGameSpec } from '../../spec';
import type { GenreModule } from '../contract';
import { readGenreSpec } from '../index';
import { amountText, shopGenre } from '../shop';

const FIXTURE_PATH = join(process.cwd(), 'e2e/fixtures/p83e-shop-spec.json');
const CONTENT = { genre: 'shop', mode: 'default', hero: 'fox', setting: 'toy shop', cast: [{ label: 'teddy bear', does: 'collect' }], params: { items: 3 } } as const;

function specOf(content: object): GameSpecV1 {
  const read = readGenreSpec(content);
  if (!read.ok) throw new Error(read.issues.join('; '));
  return compileWith(shopGenre as unknown as GenreModule, read.value);
}

function played(spec: GameSpecV1, seed: number) {
  const made = arcadeWorldOf(spec, seed);
  if (!made.ok) throw new Error(made.issues.join('; '));
  return { world: made.world, verdict: verifyArcade(made.world, undefined, made.roleBindings) };
}

describe('shop genre (P83E T3)', () => {
  it('the hand spec of the e2e fixture is the module translation and passes the spec gate', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
    expect(specOf(CONTENT)).toEqual(fixture);
    expect(readGameSpec(fixture).ok).toBe(true);
  });

  it('“put N on the counter” shelves exactly N items and the bot wins', () => {
    for (const items of [2, 3, 5, 8]) {
      const { world, verdict } = played(specOf({ ...CONTENT, params: { items } }), items);
      const game = nativeRule(world.rules, 'shop_total')?.params as unknown as ShopGame;
      expect(game.count, `items ${items}`).toBe(items);
      expect(game.target).toBe(0);
      expect(verdict.bot.outcome, verdict.failures.join('; ')).toBe('won');
    }
  });

  it('“hit the total” aims at the target in game units, has lives and the bot wins', () => {
    const spec = specOf({ ...CONTENT, params: { items: 3, target: 12 } });
    expect(spec.mechanics.map((mechanic) => mechanic.id)).toContain('health');
    expect(spec.objective.description).toContain(amountText(12, 'price'));
    const { world, verdict } = played(spec, 4);
    expect((nativeRule(world.rules, 'shop_total')?.params as unknown as ShopGame).target).toBe(24);
    expect(verdict.bot.outcome, verdict.failures.join('; ')).toBe('won');
  });

  it('the unit param picks weight and plain numbers', () => {
    const weight = played(specOf({ ...CONTENT, params: { items: 3, unit: 1 } }), 2).world;
    const plain = played(specOf({ ...CONTENT, params: { items: 3, unit: 2 } }), 2).world;
    expect((nativeRule(weight.rules, 'shop_total')?.params as unknown as ShopGame).unit).toBe('weight');
    expect((nativeRule(plain.rules, 'shop_total')?.params as unknown as ShopGame).unit).toBe('plain');
  });
});
