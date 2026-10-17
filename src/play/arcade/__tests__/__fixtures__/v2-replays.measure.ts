/**
 * P45B T2: generátor `v2-replays.json` – otisky uložených her `arcade-v2` z kódu PŘED změnou jádra.
 *
 *   npx vitest run --config vitest.measure.mts src/play/arcade/__tests__/__fixtures__/v2-replays.measure.ts
 *
 * Pouští se jen nad nezměněným jádrem; nový stav se nezmrazuje přepsáním čísla v testu.
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';

import { worldHasPhysics } from '@/play/arcade/kernel';
import { loadRapier } from '@/play/arcade/physics/world';
import { runBot } from '@/play/arcade/verify';

import { decodeInputs, encodeInputs } from '../../../../../evals/play/p41/golden/freeze';
import { type FrozenV2, V2_REPLAYS_FILE, fingerprint, storedV2Worlds } from './v2-replays';

it('freezes replay hashes of every stored arcade-v2 game', async () => {
  const worlds = storedV2Worlds();
  if (worlds.some(({ world }) => worldHasPhysics(world))) await loadRapier();
  const games: FrozenV2[] = worlds.map(({ id, world, inputs }) => {
    expect(world.runtimeVersion, id).toBe('arcade-v2');
    const record = inputs ?? encodeInputs(runBot(world).inputs);
    return { id, ...fingerprint(world, decodeInputs(record)), inputs: record, inputsFrom: inputs === null ? 'bot' : 'stored' };
  });
  const commit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  const about = 'P45B T2: replay hashes of stored arcade-v2 games, frozen from the kernel before logic state (arcade-v3). Regenerate only over an unchanged kernel.';
  writeFileSync(V2_REPLAYS_FILE, JSON.stringify({ about, commit, games }, null, 1) + '\n');
  expect(games).toHaveLength(35);
});
