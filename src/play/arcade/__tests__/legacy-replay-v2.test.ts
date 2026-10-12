/**
 * P45B T2: zámek uložených her `arcade-v2` pod změnou jádra (logika, `arcade-v3`).
 *
 * Přepočítá z dnešního kódu otisk každé uložené hry – hash světa, hash po `instantiate` a
 * výsledek `replay()` zmrazeného záznamu – a porovná s `v2-replays.json`. Červená jmenuje hru
 * a první rozdílný hash: sdílená hra by se jinak přehrála jinak, než ji hráč dohrál.
 */
import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import { worldHasPhysics } from '@/play/arcade/kernel';
import { loadRapier } from '@/play/arcade/physics/world';

import { decodeInputs } from '../../../../evals/play/p41/golden/freeze';
import { type FrozenV2, V2_REPLAYS_FILE, fingerprint, storedV2Worlds } from './__fixtures__/v2-replays';

const frozen = new Map((JSON.parse(readFileSync(V2_REPLAYS_FILE, 'utf8')) as { games: FrozenV2[] }).games.map((game) => [game.id, game]));
const worlds = storedV2Worlds();

describe('stored arcade-v2 games replay exactly as frozen', () => {
  beforeAll(async () => {
    if (worlds.some(({ world }) => worldHasPhysics(world))) await loadRapier();
  });

  it('covers every stored game and nothing else', () => {
    expect(worlds.map(({ id }) => id).sort()).toEqual([...frozen.keys()].sort());
    expect(worlds).toHaveLength(35);
  });

  it.each(worlds.map(({ id, world }) => [id, world] as const))('%s', (id, world) => {
    const was = frozen.get(id)!;
    expect(world.runtimeVersion, `${id}: runtimeVersion`).toBe('arcade-v2');
    const now = fingerprint(world, decodeInputs(was.inputs));
    // Pořadí = pořadí, v jakém by se rozdíl projevil: svět → počáteční stav → přehrání.
    expect(now.worldHash, `${id}: world hash`).toBe(was.worldHash);
    expect(now.initialHash, `${id}: instantiate hash`).toBe(was.initialHash);
    expect(now.replay, `${id}: replay outcome@tick and hash`).toEqual(was.replay);
  });
});
