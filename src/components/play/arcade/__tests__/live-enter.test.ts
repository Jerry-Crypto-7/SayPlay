/**
 * Enter a pole živé změny (P29D, revize fáze 2): kde Enter hraje – úder v
 * souboji, ťuk v rytmu, výstřel s `+shoot` –, pole otevírá jen tlačítko
 * Change. Jinak by úder padl a otevřené pole by hráči sebralo další klávesy.
 */

import { describe, expect, it } from 'vitest';

import duel from '@/play/arcade/__fixtures__/duel.json';
import runner from '@/play/arcade/__fixtures__/runner.json';
import timing from '@/play/arcade/__fixtures__/timing.json';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { readGameSpec } from '@/play/spec';

import { enterOpensLiveBox } from '../LiveBox';

function world(fixture: unknown, addons?: readonly string[]) {
  const spec = readGameSpec(addons === undefined ? fixture : { ...(fixture as object), addons });
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const built = arcadeWorldOf(spec.value, 1);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('Enter opens the live box only where Enter does not play', () => {
  it('opens it in a runner, where Enter does nothing', () => {
    expect(enterOpensLiveBox(world(runner))).toBe(true);
  });

  it.each([
    ['duel strike', duel],
    ['timing tap', timing],
  ])('keeps Enter for the %s', (_name, fixture) => {
    expect(enterOpensLiveBox(world(fixture))).toBe(false);
  });

  it('keeps Enter for the Fire key of a runner with +shoot', () => {
    expect(enterOpensLiveBox(world(runner, ['shoot']))).toBe(false);
  });
});
