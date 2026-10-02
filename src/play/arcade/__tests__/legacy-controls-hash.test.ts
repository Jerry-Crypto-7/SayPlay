/**
 * Uložené hry načasování, rytmu, souboje a poletování (P36A T11): kusy jádra
 * dostaly nová volitelná pole (`rise`, `ramp`, `lanes`, `rounds`) a nové
 * chování žije jen za nimi. Spec bez nich musí postavit týž svět – počáteční
 * stav, tik a hash výhry robota i hash nečinného hráče jsou změřené na
 * `638ac326` (před T11). Jinak by se sdílené hry přestaly přehrávat.
 */

import { describe, expect, it } from 'vitest';

import { readGameSpec } from '@/play/spec';

import duelFixture from '../__fixtures__/duel.json';
import flapFixture from '../__fixtures__/flap.json';
import rhythmFixture from '../__fixtures__/rhythm.json';
import timingFixture from '../__fixtures__/timing.json';
import { arcadeWorldOf } from '../compile';
import { hashArcade, instantiate, replay } from '../kernel';
import { ARCADE_LIBRARY } from '../library';
import { runBot } from '../verify';

const FIXTURES = { timing: timingFixture, rhythm: rhythmFixture, duel: duelFixture, flap: flapFixture };

/** Parametry ovládání, jak je uložila hra před T11, podle jména řádku. */
function paramsOf(name: string): Record<string, unknown> {
  const [control, a, b] = name.split('.');
  if (control === 'timing') return { mode: a, speed: b, rounds: 8 };
  if (control === 'rhythm') return { bpm: 120, density: a, beats: 48 };
  if (control === 'duel') return { difficulty: a };
  return { difficulty: a, lengthM: 120 };
}

// [hra, hash počátečního stavu, tik výhry robota, hash výhry, hash nečinného hráče] – semínko 1.
const STORED = [
  ['timing.stack.slow', '709489be', 601, '2fd01b99', 'a8e3008b'],
  ['timing.stack.normal', 'e3b09d10', 401, '42e29231', '32d76c02'],
  ['timing.stack.fast', 'e6384b2e', 265, 'f59a2276', 'f11ae01a'],
  ['timing.precision.slow', '89945868', 601, 'f774d47b', '7e4afccd'],
  ['timing.precision.normal', '415af262', 401, '32b539ef', '960533dc'],
  ['timing.precision.fast', '8d392744', 265, '7744971c', '986472c4'],
  ['timing.bridge.slow', 'a2b0e8b7', 601, 'a426f0c0', 'f6f80c22'],
  ['timing.bridge.normal', 'f206c335', 401, '0645d998', '694650d3'],
  ['timing.bridge.fast', '61ebec7b', 265, '9af27d6b', '3dc14def'],
  ['rhythm.sparse', '2468c572', 1561, '0ac2c8f6', 'd7a50547'],
  ['rhythm.normal', 'cfa981de', 1561, '0c0b70fc', '6778fc3e'],
  ['rhythm.dense', '6ba74b46', 1591, '0d7eca52', '34bc5c71'],
  ['duel.easy', '3b2d9482', 380, '89016347', '83478e02'],
  ['duel.normal', '3b2d9482', 357, '14cfe72e', 'ad36440c'],
  ['duel.hard', '3b2d9482', 346, 'bd49440b', '9d430c50'],
  ['flap.easy', '3496379f', 1214, 'a7f569ca', '4b42f803'],
  ['flap.normal', '04c74b31', 1214, 'd1675890', 'a32ce76d'],
  ['flap.hard', 'fbcd1be2', 1214, 'd7f143c7', '620d27de'],
] as const;

describe('stored timing, rhythm, duel and flap games build the world they had before P36A T11', () => {
  it.each(STORED)('%s', (name, initial, tick, won, idle) => {
    const fixture = FIXTURES[name.split('.')[0] as keyof typeof FIXTURES];
    const spec = readGameSpec({ ...fixture, controlParams: paramsOf(name) });
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    const made = arcadeWorldOf(spec.value, 1);
    if (!made.ok) throw new Error(made.issues.join('; '));
    const bot = runBot(made.world);
    expect(hashArcade(instantiate(made.world))).toBe(initial);
    expect(bot.tick).toBe(tick);
    expect(bot.hash).toBe(won);
    expect(replay(made.world, [], ARCADE_LIBRARY).hash).toBe(idle);
  });
});
