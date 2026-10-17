/**
 * P45B T2: uložené světy `arcade-v2` a jejich otisk – sdílí generátor (`v2-replays.measure.ts`)
 * a zámek (`legacy-replay-v2.test.ts`).
 *
 * Zdroje: 30 vestavěných her, ukázka na úvodní stránce a 4 uložené hry zmrazené P41. Otisk je
 * `canonicalHash` světa, hash stavu po `instantiate` a výsledek `replay()` nad záznamem robota.
 */
import { readFileSync } from 'node:fs';

import { canonicalHash } from '@/ir/worlddoc';
import type { ArcadeWorld, InputEvent } from '@/play/arcade/contract';
import { hashArcade, instantiate, replay } from '@/play/arcade/kernel';
import { ARCADE_LIBRARY } from '@/play/arcade/library';

export const V2_REPLAYS_FILE = 'src/play/arcade/__tests__/__fixtures__/v2-replays.json';

export interface StoredV2World {
  readonly id: string;
  readonly world: ArcadeWorld;
  /** Záznam robota uložený se hrou (P41), jinak `null` – generátor nechá hrát `runBot`. */
  readonly inputs: string | null;
}

export interface FrozenV2 {
  readonly id: string;
  readonly worldHash: string;
  readonly initialHash: string;
  readonly inputs: string;
  readonly inputsFrom: 'stored' | 'bot';
  readonly replay: { readonly outcome: string; readonly tick: number; readonly hash: string };
}

const read = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export function storedV2Worlds(): StoredV2World[] {
  const builtin = read<{ version: { versionId: string }; arcade: ArcadeWorld }[]>('src/play/version/builtin-games.json');
  const demo = read<{ arcade: ArcadeWorld }>('src/components/play/demo-game.json');
  const stored = read<{ games: { versionId: string; game: { arcade: ArcadeWorld }; derived: { replay: { inputs: string } } }[] }>('evals/play/p41/golden/stored.json');
  return [
    ...builtin.map((game) => ({ id: `builtin:${game.version.versionId}`, world: game.arcade, inputs: null })),
    { id: 'demo', world: demo.arcade, inputs: null },
    ...stored.games.map((game) => ({ id: `p41-stored:${game.versionId}`, world: game.game.arcade, inputs: game.derived.replay.inputs })),
  ];
}

/** Otisk světa z dnešního kódu nad daným záznamem. */
export function fingerprint(world: ArcadeWorld, inputs: readonly InputEvent[]): Pick<FrozenV2, 'worldHash' | 'initialHash' | 'replay'> {
  const run = replay(world, inputs, ARCADE_LIBRARY);
  return { worldHash: canonicalHash(world), initialHash: hashArcade(instantiate(world)), replay: { outcome: run.outcome, tick: run.tick, hash: run.hash } };
}
