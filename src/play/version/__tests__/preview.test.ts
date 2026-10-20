/**
 * Skript náhledu robota (P54A T2): okno běhu, které feed přehrává na aktivní
 * kartě. Skript, který se s hrou rozejde, přehraje jiný běh, než robot hrál,
 * a vypadá přitom úplně normálně – proto se hash v `endTick` kontroluje
 * přehráním **dekódovaných** vstupů u každé fixtury.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { compileArcade, preloadPhysics } from '@/play/arcade/compile';
import type { ArcadeWorld } from '@/play/arcade/contract';
import { replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';
import { loadRapier } from '@/play/arcade/physics/world';
import { type BotRun, runBot } from '@/play/arcade/verify';
import { readGameSpec, type GameSpecV1 } from '@/play/spec';

import { decodeInputs, decodePreview, previewOf } from '../preview';

const DIR = join(process.cwd(), 'src/play/arcade/__fixtures__');
const FIXTURES = readdirSync(DIR).filter((name) => name.endsWith('.json'));

const games: { name: string; world: ArcadeWorld; bot: BotRun }[] = [];

beforeAll(async () => {
  for (const name of FIXTURES) {
    const read = readGameSpec(JSON.parse(readFileSync(join(DIR, name), 'utf8')));
    if (!read.ok) throw new Error(`${name}: fixture does not read`);
    const spec: GameSpecV1 = read.value;
    await preloadPhysics(spec, loadRapier);
    // Jako dveře publikace: první semínko, na kterém se hra dá vyhrát.
    const compiled = [1, 2, 3, 4].map((seed) => compileArcade(spec, seed)).find((result) => result.ok);
    if (compiled === undefined || !compiled.ok || compiled.value.arcade === undefined) throw new Error(`${name}: fixture does not compile on seeds 1–4`);
    const world = compiled.value.arcade;
    games.push({ name, world, bot: runBot(world) });
  }
}, 120_000);

describe('previewOf', () => {
  it('covers every top-level fixture', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(10);
    expect(games.map((game) => game.name)).toEqual(FIXTURES);
  });

  it('replaying the decoded window lands on the stored hash in endTick', () => {
    for (const { name, world, bot } of games) {
      const preview = previewOf(world, bot);
      const decoded = decodePreview(preview);
      expect(replay(world, decoded.inputs, ARCADE_LIBRARY, preview.endTick).hash, name).toBe(preview.hash);
    }
  });

  it('the window is 2–4 s long (or the whole run when shorter), starts a second before the first rule fires and stays under 8 KB', () => {
    for (const { name, world, bot } of games) {
      const preview = previewOf(world, bot);
      // Hru, kterou robot vyhraje do 2 s (aréna: tik 86), ukáže okno celé – delší běh neexistuje.
      expect(preview.endTick - preview.startTick, name).toBeGreaterThanOrEqual(Math.min(120, bot.tick));
      expect(preview.endTick - preview.startTick, name).toBeLessThanOrEqual(240);
      expect(preview.endTick, name).toBeLessThanOrEqual(bot.tick);
      const first = Math.min(...bot.firstFired.filter((tick) => tick >= 0));
      if (Number.isFinite(first) && bot.tick - 120 >= first - 60) expect(preview.startTick, name).toBe(Math.max(0, first - 60));
      expect(JSON.stringify(preview).length, name).toBeLessThanOrEqual(8 * 1024);
    }
  });

  it('keeps only inputs before endTick and folds a held input into one record', () => {
    for (const { name, world, bot } of games) {
      const preview = previewOf(world, bot);
      const decoded = decodePreview(preview).inputs;
      expect(decoded, name).toEqual(bot.inputs.filter((input) => input.tick < preview.endTick));
    }
    const held = { ...games[0]!.bot, firstFired: [], tick: 600, inputs: [...[10, 11, 12, 13].map((tick) => ({ tick, buttons: 0, axis: 500 })), { tick: 20, buttons: 1, axis: 0 }, { tick: 21, buttons: 2, axis: -7 }] };
    expect(previewOf(games[0]!.world, held).inputs).toBe('10~500x4,6~0b1,-7b2');
    expect(decodeInputs('10~500x4,6~0b1,-7b2')).toEqual(held.inputs);
    expect(decodeInputs('')).toEqual([]);
    expect(() => decodeInputs('10~x')).toThrow(/bad input record/);
  });

  it('a game whose rules never fired starts at tick 0', () => {
    const { world, bot } = games[0]!;
    const preview = previewOf(world, { ...bot, firstFired: bot.firstFired.map(() => -1) });
    expect(preview.startTick).toBe(0);
    expect(preview.endTick).toBe(Math.min(bot.tick, 240));
  });
});
